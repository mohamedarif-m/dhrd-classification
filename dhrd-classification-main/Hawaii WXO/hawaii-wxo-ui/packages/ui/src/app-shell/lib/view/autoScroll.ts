/**
 * Chat auto-scroll policy, kept pure so it is testable without a DOM.
 *
 * The rule: new content pulls the view to the bottom ONLY when the reader was
 * already there, or when the growth is the reader's own outgoing turn (they
 * pressed send, so they want to see it land). Someone who scrolled up to read
 * history is never yanked back down.
 *
 * Forms are the exception to "bottom": when one appears, the view anchors to
 * its TOP (see `scrollTarget`), because a form taller than the viewport is
 * useless if you land on its last field.
 */

/** How far above the bottom still counts as "at the bottom", in CSS pixels. */
export const NEAR_BOTTOM_SLACK = 120;

/** The three scroll metrics this policy needs; any element satisfies it. */
export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** True when the viewport sits within `slack` px of the bottom of the content. */
export function isNearBottom(el: ScrollMetrics, slack = NEAR_BOTTOM_SLACK): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - slack;
}

/**
 * Should this content change scroll the conversation to the bottom?
 * `lastMessageRole` is the role of the LAST message in the stream: a user turn
 * means the change was caused by the reader's own send, which always wins over
 * a stale near-bottom reading.
 */
export function shouldAutoScroll(
  nearBottom: boolean,
  lastMessageRole?: string | null,
): boolean {
  return nearBottom || lastMessageRole === 'user';
}

/** Motion preference honoured: 'auto' (instant) when reduced motion is set. */
export function scrollBehaviorFor(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? 'auto' : 'smooth';
}

/** Reads the media query defensively - SSR and jsdom may have no matchMedia. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Bottom-scrolls an element, falling back to scrollTop where scrollTo is absent. */
export function scrollToBottom(el: HTMLElement, behavior: ScrollBehavior): void {
  if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior });
  else el.scrollTop = el.scrollHeight;
}

/** Breathing room left above a form once its top is parked in the viewport. */
export const FORM_TOP_PAD = 12;

/** Where a content change should move the view, or null to leave it alone. */
export type ScrollTarget = 'bottom' | 'form-top' | null;

/** What the policy needs to know about the current render. */
export interface ScrollDecisionInput {
  /** Was the reader already at the bottom before this change? */
  nearBottom: boolean;
  /** Role of the LAST message in the stream. */
  lastMessageRole?: string | null;
  /** Is a form on screen right now? */
  hasForm: boolean;
  /** Monotonic counter: bumps only when a form APPEARS or is REPLACED. */
  formRound: number;
  /** The round this surface has already reacted to. */
  seenFormRound: number;
  /** Contract id of the form on screen right now. */
  formId?: string | null;
  /** Contract id of the form the LAST consumed round belonged to. */
  anchoredFormId?: string | null;
}

