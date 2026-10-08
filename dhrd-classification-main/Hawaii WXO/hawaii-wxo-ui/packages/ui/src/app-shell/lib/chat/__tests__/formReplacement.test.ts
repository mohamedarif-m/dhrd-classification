/**
 * @vitest-environment jsdom
 *
 * WHEN A RUN RETURNS A FORM, IT REPLACES WHATEVER FORM IS ON SCREEN - cleanly.
 *
 * This is the invariant between ordinary rounds: the reader fills a form, the
 * agent answers with a re-rendered or different one, and the new contract must
 * arrive as a NEW APPEARANCE rather than a redraw of the old one. Concretely:
 * the fields are the arriving contract's, `formRound` bumps so the surface
 * re-anchors, and nothing typed into the previous form leaks into the new one.
 *
 * That last clause is the live defect class from 2026-08-11: a form rebuilt
 * for a different subject inherited the previous subject's answers because the
 * held seed outlived the contract it belonged to. `seedSurvives` is what stops
 * it, and these are its behavioral test.
 *
 * A contract arriving with the SAME id is deliberately treated as a redraw of
 * the form already on screen (the seed is reapplied, the round is not bumped).
 * That is why tool-side contract ids are scoped to whatever the form depends
 * on - see `seedSurvives` and `formArrivalFor`.
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ENVELOPE_SENTINEL, showsThinking, useAgentChat } from '../useAgentChat';
import type { LiveRegistry, LiveRegistryAgent, WireEvent } from '../liveTypes';
import { CONTRACT_META_KEY } from '../../stream/toolMeta';

vi.mock('../api', () => ({
  streamChat: vi.fn(async () => {}),
  getMessages: vi.fn(async () => []),
}));
import { getMessages, streamChat } from '../api';

const mock = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

const agent: LiveRegistryAgent = { key: 'eib', name: 'EIB Loader' };
const registry: LiveRegistry = { mode: 'live', agents: [agent] };

/** The form the first round puts up. */
const FIRST_CONTRACT = {
  id: 'eib-upload-v1',
  title: 'Attach the workbook',
  submitTool: 'eibc_validate',
  sections: [{
    id: 'workbook', title: 'Workbook',
    fields: [
      { id: 'legacy_note', label: 'Note', type: 'text' },
      { id: 'legacy_only_field', label: 'Only on the old form', type: 'text' },
    ],
  }],
};

/** What the next round answers with: different id, different field set. */
const SECOND_CONTRACT = {
  id: 'eib-upload-v2',
  title: 'Attach the workbook',
  submitTool: 'eibc_validate',
  sections: [{
    id: 'workbook', title: 'Workbook',
    fields: [
      { id: 'note', label: 'Note', type: 'text' },
      { id: 'currency', label: 'Currency', type: 'text' },
    ],
  }],
};

const announce = (contract: object, text: string): WireEvent => ({
  event: 'run.step.delta',
  data: {
    delta: {
      role: 'assistant',
      step_details: [{
        type: 'tool_response',
        content: JSON.stringify({
          _meta: { [CONTRACT_META_KEY]: { contract } },
          content: [{ type: 'text', text }],
        }),
      }],
    },
  },
} as unknown as WireEvent);

const round = (contract: object, text: string, terminal = true): WireEvent[] => ([
  { event: 'run.started', data: { run_id: 'r', thread_id: 't1' } },
  announce(contract, text),
  { event: 'run.step.intermediate',
    data: { message: { text: 'The agent is processing your request…' } } },
  { event: 'message.delta',
    data: { delta: { role: 'assistant', content: [{ response_type: 'text', text }] } } },
  { event: 'message.created',
    data: { message: { id: `srv-${text.length}`, role: 'assistant',
      created_on: '2026-08-12T00:00:00Z',
      content: [{ response_type: 'text', text }] } } },
  ...(terminal
    ? [{ event: 'run.completed', data: { run_id: 'r' } }, { event: 'done', data: {} }]
    : []),
] as unknown as WireEvent[]);

const FIRST_TEXT = 'Here is the form.';
const SECOND_TEXT = 'I refreshed the form - please check the two fields.';

