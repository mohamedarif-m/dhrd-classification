/**
 * @vitest-environment jsdom
 *
 * The thinking indicator's one rule: it means "renderable content is still in
 * flight", nothing else.
 *
 * Live report 2026-08-12 (EIB agent, staging): the form card rendered
 * mid-stream and the indicator kept spinning UNDER it until the run closed
 * seconds later, which reads as "more is coming" when the form IS the answer.
 *
 * These tests drive the REAL hook through the REAL normalizer with the LIVE
 * captured stream (docs/fixtures/jrc-start-stream-trimmed.ndjson), so the
 * window between the contract-bearing tool result and run.completed is the one
 * the platform actually produces - not a shape invented here. The api module
 * is the only thing mocked: the fixture is replayed in its place.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormContract } from '../../../../form-engine';
import type {
  AgentChatState,
  DisplayMessage,
} from '../useAgentChat';
import { showsThinking, useAgentChat } from '../useAgentChat';
import type { LiveRegistry, LiveRegistryAgent, SlimMessage, WireEvent } from '../liveTypes';
import { CONTRACT_META_KEY } from '../../stream/toolMeta';

vi.mock('../api', () => ({
  streamChat: vi.fn(),
  getMessages: vi.fn(),
}));
// eslint-disable-next-line import/first
import { getMessages, streamChat } from '../api';

// Resolved from the package root (vitest's cwd): under jsdom `import.meta.url`
// is not a file: URL, so the URL-relative form used elsewhere throws here.
const fixturePath = resolve(
  process.cwd(), '../../docs/fixtures/jrc-start-stream-trimmed.ndjson');
const FIXTURE: WireEvent[] = readFileSync(fixturePath, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** The contract-bearing tool result, and everything the run emits after it. */
const contractAt = FIXTURE.findIndex(
  (e) => JSON.stringify(e).includes(CONTRACT_META_KEY));

const agent: LiveRegistryAgent = { key: 'jobreq', name: 'Job Requisition' };
const registry: LiveRegistry = { mode: 'live', agents: [agent] };

/** Every event that carries a Form Contract - on the tool result AND on the
 * message that closes the turn, which repeats it in its step history. */
const carriesContract = (e: WireEvent) => JSON.stringify(e).includes(CONTRACT_META_KEY);

/**
 * Replay a slice of the capture into the hook and HOLD the stream open, so the
 * assertions read the state a reader is actually looking at MID-RUN. Letting
 * the mock return instead would end the run (`send` clears busy on its way
 * out) and every one of these tests would pass for the wrong reason.
 *
 * Returns the release, to be called inside `act` once the assertions are done.
 */
const replayHolding = (events: WireEvent[]) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  (streamChat as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (_body: unknown, onEvent: (ev: WireEvent) => void) => {
      for (const ev of events) onEvent(ev);
      await held;
    },
  );
  return release;
};

/**
 * Start a turn and leave it streaming; returns the promise to settle later.
 * `act` is used SYNCHRONOUSLY here: the mock emits every event before it awaits
 * the hold, so all the state updates have landed by the time this returns -
 * whereas the async form of `act` would sit waiting for a stream that is being
 * held open on purpose.
 */
const startTurn = (
  send: (content: string) => Promise<void>,
  text = 'start',
): Promise<void> => {
  let pending!: Promise<void>;
  act(() => { pending = send(text); });
  return pending;
};

const finish = async (release: () => void, pending: Promise<void>) => {
  await act(async () => { release(); await pending; });
};