/**
 * The one scroll decision.
 *
 * A form that just APPEARED is anchored by its TOP: forms run taller than the
 * viewport, and the reader needs the header, not the submit button. Everything
 * else - turns, thinking, streamed text - still follows the bottom, and only
 * when the reader was already there or the growth is their own send. A
 * re-render of the SAME form is not a new round, so typing in a form never
 * re-anchors it.
 *
 * A CONTRACT THAT REPLACES ITS PREDECESSOR UNDER THE SAME FORM ID IS A REDRAW,
 * NOT AN APPEARANCE, and that distinction is the EIB fix-round scroll defect.
 * A fix round bumps the round counter - the contract really is a new object,
 * re-anchored below a new verdict message - so the old rule read it as a form
 * appearing and drove the scroller to the form's top. On EIB that form is the
 * whole transaction matrix and its top sits at the very beginning of the
 * transcript, so "anchor the form" and "jump to the top of the chat" are the
 * same pixel. Measured on staging 2026-08-13, three re-renders out of three:
 * scrollTop 7360 -> 0, 6106 -> 0, 6345 -> 1245, with the form top landing at
 * 487 / 702 / -399 px each time. The reader was editing transaction 16 and got
 * sent back to transaction 1.
 *
 * THIS RULE ALONE DID NOT FIX IT. Measured again on staging-v16 with the rule
 * live: 7360 -> 0, 6106 -> 65, 6371 -> 12068. The third pair is the one that
 * explains the other two - 12068 was the exact BOTTOM of the transcript, so the
 * scroller was not being anchored to anything, it was FOLLOWING THE BOTTOM
 * while the form was temporarily out of the DOM. See `scrollHoldAction`, which
 * is the fix for that; this rule remains necessary and is not sufficient.
 *
 * The same form coming back with fixes on it is the form the reader is already
 * looking at. It keeps their position, exactly as typing in it does. A form
 * with a DIFFERENT id is a different screen and still anchors.
 *
 * `formId`/`anchoredFormId` are optional: a caller that passes neither gets the
 * old "every new round anchors" behaviour unchanged.
 */
export function scrollTarget(input: ScrollDecisionInput): ScrollTarget {
  const {
    nearBottom, lastMessageRole, hasForm, formRound, seenFormRound,
    formId, anchoredFormId,
  } = input;
  if (!shouldAutoScroll(nearBottom, lastMessageRole)) return null;
  const redraw = formId != null && formId === anchoredFormId;
  if (hasForm && formRound !== seenFormRound && !redraw) return 'form-top';
  return 'bottom';
}

/**
 * SCROLL ANCHORING across a same-id contract replacement: where to put the
 * scroller back, or null to leave it where it is.
 *
 * The policy above stops the engine from MOVING the view on a redraw. This
 * covers the other way a redraw loses the reader's place: React swaps the old
 * form's DOM out for the new one's, the content is briefly shorter, and the
 * browser CLAMPS scrollTop to whatever the shrunken content can hold. Nothing
 * scrolled - the position was simply destroyed - so no scroll policy can undo
 * it after the fact. Restoring it in a layout effect, before paint, can.
 *
 * IT CORRECTS IN BOTH DIRECTIONS, and that is a correction to this function's
 * first version, which only ever restored a reader who had been moved UP. The
 * reasoning was that a clamp can only move someone up, and it is wrong: the
 * BROWSER'S OWN scroll anchoring moves them DOWN. When ~12000px of form is
 * re-inserted above the anchored element, Chrome shifts scrollTop by that much
 * to keep the anchor still - measured on the third fix round, scrollTop went
 * 209 -> 12068 with no script involved, landing on the exact bottom, and the
 * one-directional restore declined to touch it because 12068 was "already past"
 * the 6293 being restored. A hold knows where the reader was; putting them back
 * is the whole job, whichever way the view drifted.
 *
 * `slack` still guards against chasing a one-pixel reflow.
 */
export const SCROLL_RESTORE_SLACK = 24;

export function restoreScrollTop(
  recorded: number, current: number, maxTop: number, slack = SCROLL_RESTORE_SLACK,
): number | null {
  if (recorded <= 0 || maxTop <= 0) return null;
  const target = Math.max(0, Math.min(recorded, maxTop));
  return Math.abs(target - current) > slack ? target : null;
}

/**
 * WHAT THE HOLD REMEMBERS. Not a pixel offset - a pixel offset and the thing it
 * was measured against.
 *
 * `top` is where the scroller was; `formTop` is where the form block's top edge
 * was in the SAME scroller coordinates at the same instant. The difference
 * between them is the only durable fact in the pair: how far INTO the form the
 * reader had read. A fix round can move the form's top (the verdict message
 * that announces the round renders above it) and can change the form's height
 * (fixed rows leave), so `top` on its own describes a screen that no longer
 * exists; `top - formTop` describes the reader.
 *
 * `formTop` is -1 when it could not be measured, and the arithmetic below then
 * falls back to the recorded absolute offset - the pre-1.21.1 behaviour.
 */