const settle = async () => { await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
  vi.clearAllMocks();
  mock(getMessages).mockResolvedValue([]);
});

describe('a form returned by a run replaces the one on screen', () => {
  /**
   * Round one puts up the first form; the reader fills it and submits; round
   * two answers with a different contract. `hold` stops the second stream
   * before its terminal events so mid-run state can be read.
   */
  const twoRounds = async (opts: { hold?: boolean } = {}) => {
    let call = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    mock(streamChat).mockImplementation(
      async (_b: unknown, onEvent: (ev: WireEvent) => void) => {
        call += 1;
        if (call === 1) {
          for (const ev of round(FIRST_CONTRACT, FIRST_TEXT)) onEvent(ev);
          return;
        }
        for (const ev of round(SECOND_CONTRACT, SECOND_TEXT, !opts.hold)) onEvent(ev);
        if (opts.hold) await held;
      },
    );

    const { result } = renderHook(() => useAgentChat(agent, registry));
    // Round one: an ordinary message brings the first form up.
    await act(async () => { await result.current.send('i need to load payments'); });
    const roundAfterFirst = result.current.state.formRound;
    expect(result.current.state.form?.contract.id).toBe('eib-upload-v1');

    // The reader fills it and submits: the renderer reports edits, then submit.
    const typed = {
      legacy_note: 'typed into the first form',
      legacy_only_field: 'field that no longer exists',
    };
    let pending!: Promise<void>;
    await act(async () => {
      result.current.noteFormEdit(typed);
      pending = Promise.resolve(result.current.submitForm(typed)) as Promise<void>;
      if (!opts.hold) await pending;
    });
    return { result, release, pending, roundAfterFirst };
  };

  it('shows the arriving contract, not the one it replaced', async () => {
    const { result } = await twoRounds();
    const form = result.current.state.form;
    expect(form?.contract.id).toBe('eib-upload-v2');
    expect(form?.contract.sections[0].fields.map((f) => f.id)).toEqual(['note', 'currency']);
    expect(JSON.stringify(form)).not.toContain('legacy_only_field');
    expect(form?.submitTool).toBe('eibc_validate');
  });

  it('bumps formRound - a new appearance, not a redraw', async () => {
    const { result, roundAfterFirst } = await twoRounds();
    expect(result.current.state.formRound).toBeGreaterThan(roundAfterFirst);
  });

  it('leaks no value from the replaced form into the new one', async () => {
    const { result } = await twoRounds();
    // The seed is what a remount would paint into the arriving contract. It
    // must not outlive the form it was typed into.
    expect(result.current.state.formSeed).toBeUndefined();
    const dumped = JSON.stringify(result.current.state);
    expect(dumped).not.toContain('typed into the first form');
    expect(dumped).not.toContain('field that no longer exists');
  });

  it('raises no error and leaves the composer usable', async () => {
    const { result } = await twoRounds();
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.busy).toBe(false);
    expect(result.current.state.messages.some((m) => m.errorDetails)).toBe(false);
  });

  it('shows the round\'s message once, beside its form', async () => {
    const { result } = await twoRounds();
    const texts = result.current.state.messages.map((m) => m.text);
    expect(texts.filter((t) => t === SECOND_TEXT)).toHaveLength(1);
  });

  it('follows the normal answerSettled rule while the run finishes', async () => {
    const { result, release, pending } = await twoRounds({ hold: true });
    expect(result.current.state.busy).toBe(true);
    expect(result.current.state.answerSettled).toBe(true);
    expect(showsThinking(result.current.state)).toBe(false);
    await act(async () => { release(); await pending; });
    expect(showsThinking(result.current.state)).toBe(false);
  });

  it('sends the submit to the tool the displayed contract named', async () => {
    const { result } = await twoRounds();
    expect(streamChat).toHaveBeenCalledTimes(2);
    const [body] = mock(streamChat).mock.calls[1];
    const payload = JSON.parse(
      (body as { content: string }).content.slice(ENVELOPE_SENTINEL.length).trim());
    expect(payload.tool).toBe('eibc_validate');
    expect(result.current.state.threadId).toBe('t1');
  });
});

