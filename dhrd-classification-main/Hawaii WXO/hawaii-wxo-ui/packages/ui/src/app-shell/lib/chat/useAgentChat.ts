import { useCallback, useMemo, useRef, useState } from 'react';
import {
  contractDefaults,
  envelopeArgs,
  type ChatRole,
  type FormValues,
  type Receipt,
  type ReviewModel,
} from '../../../form-engine';
import { getMessages, streamChat } from './api';
import type { ActiveForm, AgentCopy, LiveRegistry, LiveRegistryAgent } from './liveTypes';
import { normalizeEvent, thinkingCopyFor } from '../stream/streamNormalizer';
import { defaultCopy } from './defaults';
import { extractAttachment, extractMeta, extractSignals } from '../stream/toolMeta';
import type { AutoContinue } from '../stream/toolMeta';

export interface DisplayMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** Server-record timestamp for agent turns. The one exception to
   * never-client-stamped: the user's own outgoing turn is stamped at send
   * time (the client IS the record source for its own action); a thread
   * reload replaces it with the server created_on. */
  timestamp?: string;
  streaming?: boolean;
  /** Set when this message announced a form. */
  formTitle?: string;
  /** Raw failure text; rendered as a compact ErrorCard, never inline. */
  errorDetails?: string;
  /** Structured submission receipt; rendered as a ReceiptCard, never as text. */
  receipt?: Receipt;
  /**
   * The exact turn this message's failure card should re-send, captured when
   * the failure was recorded. Bound to THIS message rather than read from a
   * "last sent" box at click time, so the button cannot fire off whatever the
   * user happened to type afterwards, and so it is absent (and the affordance
   * hidden) when there is nothing recoverable to send.
   */
  retry?: { content: string; displayText?: string };
}

/**
 * Turn a receipt into the message that carries it. A rows-bearing receipt
 * travels as the OBJECT and renders as a card under the agent's name; a legacy
 * receipt (strings only) keeps the joined system note. Pure so the branch is
 * testable outside the stream handler; null means nothing to show.
 */
export function receiptMessage(receipt: Receipt, id: string): DisplayMessage | null {
  if (receipt.rows) {
    return { id, role: 'assistant', text: '', receipt };
  }
  const text = [receipt.title, receipt.id, ...(receipt.lines ?? []), receipt.text]
    .filter(Boolean).join('\n\n');
  return text ? { id, role: 'system', text } : null;
}

/**
 * Did this receipt record a transaction that actually happened? Only a
 * created receipt closes the flow. Guard receipts (duplicate_guard) and
 * edit_requested style receipts are mid-flow signals and say nothing about
 * the form being finished.
 */
export function isCreatedReceipt(receipt: Receipt | undefined | null): boolean {
  if (!receipt) return false;
  const r = receipt as Receipt & { created?: unknown };
  return r.created === true || r.status === 'created';
}

/**
 * Reload suppression: a thread whose newest created-receipt came AFTER the
 * newest contract-bearing message is a FINISHED flow, so reopening it must
 * restore the transcript (receipt card included) WITHOUT re-arming the form -
 * live bug 2026-08-03: switching agents and back re-rendered the review with a
 * live Assign button under the success card. Indices are message positions;
 * -1 means "never seen".
 */
export function restoredForm<T>(
  contractAt: number,
  receiptAt: number,
  form: T | null,
): T | null {
  return receiptAt > contractAt ? null : form;
}

/** Tool-invocation failures arrive as ordinary assistant text; detect them so
 * the raw kwargs dump never renders in the conversation. */
