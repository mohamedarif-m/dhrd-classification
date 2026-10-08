import {
  Fragment, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import {
  ChatMessage,
  ChatStream,
  ErrorCard,
  FormEngineTheme,
  ReceiptCard,
  ThinkingState,
  type ThemeOverride,
} from '../../form-engine';
import { fetchOptions, listThreads, renameThread, uploadFile } from '../lib/chat/api';
import {
  SCROLL_RESTORE_SLACK,
  anchoredScrollTop,
  isNearBottom,
  prefersReducedMotion,
  effectiveLastRole,
  replyBelowFormId,
  restoreScrollTop,
  scrollBehaviorFor,
  scrollFormTopIntoView,
  scrollHoldAction,
  scrollOffsetOf,
  scrollTarget,
  scrollToBottom,
  type HeldScroll,
} from '../lib/view/autoScroll';
import { createThreadRefreshRetry } from '../lib/chat/threadRefresh';
import { derivedThreadTitle, isStubThreadTitle } from '../lib/view/threadTitle';
import type { LiveRegistry, LiveRegistryAgent, ThreadRow } from '../lib/chat/liveTypes';
import {
  displayText,
  formAnchorIndex,
  isContextLengthError,
  looksLikeEnvelopeRefusal,
  showsThinking,
  useAgentChat,
  type DisplayMessage,
} from '../lib/chat/useAgentChat';
import { ChatInput } from './ChatInput';
import { NewChatIcon } from './icons';
import { InlineFormBlock, type FormView } from './InlineFormBlock';
import { ThreadList } from './ThreadList';

/**
 * How long after a programmatic scroll the scroller's own position is treated as
 * "still settling" rather than as the reader moving. Comfortably longer than a
 * smooth scroll; see onChatScroll.
 */
const AUTO_SCROLL_SETTLE_MS = 800;

/** Thread timestamps ride the wire as epoch seconds; the formatters take ISO. */
const isoOf = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toISOString();

/** One agent's chat surface: sidebar (workspace view), stream, inline form, input. */
export function AgentSurface({
  agent, registry, focus, onSelectAgent, onReset, formTokensFor, workspaceAside, initialMessage,
}: {
  workspaceAside?: ReactNode;
  /** Sent once on a newly mounted conversation. */
  initialMessage?: string;
  agent: LiveRegistryAgent;
  registry: LiveRegistry;
  focus: boolean;
  onSelectAgent: (key: string) => void;
  onReset: () => void;
  /** Host's form-engine tokens for the configured brand accent. The package
   * itself stays brandless: without this the engine's own defaults apply. */
  formTokensFor?: (accent?: string | null) => ThemeOverride;
}) {
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  // Belt to the server's braces: a listing triggered by a thread the reader
  // just started, that came back WITHOUT that thread, gets asked once more.
  // See lib/chat/threadRefresh - the server holds run.started until the row is
  // shared, and this covers the case where that wait timed out.
  const refreshRef = useRef<(threadId?: string) => void>(() => {});
  const landRetry = useMemo(
    () => createThreadRefreshRetry((threadId) => refreshRef.current(threadId)),
    // Recreated per agent so a switch starts with no pending retry.
    [agent.key],
  );
  useEffect(() => () => landRetry.cancel(), [landRetry]);
  const refreshThreads = useCallback((startedThreadId?: string) => {
    listThreads(agent.key)
      .then((rows) => {
        setThreads(rows);
        landRetry.consider(rows, startedThreadId);
      })
      .catch(() => setThreads([]));
  }, [agent.key, landRetry]);
  refreshRef.current = refreshThreads;
  useEffect(() => { refreshThreads(); }, [refreshThreads]);

  const { state, send, submitForm, confirmReview, openThread, newChat, retry,
    freshChatWithForm, noteFormEdit } = useAgentChat(agent, registry, refreshThreads);
  const initialSent = useRef(false);
  useEffect(() => {
    if (initialMessage && !initialSent.current) {
      initialSent.current = true;
      void send(initialMessage);
    }
  }, [initialMessage, send]);

  // Full option sets for fields whose contract names an out-of-band source.
  // `opts` carries the engine's cache bust through to the proxy: a payload the
  // engine refused for not matching the contract's columns is refetched with
  // refresh=1 rather than re-read from the warmed copy.
  const optionsProvider = useCallback(
    (source: string, opts?: { refresh?: boolean }) => fetchOptions(agent.key, source, opts),
    [agent.key]);
  const [formView, setFormView] = useState<FormView>('inline');
  useEffect(() => {
    if (state.form) setFormView('inline');
  }, [state.form]);

  // ---- what a page reload does --------------------------------------------
  // REFRESH = CLEAN START ON THE SAME AGENT (product decision 2026-08-12).
  // The agent is remembered (see lib/view/lastSession) so a reload lands on
  // the surface the reader was using; the CONVERSATION is not reopened. The
  // empty surface then does what any empty surface does - shows the instant
  // entry form - and the previous chat stays in the sidebar, one click away.
  //
  // This deliberately replaces the older auto-resume, which reopened the last
  // thread on mount. Resuming made refresh the one gesture that could NOT get
  // you back to a clean form, and readers reach for refresh precisely when
  // they want to start over. Nothing is lost: the thread is still listed,
  // still owned by the same anon identity, and still one click away.
  const startNewChat = useCallback(() => {
    newChat();
    onReset();
  }, [newChat, onReset]);

  const formTokens = useMemo(
    () => formTokensFor?.(registry.branding?.colors?.accent),
    [formTokensFor, registry.branding],
  );

  // The title arrives already trimmed/validated from the sidebar's inline
  // editor; this only talks to the server.
  const rename = async (row: ThreadRow, newTitle: string) => {
    // A title the reader typed outranks anything automatic, including an
    // auto-rename still in flight - so claim the thread before the request.
    autoNamedRef.current.add(row.thread_id);
    try {
      await renameThread(row.thread_id, newTitle);
      refreshThreads();
    } catch { /* leave the old title on failure */ }
  };

  const messages = useMemo<DisplayMessage[]>(() => {
    const welcome: DisplayMessage[] = agent.welcome && state.messages.length === 0
      ? [{ id: 'welcome', role: 'assistant', text: agent.welcome }]
      : [];
    return [...welcome, ...state.messages];
  }, [agent.welcome, state.messages]);

  // Chronological form placement: the block renders right AFTER the message
  // the hook anchored it to, so anything said afterwards appears BELOW the
  // form. -1 (restored thread, no anchor) keeps the end-of-stream position.
  const formAnchorIdx = useMemo(
    () => (state.form ? formAnchorIndex(messages, state.formAnchorId) : -1),
    [messages, state.form, state.formAnchorId],
  );

  // ---- follow the conversation --------------------------------------------
  // New content (a turn, the thinking state) scrolls the chat to the bottom,
  // but only when the reader was already there or the growth is their own
  // send. Scrolling up to read history is never interrupted. A form that just
  // APPEARED is the exception: it anchors by its own top, because forms run
  // taller than the viewport and the header is what the reader needs. The
  // round counter keeps that to one anchor per appearance - typing inside the
  // form re-renders it without moving the view. All of it lives in the package
  // so every host gets the behavior.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const formTopRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const seenFormRoundRef = useRef(state.formRound);
  // Contract id the last consumed round belonged to. A new round under the SAME
  // id is a REDRAW of the form already on screen - an EIB fix round - and must
  // not re-anchor; see scrollTarget.
  const anchoredFormIdRef = useRef<string | null>(null);
  // Where the reader actually was, recorded on every scroll, so a redraw that
  // the browser CLAMPS can be put back before the frame paints.
  const lastScrollTopRef = useRef(0);
  // ...and where the FORM'S TOP was at that same instant, in the same scroll
  // coordinates. Recorded as a PAIR, in the scroll handler, because by the time
  // the hold arms the form block is out of the DOM and unmeasurable - an empty
  // `.chat-form-anchor` is `display: none` and reports a zero rect. The pair is
  // what makes the restore survive a form that comes back a different size or
  // in a different place; see HeldScroll. -1 means "not measurable", and the
  // arithmetic falls back to the absolute offset.
  const lastFormTopRef = useRef(-1);
  // The same fact as `nearBottomRef`, in state, because the "new reply below"
  // affordance has to RE-RENDER when the reader scrolls down to the message it
  // is pointing at. The ref stays the source of truth for the scroll policy
  // (which reads it synchronously, mid-effect); this mirrors it for rendering,
  // and only when the value actually flips, so scrolling costs no extra renders.
  const [nearBottom, setNearBottom] = useState(true);
  const markNearBottom = useCallback((v: boolean) => {
    nearBottomRef.current = v;
    setNearBottom((prev) => (prev === v ? prev : v));
  }, []);
  // A SMOOTH SCROLL IS NOT THE READER LEAVING THE BOTTOM.
  //
  // `scrollToBottom` animates, so for the ~300ms it runs the scroller reports a
  // position that is NOT near the bottom - the content grew in this commit and
  // scrollTop has not caught up. Read naively that says "the reader is away from
  // the bottom", which is exactly the condition the reply affordance keys on, so
  // the pill appeared and then vanished on every ordinary bottom-follow. Found
  // by reading the wiring rather than by a test: jsdom does not animate, so the
  // vitest suite cannot see it.
  //
  // The window is deliberately time-boxed and self-releasing: a scroll the
  // READER starts inside it only delays the pill, and nothing can wedge it on.
  // Only the RENDERED state is gated - `nearBottomRef` stays honest, because the
  // scroll policy reads it synchronously and its behaviour must not change.
  const autoScrollUntilRef = useRef(0);
  const onChatScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = isNearBottom(el);
    lastScrollTopRef.current = el.scrollTop;
    // One rect read per scroll event, and only while a form is on screen. It is
    // taken HERE rather than in a render effect so that the offset and the form
    // top are read at the same instant and describe the same frame.
    const formEl = formTopRef.current;
    lastFormTopRef.current = formEl ? scrollOffsetOf(el, formEl) : -1;
    if (!atBottom && Date.now() < autoScrollUntilRef.current) {
      nearBottomRef.current = false;
      return;
    }
    autoScrollUntilRef.current = 0;
    markNearBottom(atBottom);
  }, [markNearBottom]);

  // THE SCROLL HOLD. A submit collapses the form and starts a turn, and a
  // collapsed form block mid-turn renders nothing at all - so the transcript
  // loses the entire form in one commit, and the bottom-follow that the
  // reader's own outgoing turn triggers sends the view to the bottom of what
  // little is left. Measured on staging-v16: 7360 -> 0, 6106 -> 65, 6371 ->
  // 12068, that last one being the exact bottom. See scrollHoldAction for the
  // whole argument; this is the wiring.
  //
  // Runs on EVERY render, without a dependency list, because the moment worth
  // catching is the one where the REPLACEMENT form paints tall again, and that
  // commit changes none of the state the other effect depends on. It measures
  // the scroller only while a hold is live or being armed, so the normal case
  // costs nothing.
  const heldScrollRef = useRef<HeldScroll | null>(null);
  const blockShownRef = useRef(false);
  // "SHOWN" MEANS THE FORM ITSELF, not merely something in its place.
  //
  // This first read `!(collapsed && busy)`, mirroring the one branch in
  // InlineFormBlock that renders nothing at all - and it was wrong in a way
  // only the instrumented run found. When a turn ends a commit BEFORE the view
  // flips back to `inline`, that predicate reports the form as shown while the
  // DOM still holds the collapsed CARD: a ~40px button. The transcript cannot
  // hold the reader's old offset, the turn is over, and the hold was therefore
  // discarded one commit before the form re-expanded. Measured: every logged
  // decision in that window read `max: 0`, ending in `action: "drop"` with the
  // form supposedly shown. A collapsed card is not the form.
  const formBlockShown = Boolean(state.form) && formView !== 'collapsed';
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const wasShown = blockShownRef.current;
    blockShownRef.current = formBlockShown;
    const formId = state.form?.contract.id ?? null;
    const held = heldScrollRef.current;
    if (!el || (!held && formBlockShown)) return;

    // WHERE THE READER WAS, EXPRESSED AGAINST THE FORM THAT CAME BACK. The
    // recorded offset is anchored to the form's top, so a replacement that sits
    // higher or lower in the transcript carries the reader with it; only when
    // the form is unmeasurable does this fall back to the raw offset. See
    // anchoredScrollTop.
    const formEl = formTopRef.current;
    const target = held
      ? anchoredScrollTop(held, formEl ? scrollOffsetOf(el, formEl) : -1)
      : 0;

    const action = scrollHoldAction({
      wasShown,
      isShown: formBlockShown,
      formId,
      heldFormId: held?.formId ?? null,
      busy: state.busy,
      // Measured, not assumed: the replacement form may be in the DOM a commit
      // before it has laid out to its full height. This decides restore-NOW
      // versus wait-for-layout; a replacement that never gets tall enough is
      // still restored, as far as it reaches, once the turn settles.
      contentCanHold: held
        ? el.scrollHeight - el.clientHeight >= target - SCROLL_RESTORE_SLACK
        : false,
    });

    if (action === 'arm') {
      // lastScrollTopRef still holds the PRE-collapse offset: scroll events are
      // asynchronous, so the browser's clamp has not been reported yet. Its
      // partner lastFormTopRef was read in the same scroll event.
      if (formId) {
        heldScrollRef.current = {
          top: lastScrollTopRef.current, formId, formTop: lastFormTopRef.current,
        };
      }
      return;
    }
    if (action === 'drop') { heldScrollRef.current = null; return; }
    if (action !== 'restore' || !held) return;

    heldScrollRef.current = null;
    const top = restoreScrollTop(
      target, el.scrollTop, el.scrollHeight - el.clientHeight,
    );
    if (top === null) return;
    el.scrollTop = top;
    lastScrollTopRef.current = top;
    markNearBottom(isNearBottom(el));
  });

  // The reader's own send licenses ONE bottom-follow, not a standing one for
  // the rest of the turn - see effectiveLastRole.
  const followedUserMsgRef = useRef<string | null>(null);
  const lastMsg = messages[messages.length - 1];
  const lastRole = effectiveLastRole(lastMsg?.role, lastMsg?.id, followedUserMsgRef.current);
  useEffect(() => {
    const el = scrollRef.current;
    const formId = state.form?.contract.id ?? null;
    if (lastMsg?.role === 'user') followedUserMsgRef.current = lastMsg.id;
    const target = scrollTarget({
      nearBottom: nearBottomRef.current,
      lastMessageRole: lastRole,
      hasForm: Boolean(state.form),
      formRound: state.formRound,
      seenFormRound: seenFormRoundRef.current,
      formId,
      anchoredFormId: anchoredFormIdRef.current,
    });
    // The round is consumed either way: a reader who stayed scrolled up
    // through a form's arrival is not chased down by the NEXT message. The id
    // is consumed on the same terms, so the NEXT round is judged against the
    // form this one actually left on screen.
    seenFormRoundRef.current = state.formRound;
    // Assigned unconditionally, null included: with no form on screen there is
    // no predecessor for the next contract to be a redraw OF, so the next form
    // anchors - which is the conservative direction.
    anchoredFormIdRef.current = formId;
    // A LIVE HOLD OUTRANKS EVERY TARGET. While the form block is out of the DOM
    // mid-turn the transcript is a fraction of its real height, so "the bottom"
    // is a position that will not exist a second from now - following it is
    // exactly how the reader's place was being destroyed. The round is consumed
    // above either way, so the form does not re-anchor when it returns; the
    // layout effect puts the view back where it was.
    if (heldScrollRef.current) return;
    if (!el || !target) return;
    const behavior = scrollBehaviorFor(prefersReducedMotion());
    if (target === 'form-top' && formTopRef.current) {
      autoScrollUntilRef.current = Date.now() + AUTO_SCROLL_SETTLE_MS;
      scrollFormTopIntoView(el, formTopRef.current, behavior);
      markNearBottom(false);
      return;
    }
    // Opens the settle window BEFORE the animation starts (see onChatScroll).
    autoScrollUntilRef.current = Date.now() + AUTO_SCROLL_SETTLE_MS;
    scrollToBottom(el, behavior);
    markNearBottom(true);
  }, [markNearBottom, messages.length, lastRole, state.form, state.formRound, state.thinking,
    state.busy, state.answerSettled]);

  // THE REPLY NOBODY CAN SEE. A form anchored mid-transcript pushes everything
  // said afterwards below itself, and these forms are several viewports tall,
  // so an answer to a question asked mid-form lands off screen with no signal
  // at all. See replyBelowFormId for why this is an affordance rather than an
  // auto-scroll.
  const replyBelowId = replyBelowFormId({
    formShown: formBlockShown,
    formAnchorIndex: formAnchorIdx,
    lastIndex: messages.length - 1,
    lastRole: lastMsg?.role,
    lastId: lastMsg?.id ?? null,
    streaming: state.busy || Boolean(lastMsg?.streaming),
    nearBottom,
  });
  const goToReplyBelow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    autoScrollUntilRef.current = Date.now() + AUTO_SCROLL_SETTLE_MS;
    scrollToBottom(el, scrollBehaviorFor(prefersReducedMotion()));
    markNearBottom(true);
  }, [markNearBottom]);

  // ---- naming the chat ------------------------------------------------------
  // The platform titles a thread from its first user message, which in this
  // product is the word "start" (or a raw form envelope) - so the sidebar fills
  // with identical rows. The shell writes back the same label the row already
  // displays: the agent's name and when the chat happened. Only ever over a STUB
  // title, and only once per thread; a name the reader typed is never touched.
  // See lib/view/threadTitle for why this deliberately names no one.
  const autoNamedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const threadId = state.threadId;
    if (!threadId || autoNamedRef.current.has(threadId)) return;
    const row = threads.find((t) => t.thread_id === threadId);
    // No row yet means the listing has not caught up with a thread created
    // moments ago; the next refresh brings it and this runs again.
    if (!row || !isStubThreadTitle(row.title)) return;
    autoNamedRef.current.add(threadId);
    renameThread(threadId, derivedThreadTitle(agent.name, isoOf(row.updated_at)))
      .then(() => refreshThreads())
      .catch(() => { /* the display fallback still keeps the rows distinct */ });
  }, [state.threadId, threads, agent.name, refreshThreads]);

  // Wrapper exists to give the scroller a measurable top edge for the form.
  const formBlock = state.form ? (
    <div className="chat-form-anchor" ref={formTopRef}>
      <InlineFormBlock
        form={state.form}
        seed={state.formSeed}
        view={formView}
        busy={state.busy}
        onView={setFormView}
        optionsProvider={optionsProvider}
        uploadProvider={uploadFile}
        onSubmit={submitForm}
        onReviewConfirm={confirmReview}
        onValuesChange={noteFormEdit}
      />
    </div>
  ) : null;

  return (
    <div className={`shell-body${focus ? ' shell-body--focus' : ''}`}>
      {!focus && (
        <nav className="sidebar">
          <div className="sidebar-group">
            <h2 className="sidebar-heading">Agents</h2>
            {registry.agents.map((a) => (
              <button
                key={a.key}
                type="button"
                className={`sidebar-item${a.key === agent.key ? ' sidebar-item--active' : ''}`}
                onClick={() => onSelectAgent(a.key)}
                disabled={a.comingSoon}
              >
                <span className="sidebar-item-name">{a.name}</span>
                <span className="sidebar-item-tag">
                  {a.comingSoon ? 'Coming soon' : a.tagline}
                </span>
              </button>
            ))}
          </div>
          <ThreadList
            threads={threads}
            activeThread={state.threadId}
            onOpen={openThread}
            onRename={rename}
            onNew={startNewChat}
            agentName={agent.name}
          />
        </nav>
      )}
      <main className={`workspace workspace--live${workspaceAside ? ' workspace--with-aside' : ''}`}>
        <FormEngineTheme tokens={formTokens}>
          <div className="chat-panel chat-panel--live">
            {focus && (
              <div className="focus-thread-bar">
                {/* Focus mode is single-conversation by design: the agent's
                  * name, and the refresh control starting a fresh chat. No
                  * thread browsing here - that lives in workspace view. */}
                <span className="focus-agent-title">{agent.name}</span>
                <button
                  type="button"
                  className="thread-picker-new"
                  aria-label="New chat"
                  title="New chat"
                  onClick={startNewChat}
                >
                  <NewChatIcon />
                </button>
              </div>
            )}
            <div className="chat-scroll" ref={scrollRef} onScroll={onChatScroll}>
              <ChatStream>
                {messages.map((m, i) => (
                  <Fragment key={m.id}>
                    <ChatMessage
                      role={m.role}
                      author={m.role === 'assistant' ? agent.name : undefined}
                      avatar={m.role === 'assistant' ? agent.name.slice(0, 1) : undefined}
                      timestamp={m.timestamp}
                      streaming={m.streaming}
                      content={m.errorDetails || m.receipt
                        ? undefined : displayText(m.role, m.text)}
                    >
                      {m.receipt ? (
                        <ReceiptCard receipt={m.receipt} />
                      ) : m.errorDetails ? (
                        isContextLengthError(m.errorDetails) ? (
                          <ErrorCard
                            message="This chat got too long for the agent to continue."
                            details={m.errorDetails}
                            retryLabel="Start a fresh chat with your current form values carried over"
                            onRetry={freshChatWithForm}
                          />
                        ) : looksLikeEnvelopeRefusal(m.errorDetails) ? (
                          // The guard refused the turn before any tool ran, so
                          // the recovery is that same envelope again - taken from
                          // THIS message (`m.retry`), never from a "last sent"
                          // box, so it cannot fire off something the reader typed
                          // afterwards or replay another thread's turn. With
                          // nothing recoverable recorded the affordance is simply
                          // absent rather than a button that does nothing.
                          // Labelled for what it does: they clicked a form
                          // action, not a chat message.
                          <ErrorCard
                            message={m.text}
                            details={m.errorDetails}
                            retryLabel="Send it again"
                            onRetry={m.retry
                              ? () => { void send(m.retry!.content, m.retry!.displayText); }
                              : undefined}
                          />
                        ) : (
                          <ErrorCard message={m.text} details={m.errorDetails} onRetry={retry} />
                        )
                      ) : undefined}
                    </ChatMessage>
                    {i === formAnchorIdx && formBlock}
                  </Fragment>
                ))}
                {formAnchorIdx === -1 && formBlock}
                {/* INVARIANT: the indicator means "renderable content is still
                  * in flight" - nothing else. Once this run has painted its
                  * form, the run tail renders nothing by platform design (the
                  * closing message is the model re-typing the tool text the
                  * announce bubble already shows, reconciled in place), so the
                  * spinner would only be saying "wait" about seconds of dead
                  * air. The form is NOT held back until run.completed for the
                  * same reason: that would add those seconds to every form
                  * round for zero information. See showsThinking. */}
                {showsThinking(state) && (
                  <div className="thinking-bubble">
                    <ThinkingState
                      copy={state.thinking ?? undefined}
                      fallbackPhrases={agent.fallbackPhrases}
                    />
                  </div>
                )}
                {state.error && (
                  <ChatMessage role="system" content={`Something went wrong: ${state.error}`} />
                )}
              </ChatStream>
            </div>
            {/* Unobtrusive, and it waits: the reader is very likely typing in
                the form right now, and moving the viewport under them is the
                defect the whole autoScroll module exists to prevent. */}
            {replyBelowId && (
              <div className="reply-below-slot">
                <button
                  type="button"
                  className="reply-below"
                  onClick={goToReplyBelow}
                  data-testid="reply-below"
                >
                  New reply below
                </button>
              </div>
            )}
            <ChatInput disabled={state.busy} onSend={(t) => void send(t)} />
          </div>
        </FormEngineTheme>
        {workspaceAside}
      </main>
    </div>
  );
}