describe('a contract that asks for a packed envelope', () => {
  /**
   * The SHELL half of `packEnvelope`. The engine's own round trip is pinned in
   * conformance/pack-envelope.test.tsx; what matters here is that the thing
   * actually sent over the wire is the packed envelope, addressed to the same
   * tool, with the sentinel and the replacement invariants untouched.
   */
  const PACKED_CONTRACT = {
    ...FIRST_CONTRACT,
    id: 'eib-fix-packed',
    packEnvelope: 'fixes_json',
  };

  const submitPacked = async (values: Record<string, string>) => {
    mock(streamChat).mockImplementation(
      async (_b: unknown, onEvent: (ev: WireEvent) => void) => {
        for (const ev of round(PACKED_CONTRACT, FIRST_TEXT)) onEvent(ev);
      },
    );
    const { result } = renderHook(() => useAgentChat(agent, registry));
    await act(async () => { await result.current.send('fix these rows'); });
    await act(async () => { await result.current.submitForm(values); });
    const [body] = mock(streamChat).mock.calls[1];
    return {
      result,
      payload: JSON.parse(
        (body as { content: string }).content.slice(ENVELOPE_SENTINEL.length).trim()),
    };
  };

  it('sends one packed argument to the contract\'s own submit tool', async () => {
    const { payload } = await submitPacked({
      legacy_note: 'typed into the first form',
      legacy_only_field: 'and this one too',
    });
    expect(payload.tool).toBe('eibc_validate');
    expect(Object.keys(payload.args)).toEqual(['fixes_json']);
    expect(JSON.parse(payload.args.fixes_json)).toEqual({
      legacy_note: 'typed into the first form',
      legacy_only_field: 'and this one too',
    });
  });

  it('holds the values as the seed exactly as an unpacked form does', async () => {
    const typed = { legacy_note: 'a', legacy_only_field: 'b' };
    const { result } = await submitPacked(typed);
    // The seed is the UNPACKED values: packing is a wire shape, never state.
    expect(result.current.state.formSeed).toEqual(typed);
    expect(result.current.state.error).toBeNull();
  });
});