export interface HeldScroll {
  top: number;
  formId: string;
  formTop: number;
}

/**
 * Offset of `el`'s top edge within `container`'s scroll coordinates, or -1 when
 * `el` has no layout box at all. That case is not hypothetical: the form anchor
 * is `display: none` while it is empty, and a zero rect read from it would come
 * back as a plausible-looking number rather than an obvious absence.
 */
export function scrollOffsetOf(container: HTMLElement, el: HTMLElement): number {
  if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return -1;
  return container.scrollTop
    + (el.getBoundingClientRect().top - container.getBoundingClientRect().top);
}

/**
 * The offset that puts the reader back the same distance INTO the form as they
 * were, given where the form's top sits now. Unclamped on purpose: the caller
 * compares it against the current maximum to decide whether the replacement has
 * finished laying out, and `restoreScrollTop` does the clamping.
 */
export function anchoredScrollTop(held: HeldScroll, currentFormTop: number): number {
  if (held.formTop < 0 || currentFormTop < 0) return held.top;
  return Math.max(0, currentFormTop + (held.top - held.formTop));
}

/**
 * THE SCROLL HOLD - what actually fixes the EIB fix-round jump.
 *
 * WHAT THE FIRST FIX MISSED. `scrollTarget`'s redraw rule stops the view being
 * re-anchored to a returning form's top, and that was necessary but not the
 * cause. The measured trace on staging-v16, with that rule live, was
 * 7360 -> 0, 6106 -> 65, 6371 -> 12068 - and 12068 was the exact BOTTOM of the
 * transcript. A scroller that lands on 0 twice and on the bottom once is not
 * being anchored to anything; it is FOLLOWING THE BOTTOM of a transcript that
 * is temporarily far shorter than it is about to be.
 *
 * WHY IT GETS SHORT. Submitting a form collapses it (`onView('collapsed')`)
 * and the turn sets `busy`, and a collapsed form block during a turn renders
 * NOTHING at all - deliberately, so a resume affordance does not sit there
 * mid-turn. On EIB that removes the whole ~11000px transaction matrix from the
 * DOM in one commit. The submit also appends the reader's OWN outgoing turn,
 * and "follow the reader's own send" is unconditional by design, so the
 * scroller dutifully goes to the bottom of what is left. Whether that reads as
 * 0 or as 12068 is just how much transcript happened to remain: either way the
 * reader's place is gone before the replacement form paints.
 *
 * THE HOLD. While the form block is out of the DOM mid-turn, the transcript is
 * not in a state worth scrolling to, so the view is left alone and the reader's
 * offset is remembered. When the SAME form comes back and the content is tall
 * enough to hold it again, the offset is restored before paint. A DIFFERENT
 * form is a different screen: the hold is dropped and the normal anchor rule
 * takes over. A turn that ends without the form returning drops it too, so the
 * hold can never outlive the round that armed it.
 *
 * ONE ACCEPTED IMPRECISION. If the reader deliberately scrolls during the
 * second or two the form is absent, the restore overrides them. There is no way
 * to tell a user scroll from the browser's own clamp, the composer is disabled
 * for the whole window, and there is nothing below to read; losing the reader's
 * place three times out of three is the worse failure by a wide margin.
 *
 * THE SHRINKING RE-RENDER - the residual this hold used to hand back (1.21.1).
 *
 * The height test was ALL OR NOTHING: a replacement that could not hold the
 * recorded offset ended the turn on `drop`, and dropping does not put the
 * reader back anywhere - it leaves them at whatever the collapse-era clamp made
 * of their position, which is a few dozen pixels from the top. That is the
 * ORDINARY outcome of an EIB fix round, not an exotic one: a round that fixes
 * rows REMOVES those transaction blocks from the next fix form, so the form
 * that comes back is genuinely shorter than the one that left. One repaired
 * block is enough to put the new maximum below the recorded offset, and the
 * whole hold was then discarded over a difference of a few hundred pixels,
 * throwing away the ~6000px of it that was perfectly recoverable.
 *
 * So a shrunken return is a RESTORE, best effort, not a drop. The turn is over,
 * the form is back, it is the same form under the same id - it is the reader's
 * screen, and the nearest position the new content can hold is enormously
 * closer to where they were than the top of the transcript is. `contentCanHold`
 * keeps its real job, which is deciding whether to restore NOW or wait for the
 * replacement to finish laying out; it no longer decides whether the reader
 * gets their place back at all.
 */