export function looksLikeToolError(text: string): boolean {
  return /Error invoking tool/i.test(text)
    || /with kwargs \{/.test(text)
    || /encountered an error.*\(Error/i.test(text)
    || /Error code: \d{3}/.test(text)
    || (/Input should be a valid string/.test(text) && /fix the error/i.test(text));
}

/**
 * THE ENVELOPE GUARD'S REFUSAL, AS THE READER MEETS IT (P2-3, wave-2 campaign).
 *
 * Every agent's system prompt carries the same rule about a `[[TKO_FORM_SUBMIT]]`
 * envelope: the named tool must be one of that agent's own, and "if it is
 * anything else, do NOT call any tool - reply exactly: 'Rejected: unknown form
 * tool.' and stop." That is a guard worth having, and it is written identically
 * in all five yamls (agent-jobchange-c.yaml, agent-otp-c.yaml,
 * agent-jobreq-c.yaml, agent-eib-c.yaml, agent-assignrec-c.yaml).
 *
 * What it is NOT is something to show somebody. When the model takes that
 * branch, the turn ends with an internal machine string as the last line of the
 * conversation - no explanation, no indication that the form action they clicked
 * never happened, and no way forward. The reader is left looking at a sentence
 * addressed to the model. Worse, it is silent about the only thing they need to
 * know: NOTHING WAS SENT. The guard fires BEFORE any tool call, so no write ever
 * started.
 *
 * Detected on the string family rather than an exact match: the model reproduces
 * the sentence with the quotes it was shown, with or without the full stop, and
 * occasionally with a lead-in. The distinguishing phrase is stable.
 */
export function looksLikeEnvelopeRefusal(text: string): boolean {
  // ANCHORED AT THE START, not a substring search. The yamls say "reply exactly",
  // so the realistic deviations are the quotes the model was shown and a trailing
  // full stop - not a lead-in. A bare `includes` would swallow a GOOD reply that
  // merely mentions the phrase (an agent explaining why it refused something) and
  // replace the whole message with an error card.
  return /^["'`\s]*rejected:\s*unknown form tool\b/i.test(text.trim());
}

/**
 * The human line and the raw detail for an assistant turn that is really a
 * failure, or null when the turn is an ordinary reply.
 *
 * ONE PLACE, so the live stream and a reloaded thread cannot disagree about
 * what counts as a failure - a raw guard string rendering as ordinary chat on
 * reload would put the defect straight back for anyone who reopens the
 * conversation. Both failure kinds carry the raw text into `errorDetails`,
 * which is what keeps it out of the message body and behind the card's
 * disclosure.
 */
export function failureCopyFor(
  text: string,
  copy: { toolError: string; envelopeRefusal: string },
  /**
   * Did this turn already produce something renderable - a form, a receipt? A
   * refusal is by definition a turn in which NOTHING happened, so a turn that
   * produced an answer is not a dead end however its closing line reads. The
   * guard string is model-emitted and nothing at the platform level stops a
   * model from calling a tool and then echoing it, so this is the mechanical
   * check behind an otherwise instruction-level assumption. Tool errors are
   * judged as before: those report a genuine failure whatever else landed.
   */
  turnProducedOutput = false,
): { text: string; errorDetails: string } | null {
  if (looksLikeToolError(text)) return { text: copy.toolError, errorDetails: text };
  if (!turnProducedOutput && looksLikeEnvelopeRefusal(text)) {
    return { text: copy.envelopeRefusal, errorDetails: text };
  }
  return null;
}

/**
 * Fill a registry copy template: `{count}` is the number, and `{s}` is the
 * plural suffix - empty for one, "s" for anything else. The templates are
 * deliberately phrased to avoid verb agreement ("3 items to fix", "1 item to
 * fix"), because a token that has to conjugate is a token nobody maintains.
 */
export function applyCountCopy(template: string, count: number): string {
  return template
    .replace(/\{count\}/g, String(count))
    .replace(/\{s\}/g, count === 1 ? '' : 's');
}

export const ENVELOPE_SENTINEL = '[[TKO_FORM_SUBMIT]]';
export const ENVELOPE_LABEL = 'Form submitted - checking the entries...';

/** Unconditional render-path masking: any user turn that starts with the
 * envelope sentinel displays as its friendly label - send, resend, or
 * history reload alike. */
export function displayText(role: ChatRole, text: string): string {
  return role === 'user' && text.startsWith(ENVELOPE_SENTINEL) ? ENVELOPE_LABEL : text;
}

/** Context-ceiling failures get a dedicated recovery path. */
export function isContextLengthError(text: string): boolean {
  return /context_length_exceeded|tokens exceed/i.test(text);
}

export interface AgentChatState {
  messages: DisplayMessage[];
  thinking: string | string[] | null;
  form: ActiveForm | null;
  formSeed: FormValues | undefined;
  /**
   * Id of the message the form block renders immediately after. Explicit
   * rather than matched on title: a form reopened from review carries no new
   * announce, and matching would snap it back above later messages.
   * null = no anchor, so the form renders at the end of the stream.
   */
  formAnchorId: string | null;
  /**
   * Monotonic counter bumped ONLY when a form appears or is replaced (a new
   * contract, a failed verdict re-arming the held form, a reopened entry form,
   * a restored thread). Re-renders while the reader types in the SAME form
   * leave it alone, which is what lets the surface anchor a form's top exactly
   * once per appearance instead of on every keystroke.
   */
  formRound: number;
  /**
   * True when THIS run has already rendered its answer (a form card) and
   * nothing renderable has started streaming since. It is the state behind
   * the indicator rule, so read it with `showsThinking`, never directly.
   *
   * Live report 2026-08-12 (EIB agent, staging): the tool result carries the
   * contract mid-stream, so the form card renders seconds before the run
   * closes - and the "Thinking..." bubble kept spinning UNDER the form for
   * that whole tail. A form on screen with a spinner below it reads as "more
   * is still coming" when the form IS the answer, so the reader waits instead
   * of filling it in.
   *
   * What the tail actually contains, from the live capture in
   * docs/fixtures/jrc-start-stream-trimmed.ndjson (events after the
   * contract-bearing run.step.delta, in order): run.step.intermediate (the
   * platform's "agent is processing" line - this is what re-lit the spinner),
   * message.delta, message.created, message.completed, run.completed. The
   * delta and the created message are the model RE-TYPING the tool's own user
   * text, which the announce bubble already rendered in the same frame as the
   * form: `announceActive` drops the deltas and `reconcileFinal` updates the
   * existing bubble in place. Nothing new is painted. The proxy relays events
   * one-for-one (server/app/routes/chat.py), so this is the whole window.
   *
   * Set: the live `form` arrival that actually renders something (a DROPPED
   * contract paints nothing, so it does not count).
   * Cleared: the start of every send (each run owns its own indicator), a
   * thread reload or new chat, and - the part that makes this a
   * content-in-flight rule rather than a form-seen rule - any renderable step
   * that begins AFTER the form in the same run: a further tool call, or a
   * text delta that actually paints a bubble (i.e. one the announce path did
   * not swallow). Verdict and receipt signals deliberately do NOT clear it:
   * they arrive in the SAME tool-response packet as the form, not after it.
   */
  answerSettled: boolean;
  threadId: string | null;
  busy: boolean;
  error: string | null;
}

/**
 * Should the thinking/loading indicator render right now?
 *
 * The invariant: the indicator means "renderable content is still in flight",
 * nothing else. Busy or thinking as always - EXCEPT once this run has already
 * painted its answer and the only thing left is the platform closing the run.
 * Pure, so the rule is pinned by tests rather than by reading a JSX condition.
 */
export function showsThinking(s: AgentChatState): boolean {
  if (s.answerSettled) return false;
  return s.busy || s.thinking !== null;
}

let localSeq = 0;
const localId = () => `local-${++localSeq}`;

/** Anchor for a form that arrived without an announce bubble: the bottom. */
const lastMessageId = (s: AgentChatState): string | null =>
  s.messages[s.messages.length - 1]?.id ?? null;

/** Opens a new form round: the form on screen is a NEW appearance, not a redraw. */
export const nextFormRound = (s: AgentChatState): number => s.formRound + 1;

/** Render-side lookup for the anchor; -1 keeps the end-of-stream fallback. */
export function formAnchorIndex(
  messages: DisplayMessage[],
  anchorId: string | null,
): number {
  if (!anchorId) return -1;
  return messages.findIndex((m) => m.id === anchorId);
}

/** Envelope bubble text per action, agent copy overriding the defaults. */
export function envelopeLabels(copy?: AgentCopy) {
  return {
    entry: copy?.envelopeEntry ?? defaultCopy.envelopeEntry,
    cancel: copy?.envelopeCancel ?? defaultCopy.envelopeCancel,
    confirm: copy?.envelopeConfirm ?? defaultCopy.envelopeConfirm,
    check: copy?.envelopeCheck ?? defaultCopy.envelopeCheck,
  };
}

/**
 * What the host needs to ask the agent "what actually happened?" after a
 * submit turn came back pending: the review's read-only check tool plus the
 * SAME args the submit carried.
 */
export interface PendingSubmit {
  checkTool: string;
  args: FormValues;
}

/**
 * Stash built when a confirm envelope goes out. The confirm token is stripped:
 * the check tool is read-only and takes no token, and a money-guarded token
 * must never travel on an automatic turn. Null when the review names no
 * checkTool - then a pending turn is left exactly as it renders today.
 */
export function pendingSubmitFrom(
  review: ReviewModel | undefined,
  args: FormValues,
): PendingSubmit | null {
  if (!review?.checkTool) return null;
  const { confirm_action: _drop, ...rest } = args;
  return { checkTool: review.checkTool, args: rest };
}

/** The envelope turn a stashed PendingSubmit produces; null = nothing to send. */
export function checkEnvelopeFor(
  pending: PendingSubmit | null,
  label: string,
): { content: string; displayText: string } | null {
  if (!pending) return null;
  return {
    content: `${ENVELOPE_SENTINEL} ${JSON.stringify(
      { tool: pending.checkTool, args: pending.args })}`,
    displayText: label,
  };
}

/**
 * One-shot dispatch of the check envelope. The stash is cleared BEFORE the
 * send, so a second `run.pending` (the check tool itself can be slow) can
 * never re-fire it: the check tool waits internally, the client never loops.
 * Returns true when something was dispatched. Pure enough to test with a
 * plain box in place of the ref.
 */
export function dispatchPendingCheck(
  box: { current: PendingSubmit | null },
  label: string,
  send: (content: string, displayText?: string) => void,
): boolean {
  const envelope = checkEnvelopeFor(box.current, label);
  if (!envelope) return false;
  box.current = null;
  send(envelope.content, envelope.displayText);
  return true;
}

/** Default pause before an auto-continued turn fires, when the tool names
 * none. Long enough that the update it follows is read as a step rather than
 * seen as a flicker. */
export const AUTO_CONTINUE_DEFAULT_MS = 1200;

/**
 * The envelope an armed AutoContinue produces; null = nothing to send.
 *
 * Identical in shape to every other envelope in this file, and deliberately
 * so: an automatic turn must be indistinguishable, on the wire and in the
 * transcript, from the one the user would have sent by clicking. The display
 * text is the ordinary confirm label, so the thread reads as a sequence of
 * continuations rather than as machinery.
 */
export function autoContinueEnvelope(
  auto: AutoContinue | null,
  label: string,
): { content: string; displayText: string; delayMs: number } | null {
  if (!auto) return null;
  return {
    content: `${ENVELOPE_SENTINEL} ${JSON.stringify(
      { tool: auto.tool, args: auto.args })}`,
    displayText: label,
    delayMs: auto.delayMs ?? AUTO_CONTINUE_DEFAULT_MS,
  };
}

/**
 * Review "go back": the held entry form returns to the BOTTOM of the stream
 * (anchored after the newest message) with NO note - the form reappearing is
 * its own signal (client 2026-08-04: drop the redundant chatter). Pure so
 * the transition stays testable.
 */
export function reopenEntryForm(
  s: AgentChatState,
  form: ActiveForm,
): AgentChatState {
  return {
    ...s,
    form,
    formRound: nextFormRound(s),
    formAnchorId: s.messages.length
      ? s.messages[s.messages.length - 1].id
      : null,
  };
}


/**
 * The open entry form's id plus the values the reader has actually typed into
 * it. Non-null ONLY while an entry form is on screen AND has been edited since
 * it opened - that is the whole dirty flag.
 */
export interface DirtyForm {
  formId: string;
  values: FormValues;
}

/**
 * What to do with a form contract that arrives from the agent.
 *
 * - `replace`: today's behavior. A new appearance: new seed, new round. Also
 *   what a contract marked `fresh` always gets, id equality or not: the tool
 *   has declared that this render means "start over" (see FormContract.fresh).
 * - `merge`: the SAME entry form re-rendered (a fix round, a redundant
 *   re-render of the flow) while the reader was typing in it. The arriving
 *   contract is taken - so server fixes, notes and warnings still show - but
 *   the typed values become the seed, so their edits win over the arriving
 *   defaults, and the round is NOT bumped: this is a redraw, not a new
 *   appearance, so the view must not re-anchor or lose the scroll position.
 * - `drop`: a REVIEW arriving on top of a dirty entry form. That is the
 *   "bounced back to review with stale values" race - the reader keeps their
 *   form and will get a fresh review when they submit it.
 *
 * Live defect 2026-08-05: clicking "Edit details" reopened the entry form from
 * browser state while the agent turn that re-renders it was still in flight;
 * whatever was typed in the first second or two was silently replaced when
 * that turn landed.
 */
export type FormArrival =
  | { action: 'replace' }
  | { action: 'merge'; seed: FormValues }
  | { action: 'drop' };

export function formArrivalFor(
  dirty: DirtyForm | null,
  arriving: ActiveForm,
): FormArrival {
  if (!dirty) return { action: 'replace' };
  if (arriving.contract.review) return { action: 'drop' };
  // A contract that DECLARES itself fresh means "start over" - it replaces even
  // when it carries the same id as the form on screen. Checked before the
  // id-equality test, which would otherwise read it as a redraw and merge the
  // abandoned attempt's values back over a deliberately blank form.
  if (arriving.contract.fresh === true) return { action: 'replace' };
  if (arriving.contract.id === dirty.formId) return { action: 'merge', seed: dirty.values };
  // A genuinely different form: the flow moved on, so it replaces as always.
  return { action: 'replace' };
}

/**
 * Does a REPLACING contract also invalidate the held `formSeed`?
 *
 * `formSeed` is what the renderer seeds a (re)mounted form with, and it is set
 * on every submit - so after any submit it holds the values of the form that
 * was submitted. Replacing the form on screen without clearing it means the
 * new contract mounts under the OLD form's values.
 *
 * LIVE DEFECT 2026-08-11 (JobChange_C campaign, persona B). Switching the
 * employee on the Change Job mega form submits the form, so the seed holds the
 * previous employee's answers; the server then sends back a form rebuilt for
 * the NEW employee. Because the contract carried a constant id, that arrival
 * merged and the old values won outright. Scoping the id to the employee makes
 * it replace - but `key={contract.id}` then REMOUNTS the renderer, which reads
 * `initialValues` afresh, so the stale seed painted the old employee's values
 * straight back onto the new form. The id fix is only half of it; this is the
 * other half.
 *
 * The seed is NOT cleared for a REVIEW arrival, and that is load-bearing: the
 * review's confirm control builds its submit envelope out of `formSeed` plus
 * the remembered entry contract (see reviewConfirm), so clearing it there
 * would break every submit in the app with "Missing form state for the
 * submit". A review is a different SURFACE for the same answers, not a
 * different set of answers.
 *
 * @param previousEntryId the id of the entry form the seed belongs to
 */
export function seedSurvives(
  previousEntryId: string | undefined,
  arriving: ActiveForm,
): boolean {
  if (arriving.contract.review) return true;
  // "Start over" clears the held seed too, whatever the id. The seed is the
  // other half of the same defect: a fresh contract that remounted under the
  // seed left after a submit painted the submitted answers back onto it.
  if (arriving.contract.fresh === true) return false;
  if (!previousEntryId) return true;
  return arriving.contract.id === previousEntryId;
}

/**
 * The same question, asked of a RELOADED thread: may the values carried by the
 * newest submit envelope in history seed the form the thread restores with?
 *
 * LIVE DEFECT 2026-08-11 (review of the JobChange_C campaign). The live stream
 * has asked this since the employee-switch fix, and `openThread` did not: it
 * took the newest envelope unconditionally, so a thread whose history is
 * "mega form for A -> switch envelope -> mega form rebuilt for B" restored the
 * rebuilt form for B seeded with A's answers - including `worker_id`, which
 * makes the very next submit look like another switch and costs a whole round.
 *
 * The comparison is the live one. The envelope's ORIGINATING form is the newest
 * entry contract that appeared before it in the transcript, and the seed only
 * survives when that is still the entry form the thread restores with. A review
 * on top of the same entry keeps the seed exactly as `seedSurvives` says, since
 * the restored review's confirm control is built from it.
 *
 * `fresh` IS DELIBERATELY IGNORED HERE, and that is the one place the two rules
 * part company. `fresh` is an ARRIVAL-time policy: it answers "a contract just
 * landed on a form the reader is working in - whose values win?". On reload
 * there is no such collision. The render already happened, the reader answered
 * that form, submitted it, and the envelope in history is the ANSWER to the
 * very contract being restored. Delegating the flag would drop the seed for the
 * commonest thread there is - `jrc_start` (fresh) -> fill -> submit -> review ->
 * reload - and that seed is what `confirmReview` builds its submit envelope
 * from, so confirming would fail with "Missing form state for the submit" and
 * "Edit details" would reopen blank. That is the 2026-07-31 reload incident,
 * and it stays fixed: on reload only the review rule and the id comparison
 * apply.
 */
export function restoredSeed(
  seed: FormValues | undefined,
  seedEntryId: string | undefined,
  entry: ActiveForm | null,
  form: ActiveForm | null,
): FormValues | undefined {
  const target = entry ?? form;
  if (!seed || !target) return seed;
  if (target.contract.review) return seed;
  if (!seedEntryId) return seed;
  return target.contract.id === seedEntryId ? seed : undefined;
}

/** Replace the turn's streamed/announce bubble with the official message IN
 * PLACE: same id (same React key - no remount, no animation replay, no
 * flicker) and same index (no reorder - the bubble never jumps below later
 * notes or the form). Messages carrying the server id are deduped; with no
 * existing bubble the message appends at the end. */
export function reconcileFinal(
  messages: DisplayMessage[],
  id: string,
  serverMessageId: string | undefined,
  reconciled: DisplayMessage,
): DisplayMessage[] {
  const deduped = messages.filter((m) => m.id === id || m.id !== serverMessageId);
  const at = deduped.findIndex((m) => m.id === id);
  return at >= 0
    ? deduped.map((m, i) => (i === at ? reconciled : m))
    : [...deduped, reconciled];
}

export function useAgentChat(
  agent: LiveRegistryAgent,
  registry: LiveRegistry,
  onThreadStarted?: (threadId: string) => void,
) {
  const [state, setState] = useState<AgentChatState>({
    messages: [], thinking: null, form: null, formSeed: undefined,
    formAnchorId: null, formRound: 0, answerSettled: false,
    threadId: null, busy: false, error: null,
  });
  // Failure wording: registry copy for this agent, brandless default otherwise.
  // Memoized so the callbacks that close over it have a stable dependency.
  const failureCopy = useMemo(() => ({
    toolError: agent.copy?.toolError ?? defaultCopy.toolError,
    envelopeRefusal: agent.copy?.envelopeRefusal ?? defaultCopy.envelopeRefusal,
  }), [agent.copy]);
  const labels = envelopeLabels(agent.copy);
  // Mutable mirrors for the stream handler (avoids stale closures).
  const threadRef = useRef<string | null>(null);
  const streamMsgId = useRef<string | null>(null);
  const toolCopyActive = useRef(false);
  // The last ENTRY form (no review model) so review "edit" can restore it
  // from browser state - no LLM relay in the path.
  const entryFormRef = useRef<ActiveForm | null>(null);
  // Last outbound turn, for one-click retry after a failure.
  const lastSendRef = useRef<{ content: string; displayText?: string } | null>(null);
  // The same verdict/receipt meta rides in run.step.delta AND message.created;
  // announce each only once per turn.
  const announcedRef = useRef<{ verdict: boolean; receipt: boolean }>({ verdict: false, receipt: false });
  // True when the current turn's assistant bubble was pre-filled with the
  // tool's own deterministic user text (shown the instant the form arrived).
  // While set, streamed text deltas are ignored — the LLM is re-typing the
  // same sentence — and message.created reconciles the bubble in place.
  const announceActive = useRef(false);
  // True once this turn rendered a receipt CARD; the model's closing line then
  // stands beside it instead of restating it (the tool returns a short line
  // when it emits a card, so no truncation is needed here).
  const receiptShown = useRef(false);
  // Set when a SUBMIT-token envelope goes out on a review that names a
  // checkTool. If that turn ends pending instead of with a receipt, this is
  // what the host asks about. Cleared on a receipt, on the dispatch itself,
  // and whenever the conversation is reset/reloaded.
  const pendingSubmitRef = useRef<PendingSubmit | null>(null);
  // Set by 'run-pending', consumed after the stream that carried it has been
  // fully read (see send) - never mid-stream.
  const dueCheckRef = useRef<{ content: string; displayText: string } | null>(null);
  // Armed by a contract carrying auto-continue meta, and consumed - exactly
  // once - after the stream that carried it has been fully read. Same
  // discipline as dueCheckRef: no timers racing the reader loop, no mid-stream
  // dispatch, and never armed from a RELOADED thread (openThread does not read
  // this key), because history is not a live flow.
  const dueAutoRef = useRef<
    { content: string; displayText: string; delayMs: number } | null>(null);
  // Self-reference so the deferred check can re-enter send without a
  // forward-declaration cycle in the callback graph.
  const sendRef = useRef<((content: string, displayText?: string) => Promise<void>) | null>(null);
  // Set the first time the reader changes a field in the open ENTRY form and
  // cleared the moment that form stops being theirs to protect (submit, form
  // replaced, thread reload, new chat). Non-null therefore means exactly "an
  // edited entry form is on screen" - see formArrivalFor.
  const dirtyRef = useRef<DirtyForm | null>(null);
  // Did THIS run already paint something renderable - a form, a receipt? Read
  // only by the envelope-refusal check: a turn that produced an answer is not a
  // dead end however its closing line reads (see failureCopyFor).
  const producedOutputRef = useRef(false);

  const patch = (p: Partial<AgentChatState> | ((s: AgentChatState) => AgentChatState)) =>
    setState((s) => (typeof p === 'function' ? p(s) : { ...s, ...p }));

  const applyNormalized = useCallback((events: ReturnType<typeof normalizeEvent>) => {
    for (const ne of events) {
      switch (ne.kind) {
        case 'run-started':
          if (ne.threadId) {
            const isNew = threadRef.current === null;
            threadRef.current = ne.threadId;
            patch({ threadId: ne.threadId });
            if (isNew && onThreadStarted) onThreadStarted(ne.threadId);
          }
          break;
        case 'tool-call': {
          toolCopyActive.current = true;
          const copy = thinkingCopyFor(ne.tool, agent.thinking, registry.tools);
          // A tool starting is renderable content in flight, whatever came
          // before it: on a run that already showed a form (not something the
          // platform does today - see answerSettled) this re-lights the
          // indicator, because the answer is genuinely no longer complete.
          patch({ thinking: copy, answerSettled: false });
          break;
        }
        case 'thinking':
          if (!toolCopyActive.current) patch({ thinking: ne.text });
          break;
        case 'text': {
          // While an announce bubble is up, streamed deltas are the LLM
          // re-typing the sentence already shown - dropping them avoids the
          // full-text -> prefix -> regrow flicker.
          if (announceActive.current) break;
          // Ids are minted OUTSIDE the updater: React StrictMode re-invokes
          // updaters, and an impure updater duplicated the bubble.
          const id = streamMsgId.current ?? localId();
          streamMsgId.current = id;
          patch((s) => ({
            // Reached only when this delta actually PAINTS a bubble (the
            // announce path returned above), so a run that already showed its
            // form is producing new content again and the indicator is honest
            // once more. In our flows the tool's text IS the announce, so this
            // does not fire after a form; it is here so the rule stays
            // "content in flight" if the platform ever changes.
            ...s, thinking: null, answerSettled: false,
            messages: [...s.messages.filter((m) => m.id !== id),
              { id, role: 'assistant', text: ne.text, streaming: true }],
          }));
          break;
        }
        case 'form': {
          // Armed here, sent at the tail of `send`. Queued even when the
          // contract itself is dropped below: the arrival is what the tool is
          // continuing from, and dropping the RENDER of a progress screen is
          // no reason to abandon a load half way through.
          dueAutoRef.current = autoContinueEnvelope(
            ne.autoContinue ?? null, labels.confirm);
          // Race guard first: a contract landing on an edited entry form must
          // never silently discard what was typed (see formArrivalFor).
          const arrival = formArrivalFor(dirtyRef.current, ne.form);
          if (arrival.action === 'drop') {
            // Nothing is shown for this contract; the model's own message for
            // the turn still arrives through text/final-message as usual.
            patch({ thinking: null });
            break;
          }
          if (arrival.action === 'merge') {
            producedOutputRef.current = true;
            entryFormRef.current = ne.form;
            // Same form id, so the renderer keeps its mounted state; the seed
            // is updated too, so a remount restores the typed values rather
            // than the arriving defaults. No formRound bump: a redraw of the
            // form already on screen is not a new appearance.
            patch((s) => ({
              ...s, form: ne.form, formSeed: arrival.seed, thinking: null,
              answerSettled: true,
            }));
            break;
          }
          producedOutputRef.current = true;
          dirtyRef.current = null;
          // Read the OUTGOING entry id before entryFormRef moves on: a replace
          // that swaps one entry form for a different one must not seed the
          // new contract with the old one's answers (see seedSurvives).
          const keepSeed = seedSurvives(entryFormRef.current?.contract.id, ne.form);
          if (!ne.form.contract.review) entryFormRef.current = ne.form;
          // Message-then-form, with zero waiting: the tool's own user text
          // arrives WITH the form, so the announce bubble renders in the same
          // frame. The model's later relay reconciles into this bubble by id
          // (final-message) instead of appending a duplicate.
          const announce = ne.announce;
          if (announce && streamMsgId.current === null) {
            const id = localId();
            streamMsgId.current = id;
            announceActive.current = true;
            patch((s) => ({
              ...s, form: ne.form, thinking: null, formAnchorId: id,
              formRound: nextFormRound(s), answerSettled: true,
              formSeed: keepSeed ? s.formSeed : undefined,
              messages: [...s.messages, {
                id, role: 'assistant', text: announce,
                formTitle: ne.form.contract.title,
              }],
            }));
          } else {
            // No announce bubble: anchor to whatever was said last.
            patch((s) => ({
              ...s, form: ne.form, formRound: nextFormRound(s),
              formSeed: keepSeed ? s.formSeed : undefined,
              formAnchorId: lastMessageId(s), answerSettled: true,
            }));
          }
          break;
        }
        case 'verdict': {
          if (announcedRef.current.verdict) break;
          announcedRef.current.verdict = true;
          const verdict = ne.verdict;
          // A failed verdict re-activates the held form (FIX annotations),
          // so it re-anchors below the verdict note - the active form always
          // lives at the bottom of the conversation.
          const verdictMsgId = localId();
          patch((s) => {
            // Verdict-only responses (tools no longer re-send the contract on
            // invalid): apply the fixes onto the form instance already held.
            let form = s.form;
            if (!verdict.ok && form && !form.contract.review) {
              form = {
                ...form,
                contract: {
                  ...form.contract,
                  annotations: { ...form.contract.annotations, fixes: verdict.fixes ?? [] },
                },
              };
              entryFormRef.current = form;
            }
            const failedCount = verdict.fixes?.length ?? 0;
            // A CLEAN VERDICT RETIRES THE FIXES, at the source. The tool has
            // just looked at these values and accepted them, so no field is
            // carrying a blocking callout any more - leaving the failed round's
            // `fixes` on the held contract is what let a red pin ride through
            // the review and reappear on "Edit details" (P2-4). fixState.ts
            // defends the same ground from the renderer's side; this removes
            // the stale data instead of compensating for it, and the two are
            // deliberately both present.
            //
            // A clean verdict still adds NO note - the review rendering is the
            // confirmation (client 2026-08-04: drop the redundant chatter). A
            // failed verdict keeps its message: it carries the fix count and
            // re-anchors the form to the bottom.
            if (verdict.ok) {
              if (form && !form.contract.review && form.contract.annotations?.fixes?.length) {
                const { fixes: _cleared, ...rest } = form.contract.annotations;
                form = { ...form, contract: { ...form.contract, annotations: rest } };
                entryFormRef.current = form;
              }
              return { ...s, form };
            }
            return {
              ...s,
              form,
              // The re-armed form is a fresh appearance at the bottom.
              formRound: nextFormRound(s),
              formAnchorId: verdictMsgId,
              messages: [...s.messages, {
                id: verdictMsgId, role: 'system',
                text: verdict.message
                  ?? (agent.copy?.verdictFailed
                    && applyCountCopy(agent.copy.verdictFailed, failedCount))
                  ?? defaultCopy.verdictFailed(failedCount),
              }],
            };
          });
          break;
        }
        case 'receipt': {
          if (announcedRef.current.receipt) break;
          announcedRef.current.receipt = true;
          // A receipt IS the answer to "did the submit land?" - nothing left
          // to check.
          pendingSubmitRef.current = null;
          producedOutputRef.current = true;
          const message = receiptMessage(ne.receipt, localId());
          if (message) {
            if (message.receipt) receiptShown.current = true;
            patch((s) => ({ ...s, messages: [...s.messages, message] }));
          }
          break;
        }
        case 'final-message': {
          const id = streamMsgId.current ?? localId();
          if (!ne.isAsync) {
            streamMsgId.current = null;
            announceActive.current = false;
          }
          patch((s) => {
            // KEEP the existing bubble's id (React key) AND its POSITION:
            // reconciling under the same identity updates the DOM node in
            // place (no remount/flicker), and replacing at the original
            // index keeps the conversation order stable - append-at-end
            // made the announce bubble visibly JUMP below the form and the
            // verdict note when the official message landed (live report
            // 2026-08-04). The server message id is still deduped.
            const failure = failureCopyFor(
              ne.text, failureCopy, producedOutputRef.current);
            const reconciled = failure
              ? {
                id,
                role: 'assistant' as const,
                text: failure.text,
                timestamp: ne.createdOn,
                errorDetails: failure.errorDetails,
                // Captured NOW, from the turn that actually failed - not read
                // from a "last sent" box when the button is clicked, which
                // would fire off whatever the user typed in the meantime.
                retry: lastSendRef.current ?? undefined,
              }
              : {
                id,
                role: 'assistant' as const,
                text: ne.text,
                timestamp: ne.createdOn,
                formTitle: s.form?.contract.title,
              };
            return {
              ...s,
              thinking: ne.isAsync ? s.thinking : null,
              messages: reconcileFinal(s.messages, id, ne.messageId, reconciled),
            };
          });
          break;
        }
        case 'run-pending':
          // The submit outlived the transport's poll window; it is still
          // running on the platform. Queue the read-only check envelope - it
          // is SENT only after this stream has been fully consumed (see the
          // tail of `send`), never mid-stream. With no stash (a non-submit
          // turn, or a review that named no checkTool) this does nothing and
          // the agent's own human-readable note stands as today.
          dispatchPendingCheck(pendingSubmitRef, labels.check, (content, display) => {
            dueCheckRef.current = { content, displayText: display ?? content };
          });
          break;
        case 'completed':
          toolCopyActive.current = false;
          patch({ busy: false, thinking: null });
          break;
        case 'failed':
          toolCopyActive.current = false;
          patch({ busy: false, thinking: null, error: ne.error });
          break;
      }
    }
  }, [agent, registry, onThreadStarted]);

  const send = useCallback(async (content: string, displayText?: string) => {
    lastSendRef.current = { content, displayText };
    announcedRef.current = { verdict: false, receipt: false };
    toolCopyActive.current = false;
    streamMsgId.current = null;
    announceActive.current = false;
    receiptShown.current = false;
    producedOutputRef.current = false;
    patch((s) => ({
      // A new run owns its own indicator: whatever form the LAST run put on
      // screen (or a thread restore left there) stops suppressing it here.
      ...s, busy: true, error: null, answerSettled: false,
      messages: [...s.messages,
        // Send-time stamp: for the user's OWN outgoing turn the client is the
        // record source; thread reload replaces it with the server created_on.
        { id: localId(), role: 'user', text: displayText ?? content,
          timestamp: new Date().toISOString() }],
    }));
    try {
      await streamChat(
        { agent_key: agent.key, content,
          ...(threadRef.current ? { thread_id: threadRef.current } : {}) },
        (ev) => applyNormalized(normalizeEvent(ev)),
      );
    } catch (e) {
      patch({ error: e instanceof Error ? e.message : 'Request failed' });
    }
    patch({ busy: false, thinking: null });
    // Timeout recovery, dispatched HERE and nowhere else: the stream that
    // carried run.pending has been read to the end (message.created + done
    // included) and this turn is no longer busy, so the automatic check turn
    // starts from a clean state. Deterministic by construction - no timers,
    // no racing with the reader loop - and one-shot: dispatchPendingCheck
    // cleared the stash when it queued this.
    const due = dueCheckRef.current;
    dueCheckRef.current = null;
    if (due) await sendRef.current?.(due.content, due.displayText);
    // Auto-continue, on the same terms and in the same place: the stream is
    // read to the end, the turn is no longer busy, and the queue is cleared
    // BEFORE the send so a re-entrant turn can never fire it twice. The next
    // chunk's own progress contract re-arms it; the final receipt carries no
    // instruction, and that is what ends the loop.
    const auto = dueAutoRef.current;
    dueAutoRef.current = null;
    if (auto) {
      if (auto.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, auto.delayMs));
      }
      await sendRef.current?.(auto.content, auto.displayText);
    }
  }, [agent.key, applyNormalized]);
  // Kept current every render so the deferred check re-enters the live send.
  sendRef.current = send;

  /** Structured submit protocol: the machine envelope, relayed verbatim.
   * Hierarchy fields collapse to their LEAF key (envelopeArgs). */
  const submitForm = useCallback((values: FormValues) => {
    const form = state.form;
    const tool = form?.submitTool;
    if (!form || !tool) {
      patch({ error: 'This form did not name a submit tool.' });
      return;
    }
    patch({ formSeed: values });
    // Submitted values are held state now, not unsaved typing: the turn this
    // starts (verdict fixes, review) is allowed to replace the form.
    dirtyRef.current = null;
    const args = envelopeArgs(form.contract, values);
    const envelope = `${ENVELOPE_SENTINEL} ${JSON.stringify({ tool, args })}`;
    void send(envelope, labels.entry);
  }, [send, state.form, labels.entry]);

  /** Review "go back": reopen the entry form from browser state (values kept). */
  const reviewEdit = useCallback(() => {
    const form = entryFormRef.current;
    if (!form) return;
    // Reopened but not yet touched: an in-flight re-render is still free to
    // replace it until the reader actually types something.
    dirtyRef.current = null;
    patch((s) => reopenEntryForm(s, form));
  }, []);

  /**
   * The open form reports every edit here (FormRenderer's onValuesChange, via
   * InlineFormBlock). Only ENTRY forms are tracked: a review panel has no
   * typing to lose. This is the dirty flag AND the store of what to preserve.
   */
  const noteFormEdit = useCallback((values: FormValues) => {
    const open = state.form;
    if (!open || open.contract.review) return;
    dirtyRef.current = { formId: open.contract.id, values };
  }, [state.form]);

  /**
   * Review confirm/cancel tokens. The submit token is money-guarded: this is
   * only ever called from an explicit user click, never automatically.
   * The confirm rides the SAME structured envelope as every form action -
   * to the REVIEW contract's submitTool, with the held entry values plus
   * confirm_action - never as free text for the model to interpret (live
   * incident 2026-07-31: a plain-text token got routed back to the verifier
   * and the review re-rendered instead of creating).
   */
  const confirmReview = useCallback((token: string) => {
    const reviewForm = state.form;
    const review = reviewForm?.contract.review;
    if (review && token === review.confirmTokens.cancel) {
      reviewEdit();
      return;
    }
    const entry = entryFormRef.current;
    const values = state.formSeed;
    const tool = reviewForm?.submitTool;
    if (!review || !entry || !values || !tool) {
      patch({ error: 'Missing form state for the submit - reopen the form and review again.' });
      return;
    }
    // THE REVIEW'S OWN CARRIED CONSTANTS WIN. The confirm envelope is built
    // from the ENTRY contract's held values, which is right for the answers the
    // reader gave - but a review contract can carry fields of its own that were
    // never on the entry form, and a `review` renders only its ReviewPanel, so
    // those fields have no rendered state and their defaults are the only
    // values they will ever have.
    //
    // Without this, a hidden constant that lives ONLY on the review screen
    // never reaches the writer at all. Live consequence (found in review
    // 2026-08-12): EIB's review carries the workbook's `stage_token`, and on a
    // workbook that passes first time the entry form is the upload screen,
    // which carries no token - so confirming the load sent `{workbook,
    // confirm_action}`, the writer answered "that workbook is no longer held on
    // the server, upload it again", and the only clean-workbook path through
    // the UI was an unbreakable loop. It was invisible because every test and
    // demo workbook goes through a fix round first, after which the entry form
    // IS the fix form and does carry the token.
    //
    // Safe for every other contract by construction: a review with no sections
    // contributes nothing, which is what all four sibling agents emit.
    const carried = envelopeArgs(reviewForm.contract,
      contractDefaults(reviewForm.contract));
    const args = {
      ...envelopeArgs(entry.contract, values), ...carried, confirm_action: token,
    };
    const envelope = `${ENVELOPE_SENTINEL} ${JSON.stringify({ tool, args })}`;
    // Only the SUBMIT-token envelope arms timeout recovery (the cancel token
    // returned above). The stash drops confirm_action: the check tool is
    // read-only and takes no token.
    pendingSubmitRef.current = pendingSubmitFrom(review, args);
    void send(envelope, labels.confirm);
  }, [send, state.form, state.formSeed, reviewEdit, labels.confirm]);

  /** Re-send the last turn (used by the failure card's Retry). */
  const retry = useCallback(() => {
    const last = lastSendRef.current;
    if (last) void send(last.content, last.displayText);
  }, [send]);

  const openThread = useCallback(async (threadId: string) => {
    threadRef.current = threadId;
    // A RETRY MUST NEVER CROSS A THREAD. `lastSendRef` is what the failure
    // card's retry re-sends, and leaving it set here meant a retry taken after
    // switching threads would replay the PREVIOUS conversation's turn - a
    // confirm envelope among them - into this one.
    lastSendRef.current = null;
    // A reloaded thread is history, not a live submit: never auto-check.
    pendingSubmitRef.current = null;
    dueCheckRef.current = null;
    // A queued continuation belongs to the flow being left behind.
    dueAutoRef.current = null;
    // Whatever was open belongs to the thread being left.
    dirtyRef.current = null;
    patch((s) => ({ ...s, threadId, busy: true, error: null, messages: [], form: null,
      formSeed: undefined, formAnchorId: null, answerSettled: false }));
    try {
      const slim = await getMessages(threadId);
      let form: ActiveForm | null = null;
      let entry: ActiveForm | null = null;
      let seed: FormValues | undefined;
      // The entry contract the seed was typed on - the transcript's answer to
      // "which form did this envelope come from" (see restoredSeed).
      let seedEntryId: string | undefined;
      /** Newest envelope turn seen so far - what a refusal below it refused. */
      let lastEnvelope: string | undefined;
      const messages: DisplayMessage[] = [];
      // Order tracking for the finished-flow check (see restoredForm).
      let contractAt = -1;
      let receiptAt = -1;
      let at = -1;
      for (const m of slim) {
        at += 1;
        const restored = extractMeta(m.meta);
        // Any attachment on this message belongs to the form on this message.
        const attachment = restored ? extractAttachment(m.meta) : undefined;
        const found = restored && attachment ? { ...restored, attachment } : restored;
        if (found) { form = found; contractAt = at; } // newest wins
        if (found && !found.contract.review) entry = found; // newest ENTRY wins
        // Reload parity for receipts: a rows-bearing receipt in history
        // renders as the same card the live stream showed.
        const { receipt: histReceipt } = extractSignals(m.meta ?? {});
        // A created receipt closes the flow whether or not it renders a card.
        if (isCreatedReceipt(histReceipt)) receiptAt = at;
        if (histReceipt && histReceipt.rows) {
          const rm = receiptMessage(histReceipt, `${m.id}-receipt`);
          if (rm) messages.push({ ...rm, timestamp: m.created_on });
        }
        // Restore held values from the newest envelope turn: the thread is
        // the source of truth for what was last submitted, so a reloaded
        // review can still confirm (live incident 2026-07-31: reload lost
        // browser state and the money-guarded confirm refused).
        if (m.role === 'user' && m.text?.startsWith(ENVELOPE_SENTINEL)) {
          lastEnvelope = m.text;
          try {
            const parsed = JSON.parse(m.text.slice(ENVELOPE_SENTINEL.length).trim());
            if (parsed && typeof parsed === 'object' && parsed.args) {
              const { confirm_action: _drop, ...rest } = parsed.args;
              seed = rest as FormValues;
              seedEntryId = entry?.contract.id;
            }
          } catch { /* not a well-formed envelope; ignore */ }
        }
        if (m.text) {
          // Same masking/error handling as the live stream path - including the
          // envelope-guard refusal, which must not read as ordinary chat just
          // because the conversation was reopened.
          // A restored refusal is judged on what the SAME message carried: a
          // turn whose message brought a contract or a receipt produced an
          // answer and is not a dead end.
          const failure = m.role === 'assistant'
            ? failureCopyFor(m.text, failureCopy, Boolean(found) || Boolean(histReceipt))
            : null;
          messages.push({
            id: m.id, role: m.role,
            text: failure ? failure.text : displayText(m.role, m.text),
            errorDetails: failure?.errorDetails,
            // The transcript IS the record of what to re-send: the envelope turn
            // immediately before the refusal is the one that was refused. Without
            // this the restored card offers a button that does nothing at all.
            retry: failure && lastEnvelope
              ? { content: lastEnvelope, displayText: ENVELOPE_LABEL }
              : undefined,
            timestamp: m.created_on,
            formTitle: found ? found.contract.title : undefined,
          });
        }
      }
      // entryFormRef stays populated even for a finished flow: it is inert
      // without an active form and keeps a future "edit again" path possible.
      if (entry) entryFormRef.current = entry;
      else if (form && !form.contract.review) entryFormRef.current = form;
      // Restored threads carry no anchor: the form renders at the end. A
      // finished flow restores with NO form at all.
      patch((s) => ({ ...s, messages, form: restoredForm(contractAt, receiptAt, form),
        formSeed: restoredSeed(seed, seedEntryId, entry, form),
        formAnchorId: null, formRound: nextFormRound(s), busy: false,
        // A form restored from history is not this run's answer: it must never
        // mask the indicator of the next live turn, and it is not a pre-run
        // form either - it belongs to a thread that already has turns in it.
        answerSettled: false }));
    } catch (e) {
      patch({ busy: false, error: e instanceof Error ? e.message : 'Could not load thread' });
    }
  }, [failureCopy]);

  /** Context-ceiling recovery: new thread, same form and values. */
  const freshChatWithForm = useCallback(() => {
    const keepForm = entryFormRef.current;
    // Unsaved typing is the most valuable thing to carry across, so it beats
    // the last submitted values as the seed.
    const typed = dirtyRef.current?.values;
    threadRef.current = null;
    // A RETRY MUST NEVER CROSS A THREAD. `lastSendRef` is what the failure
    // card's retry re-sends, and leaving it set here meant a retry taken after
    // switching threads would replay the PREVIOUS conversation's turn - a
    // confirm envelope among them - into this one.
    lastSendRef.current = null;
    streamMsgId.current = null;
    announceActive.current = false;
    receiptShown.current = false;
    pendingSubmitRef.current = null;
    dueCheckRef.current = null;
    // A queued continuation belongs to the flow being left behind.
    dueAutoRef.current = null;
    patch((s) => ({
      messages: [], thinking: null,
      form: keepForm, formSeed: typed ?? s.formSeed, formAnchorId: null,
      formRound: nextFormRound(s), answerSettled: false,
      threadId: null, busy: false, error: null,
    }));
  }, []);


  const newChat = useCallback(() => {
    threadRef.current = null;
    // A RETRY MUST NEVER CROSS A THREAD. `lastSendRef` is what the failure
    // card's retry re-sends, and leaving it set here meant a retry taken after
    // switching threads would replay the PREVIOUS conversation's turn - a
    // confirm envelope among them - into this one.
    lastSendRef.current = null;
    streamMsgId.current = null;
    announceActive.current = false;
    receiptShown.current = false;
    pendingSubmitRef.current = null;
    dueCheckRef.current = null;
    // A queued continuation belongs to the flow being left behind.
    dueAutoRef.current = null;
    dirtyRef.current = null;
    patch((s) => ({ ...s, messages: [], thinking: null, form: null, formSeed: undefined,
      formAnchorId: null, answerSettled: false,
      threadId: null, busy: false, error: null }));
  }, []);

  return { state, send, submitForm, reviewEdit, confirmReview, openThread, newChat, retry,
    freshChatWithForm, noteFormEdit };
}