describe('a review confirm carries the review screen\'s own constants', () => {
  /**
   * F1, found in independent review 2026-08-12. The confirm envelope is built
   * from the ENTRY contract's held values, which is right for the reader's
   * answers - but a review contract can carry fields the entry form never had,
   * and a `review` renders only its ReviewPanel, so those fields have no
   * rendered state and their DEFAULTS are the only values they will ever have.
   *
   * Live consequence: EIB's review carries the workbook's `stage_token`, and a
   * workbook that passes first time never sees a fix round, so the entry form
   * stays the upload screen - which has no token. The confirm sent
   * `{workbook, confirm_action}` and the loader answered "that workbook is no
   * longer held on the server, upload it again", forever.
   */
  const ENTRY = {
    id: 'eib-upload',
    title: 'Attach the workbook',
    submitTool: 'eibc_validate',
    sections: [{
      id: 'workbook', title: 'Workbook',
      fields: [{ id: 'workbook', label: 'Workbook', type: 'text' }],
    }],
  };

  /** The review the clean path renders: a panel, plus the carry field. */
  const REVIEW = {
    id: 'eib-review',
    title: 'Review, then load',
    submitTool: 'eibc_submit',
    sections: [{
      id: 'carry', title: 'Workbook reference',
      fields: [{
        id: 'stage_token', label: 'Workbook reference', type: 'text',
        defaultValue: 'stage-abc123',
      }],
    }],
    review: {
      rows: [{ label: 'Workbook', value: 'demo.xlsx', sectionId: 's' }],
      confirmTokens: { submit: 'LOAD_PAYMENTS', cancel: 'EDIT' },
    },
  };

  const confirmAfterCleanUpload = async () => {
    let call = 0;
    mock(streamChat).mockImplementation(
      async (_b: unknown, onEvent: (ev: WireEvent) => void) => {
        call += 1;
        const contract = call === 1 ? ENTRY : REVIEW;
        for (const ev of round(contract, `text ${call}`)) onEvent(ev);
      },
    );
    const { result } = renderHook(() => useAgentChat(agent, registry));
    await act(async () => { await result.current.send('load some payments'); });
    // The reader attaches the workbook and submits: the answer is the REVIEW,
    // with no fix round in between - the clean path.
    await act(async () => {
      await result.current.submitForm({ workbook: 'demo.xlsx|https://f/1' });
    });
    expect(result.current.state.form?.contract.id).toBe('eib-review');
    await act(async () => { await result.current.confirmReview('LOAD_PAYMENTS'); });
    const [body] = mock(streamChat).mock.calls[2];
    return JSON.parse(
      (body as { content: string }).content.slice(ENVELOPE_SENTINEL.length).trim());
  };

  it('sends the review\'s carried defaults alongside the entry answers', async () => {
    const payload = await confirmAfterCleanUpload();
    expect(payload.tool).toBe('eibc_submit');
    expect(payload.args).toEqual({
      workbook: 'demo.xlsx|https://f/1',
      stage_token: 'stage-abc123',
      confirm_action: 'LOAD_PAYMENTS',
    });
  });

  it('lets the DISPLAYED review win over a stale entry value of the same id', async () => {
    // Two workbooks in one thread: the entry form's held value is the older
    // one. The screen being confirmed is the authority on what it describes.
    const entryWithToken = {
      ...ENTRY,
      sections: [{
        id: 'workbook', title: 'Workbook',
        fields: [
          { id: 'workbook', label: 'Workbook', type: 'text' },
          { id: 'stage_token', label: 'ref', type: 'text', defaultValue: 'stage-OLD' },
        ],
      }],
    };
    let call = 0;
    mock(streamChat).mockImplementation(
      async (_b: unknown, onEvent: (ev: WireEvent) => void) => {
        call += 1;
        for (const ev of round(call === 1 ? entryWithToken : REVIEW, `t${call}`)) {
          onEvent(ev);
        }
      },
    );
    const { result } = renderHook(() => useAgentChat(agent, registry));
    await act(async () => { await result.current.send('go'); });
    await act(async () => {
      await result.current.submitForm({ workbook: 'demo.xlsx|u', stage_token: 'stage-OLD' });
    });
    await act(async () => { await result.current.confirmReview('LOAD_PAYMENTS'); });
    const [body] = mock(streamChat).mock.calls[2];
    const payload = JSON.parse(
      (body as { content: string }).content.slice(ENVELOPE_SENTINEL.length).trim());
    expect(payload.args.stage_token).toBe('stage-abc123');
  });

  it('is a no-op for a review with no sections (every sibling agent)', async () => {
    const bare = { ...REVIEW, sections: [] };
    let call = 0;
    mock(streamChat).mockImplementation(
      async (_b: unknown, onEvent: (ev: WireEvent) => void) => {
        call += 1;
        for (const ev of round(call === 1 ? ENTRY : bare, `t${call}`)) onEvent(ev);
      },
    );
    const { result } = renderHook(() => useAgentChat(agent, registry));
    await act(async () => { await result.current.send('go'); });
    await act(async () => {
      await result.current.submitForm({ workbook: 'demo.xlsx|u' });
    });
    await act(async () => { await result.current.confirmReview('LOAD_PAYMENTS'); });
    const [body] = mock(streamChat).mock.calls[2];
    const payload = JSON.parse(
      (body as { content: string }).content.slice(ENVELOPE_SENTINEL.length).trim());
    expect(payload.args).toEqual({
      workbook: 'demo.xlsx|u', confirm_action: 'LOAD_PAYMENTS',
    });
  });
});

describe('opening a chat starts nothing on its own', () => {
  it('mounts with no form, no thread and nothing sent', async () => {
    const { result } = renderHook(() => useAgentChat(agent, registry));
    await settle();
    // The surface is the agent's greeting and a live composer. A form only
    // ever arrives as the answer to something the reader actually said.
    expect(result.current.state.form).toBeNull();
    expect(result.current.state.threadId).toBeNull();
    expect(result.current.state.messages).toEqual([]);
    expect(result.current.state.busy).toBe(false);
    expect(showsThinking(result.current.state)).toBe(false);
    expect(streamChat).not.toHaveBeenCalled();
    expect(getMessages).not.toHaveBeenCalled();
  });
});