export type HoldAction = 'arm' | 'restore' | 'wait' | 'drop' | 'none';

export interface HoldInput {
  /** Was the form block in the DOM on the previous render? */
  wasShown: boolean;
  /** Is it in the DOM now? */
  isShown: boolean;
  /** Contract id of the form the shell is holding, null when there is none. */
  formId: string | null;
  /** The id the armed hold belongs to, or null when nothing is held. */
  heldFormId: string | null;
  /** Is a turn still running? */
  busy: boolean;
  /** Can the transcript, as it stands now, hold the recorded offset? */
  contentCanHold: boolean;
}

/**
 * THE READER'S OWN SEND IS A MOMENT, NOT A MODE.
 *
 * `shouldAutoScroll` follows the bottom unconditionally when the last message
 * is the reader's own turn - they pressed send, so they want to see it land.
 * That is right at the instant of sending and wrong for every commit
 * afterwards, and a form submit produces MANY: the envelope goes out as a user
 * message and stays the last message for the whole turn, so every re-render
 * until the agent replies re-reads it as "they just sent something" and drags
 * the view back to the bottom.
 *
 * That is the third and last mechanism behind the EIB fix-round jump. Measured
 * with the hold live but this rule missing: round 2 held its position exactly
 * (6106 -> 6106) while rounds 1 and 3 still moved, and round 3 landed on 12068
 * of 12068 - the precise bottom, long after the send.
 *
 * So the licence is spent once. Pass the id of the last message and the id of
 * the last user message already followed; the role comes back as `user` only
 * while that send is genuinely new. Callers that pass no ids are unaffected.
 */
export function effectiveLastRole(
  lastRole?: string | null, lastId?: string | null, followedUserId?: string | null,
): string | null | undefined {
  if (lastRole !== 'user') return lastRole;
  if (lastId == null) return lastRole;
  return lastId === followedUserId ? 'assistant' : 'user';
}

export function scrollHoldAction(i: HoldInput): HoldAction {
  // The form block is LEAVING the DOM mid-flight: record the reader's place
  // before the content shrinks under them. Only ever ONCE per hold - a second
  // arm would overwrite the good pre-collapse offset with the clamped one,
  // which is precisely the value the hold exists to discard.
  if (!i.heldFormId && i.wasShown && !i.isShown && i.formId) return 'arm';
  if (!i.heldFormId) return 'none';
  // A different form is a different screen - but only once the turn has
  // SETTLED on it. Mid-turn a tool can put an interstitial on screen and take
  // it away again: EIB shows a progress contract ("eib-progress") while it
  // repairs rows, then comes back to the same fix form. Dropping the hold on
  // sight of it is why the one round that repaired anything still jumped -
  // measured 7360 -> 0 on the round with `repaired=3` while the rounds with
  // `repaired=0` held their position exactly. A waypoint is not a destination.
  if (!i.formId || i.formId !== i.heldFormId) return i.busy ? 'wait' : 'drop';
  if (i.isShown && i.contentCanHold) return 'restore';
  // Still mid-turn, or the replacement has not painted tall enough yet.
  if (i.busy || !i.isShown) return 'wait';
  // The turn is over, the form is back under the same id, and the content is
  // still too short to hold the old offset: the form came back SMALLER, which
  // is what a fix round that actually fixed something looks like. Restore as
  // far as the new content reaches - see the shrinking-re-render note above.
  return 'restore';
}