const historyContract: SlimMessage = {
  id: 'm1',
  role: 'assistant',
  text: "Here's the job requisition form.",
  is_async: false,
  tools_called: [],
  meta: {
    [CONTRACT_META_KEY]: {
      contract: {
        id: 'jobreq-entry',
        title: 'Job requisition',
        sections: [],
        submitTool: 'jrc_validate',
      } as unknown as FormContract,
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

const baseState = (over: Partial<AgentChatState> = {}): AgentChatState => ({
  messages: [] as DisplayMessage[], thinking: null, form: null, formSeed: undefined,
  formAnchorId: null, formRound: 0, answerSettled: false, threadId: null,
  busy: false, error: null, ...over,
});

describe('showsThinking (the indicator rule)', () => {
  it('shows while a run is busy with nothing rendered yet', () => {
    expect(showsThinking(baseState({ busy: true }))).toBe(true);
  });

  it('shows on a thinking line even when busy has not been set', () => {
    expect(showsThinking(baseState({ thinking: 'Checking Workday...' }))).toBe(true);
  });

  it('hides once this run has painted its answer, busy or not', () => {
    expect(showsThinking(baseState({ busy: true, answerSettled: true }))).toBe(false);
    expect(showsThinking(baseState({
      busy: true, thinking: 'The agent is processing your request', answerSettled: true,
    }))).toBe(false);
  });

  it('hides on an idle run, as before', () => {
    expect(showsThinking(baseState())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (a) the reported defect, against the live capture
// ---------------------------------------------------------------------------

describe('a run that renders a form (live capture)', () => {
  it('hides the indicator the moment the form card renders, mid-run', async () => {
    // The run is still open (no run.completed) with the form on screen: the
    // reported situation exactly.
    const release = replayHolding(FIXTURE.slice(0, contractAt + 1));
    const { result } = renderHook(() => useAgentChat(agent, registry));
    const pending = startTurn(result.current.send);
    expect(result.current.state.busy).toBe(true);
    expect(result.current.state.form).not.toBeNull();
    expect(result.current.state.answerSettled).toBe(true);
    expect(showsThinking(result.current.state)).toBe(false);
    await finish(release, pending);
  });

  it('keeps it hidden for the whole tail of the run (the reported defect)', async () => {
    // The tail the platform actually sends after the contract, in order.
    const tail = FIXTURE.slice(contractAt + 1);
    expect(tail.map((e) => e.event)).toEqual([
      'run.step.intermediate', 'message.delta', 'message.created',
      'message.completed', 'run.completed', 'done',
    ]);
    // Replay all of it EXCEPT the terminal events, so the run is still open:
    // the "agent is processing your request" intermediate (this is what re-lit
    // the spinner under the form) and the model re-typing the tool's own text,
    // which the announce bubble already shows and which reconciles into it in
    // place. Nothing new is painted, so the indicator must stay down.
    const upToTerminal = FIXTURE.slice(0, FIXTURE.findIndex((e) => e.event === 'run.completed'));
    const release = replayHolding(upToTerminal);
    const { result } = renderHook(() => useAgentChat(agent, registry));
    const pending = startTurn(result.current.send);
    expect(result.current.state.busy).toBe(true);
    expect(result.current.state.form).not.toBeNull();
    expect(showsThinking(result.current.state)).toBe(false);
    await finish(release, pending);
  });

  it('re-lights the indicator if a further tool call starts after the form', async () => {
    // Not something our flows do today, but the rule is "content in flight",
    // not "form seen": a second tool round means content genuinely is coming.
    const secondCall = {
      event: 'run.step.delta',
      data: {
        delta: {
          role: 'assistant',
          step_details: [{ type: 'tool_calls', tool_calls: [{ name: 'jrc_lookup' }] }],
        },
      },
    } as unknown as WireEvent;
    const release = replayHolding([...FIXTURE.slice(0, contractAt + 1), secondCall]);
    const { result } = renderHook(() => useAgentChat(agent, registry));
    const pending = startTurn(result.current.send);
    expect(result.current.state.form).not.toBeNull();
    expect(result.current.state.answerSettled).toBe(false);
    expect(showsThinking(result.current.state)).toBe(true);
    await finish(release, pending);
  });
});

// ---------------------------------------------------------------------------
// (b) a run with no form is untouched
// ---------------------------------------------------------------------------

describe('a run with no form', () => {
  it('keeps the indicator up for the whole run, exactly as before', async () => {
    // The same capture with EVERY contract-bearing event removed (the tool
    // result and the closing message, which repeats it): a plain talking turn,
    // still open.
    const formless = FIXTURE.filter((e) => !carriesContract(e));
    const openRun = formless.slice(0, formless.findIndex((e) => e.event === 'run.completed'));
    const release = replayHolding(openRun);
    const { result } = renderHook(() => useAgentChat(agent, registry));
    const pending = startTurn(result.current.send, 'hello');
    expect(result.current.state.form).toBeNull();
    expect(result.current.state.answerSettled).toBe(false);
    expect(showsThinking(result.current.state)).toBe(true);
    await finish(release, pending);
  });
});

// ---------------------------------------------------------------------------
// (c) a form that is not this run's answer must not mask it
// ---------------------------------------------------------------------------

describe('a form restored from history', () => {
  it('does not suppress the indicator of a fresh run', async () => {
    (getMessages as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue([historyContract]);
    const { result } = renderHook(() => useAgentChat(agent, registry));
    await act(async () => { await result.current.openThread('t-1'); });
    // The thread restores WITH a form on screen...
    expect(result.current.state.form).not.toBeNull();
    expect(result.current.state.answerSettled).toBe(false);

    // ...and the next turn, which is genuinely thinking, still says so - the
    // restored form is a previous turn's answer, not this run's.
    const release = replayHolding(FIXTURE.slice(0, contractAt)); // before the form
    const pending = startTurn(result.current.send, 'change the title');
    expect(result.current.state.form).not.toBeNull(); // the old form is still up
    expect(result.current.state.answerSettled).toBe(false);
    expect(showsThinking(result.current.state)).toBe(true);
    await finish(release, pending);
  });

  it('a new chat clears the state, so the next run shows its indicator', async () => {
    const release = replayHolding(FIXTURE.slice(0, contractAt + 1));
    const { result } = renderHook(() => useAgentChat(agent, registry));
    const pending = startTurn(result.current.send);
    expect(result.current.state.answerSettled).toBe(true);
    await finish(release, pending);
    act(() => { result.current.newChat(); });
    expect(result.current.state.answerSettled).toBe(false);
    expect(result.current.state.form).toBeNull();
  });
});