/**
 * THE ANSWER NOBODY SEES (wave-2 campaign, promoted UX item).
 *
 * A form is anchored into the transcript after the message that announced it,
 * so anything the agent says AFTERWARDS renders BELOW the form. On this product
 * the forms run 2000px and up - the Job Change mega form and the EIB matrix are
 * the whole viewport several times over - and the agent's answers to questions
 * asked mid-form (`jcc_answer` and its siblings) land underneath all of it. The
 * reader asks something, the reply arrives, and the screen in front of them
 * does not change in any way.
 *
 * AN AFFORDANCE, NOT AN AUTO-SCROLL, and that is a deliberate choice against
 * the other option on the table (auto-reveal when the reply is short). Every
 * other rule in this file exists to stop the view moving under a reader who did
 * not ask for it - the hold, the spent-once send licence, the redraw rule - all
 * of them written after a live defect where the page moved on its own. Moving
 * the viewport while someone is typing into a form is the same defect wearing a
 * friendlier hat, and "the reply was short" is not a property that makes it
 * safe; it is a property of the message, not of what the reader is doing. So
 * the reply announces itself and waits. One tap goes to it, and the reader who
 * is mid-sentence is not interrupted at all.
 *
 * Returns the id of the message to point at, or null for "say nothing":
 *
 *   - no form on screen, or the form is at the END of the stream: nothing is
 *     hidden underneath it, so the ordinary bottom-follow already covers it;
 *   - the reader is already near the bottom: they can see it;
 *   - the turn is still running: the thinking indicator is the signal, and a
 *     half-streamed bubble is not yet a reply;
 *   - the last message is the reader's own: they know what they just sent.
 */
export interface ReplyBelowInput {
  /** Is the form block itself in the DOM (not collapsed, not absent)? */
  formShown: boolean;
  /** Index the form renders after; -1 means end-of-stream (nothing below). */
  formAnchorIndex: number;
  /** Index of the last message in the stream. */
  lastIndex: number;
  lastRole?: string | null;
  lastId?: string | null;
  /** Turn in flight, or this bubble still streaming. */
  streaming: boolean;
  nearBottom: boolean;
}

export function replyBelowFormId(i: ReplyBelowInput): string | null {
  if (!i.formShown || i.nearBottom || i.streaming) return null;
  if (i.lastRole !== 'assistant' && i.lastRole !== 'system') return null;
  if (i.formAnchorIndex < 0 || i.lastIndex <= i.formAnchorIndex) return null;
  return i.lastId ?? null;
}

/**
 * Scroll offset that parks `formTop` (viewport coords) `pad` px below the top
 * of a container whose own top is `containerTop` and which currently sits at
 * `scrollTop`. Kept pure - the DOM math is one line, the arithmetic is testable.
 */
export function formTopScrollOffset(
  scrollTop: number,
  containerTop: number,
  formTop: number,
  pad = FORM_TOP_PAD,
): number {
  return Math.max(0, scrollTop + (formTop - containerTop) - pad);
}

/**
 * Brings the top of `form` to the top of `container`. Rect math rather than
 * offsetTop: the form block is not guaranteed to be positioned against the
 * scroll container, and rects are correct whatever the offsetParent chain is.
 */
export function scrollFormTopIntoView(
  container: HTMLElement,
  form: HTMLElement,
  behavior: ScrollBehavior,
  pad = FORM_TOP_PAD,
): void {
  const top = formTopScrollOffset(
    container.scrollTop,
    container.getBoundingClientRect().top,
    form.getBoundingClientRect().top,
    pad,
  );
  if (typeof container.scrollTo === 'function') container.scrollTo({ top, behavior });
  else container.scrollTop = top;
}
