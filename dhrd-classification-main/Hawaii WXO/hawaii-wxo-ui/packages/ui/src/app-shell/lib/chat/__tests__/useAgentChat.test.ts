import { describe, expect, it } from 'vitest';
import type { FormContract, ReviewModel } from '../../../../form-engine';
import {
  autoContinueEnvelope,
  ENVELOPE_SENTINEL,
  AUTO_CONTINUE_DEFAULT_MS,
  checkEnvelopeFor,
  dispatchPendingCheck,
  applyCountCopy,
  displayText,
  looksLikeEnvelopeRefusal,
  looksLikeToolError,
  failureCopyFor,
  reconcileFinal,
  envelopeLabels,
  formAnchorIndex,
  isCreatedReceipt,
  pendingSubmitFrom,
  receiptMessage,
  nextFormRound,
  reopenEntryForm,
  restoredForm,
  formArrivalFor,
  seedSurvives,
  restoredSeed,
  type AgentChatState,
  type DisplayMessage,
  type PendingSubmit,
  type DirtyForm,
} from '../useAgentChat';
import type { ActiveForm } from '../liveTypes';
import type { AutoContinue } from '../../stream/toolMeta';

const msg = (id: string, text = id): DisplayMessage => ({ id, role: 'assistant', text });

const stateWith = (messages: DisplayMessage[]): AgentChatState => ({
  messages, thinking: null, form: null, formSeed: undefined, formAnchorId: null,
  formRound: 0, answerSettled: false, threadId: null, busy: false, error: null,
});

const entryForm: ActiveForm = {
  contract: { id: 'entry', title: 'Job requisition', sections: [] } as unknown as FormContract,
  submitTool: 'jrc_verify',
};

describe('form anchoring', () => {
  it('resolves the anchor to the message that carries the id', () => {
    expect(formAnchorIndex([msg('a'), msg('b'), msg('c')], 'b')).toBe(1);
  });

  it('falls back to the end of the stream without an anchor', () => {
    expect(formAnchorIndex([msg('a')], null)).toBe(-1);
    expect(formAnchorIndex([msg('a')], 'gone')).toBe(-1);
  });

  it('anchors a reopened form at the bottom with NO note (silent reopen)', () => {
    const next = reopenEntryForm(stateWith([msg('a'), msg('b')]), entryForm);
    expect(next.formAnchorId).toBe('b');
    expect(next.messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(formAnchorIndex(next.messages, next.formAnchorId)).toBe(1);
    expect(next.form).toBe(entryForm);
  });

  it('reopen with an empty stream falls back to the end position', () => {
    const next = reopenEntryForm(stateWith([]), entryForm);
    expect(next.formAnchorId).toBeNull();
    expect(next.messages).toHaveLength(0);
  });

  it('reopening the entry form opens a NEW form round, so the view re-anchors', () => {
    const before = { ...stateWith([msg('a')]), formRound: 3 };
    expect(reopenEntryForm(before, entryForm).formRound).toBe(4);
    expect(nextFormRound(before)).toBe(4);
  });
});

describe('receipt messages', () => {
  it('carries a rows-bearing receipt as the object, with no joined text', () => {
    const receipt = {
      status: 'created' as const,
      title: 'Requisition R0008336 created',
      id: 'R0008336',
      rows: [{ label: 'Job title', value: 'Producer' }],
    };
    const m = receiptMessage(receipt, 'r-1')!;
    expect(m).toMatchObject({ id: 'r-1', role: 'assistant', text: '' });
    expect(m.receipt).toBe(receipt);
  });

  it('keeps the joined system note for a legacy receipt', () => {
    const m = receiptMessage({
      title: 'Requisition created', id: 'R0008169',
      lines: ['Producer, 2 openings'], text: 'Approvers have been notified.',
    }, 'r-2')!;
    expect(m.receipt).toBeUndefined();
    expect(m.role).toBe('system');
    expect(m.text).toBe(
      'Requisition created\n\nR0008169\n\nProducer, 2 openings\n\nApprovers have been notified.');
  });

  it('shows nothing for an empty legacy receipt', () => {
    expect(receiptMessage({}, 'r-3')).toBeNull();
  });

  it('renders the card even when a rows receipt carries no other strings', () => {
    const m = receiptMessage({ rows: [] }, 'r-4')!;
    expect(m.receipt).toBeDefined();
    expect(m.role).toBe('assistant');
  });
});

describe('finished-flow suppression on thread reload', () => {
  it('recognises a created receipt from either shape', () => {
    expect(isCreatedReceipt({ status: 'created', rows: [] })).toBe(true);
    expect(isCreatedReceipt({ created: true } as never)).toBe(true);
  });

  it('does NOT treat a guard or legacy receipt as a completed flow', () => {
    expect(isCreatedReceipt({ status: 'not_created', rows: [] })).toBe(false);
    // duplicate_guard / edit_requested style receipts carry no created flag.
    expect(isCreatedReceipt({ status: 'not_created', title: 'Already assigned' })).toBe(false);
    expect(isCreatedReceipt({ title: 'Legacy note' })).toBe(false);
    expect(isCreatedReceipt(undefined)).toBe(false);
    expect(isCreatedReceipt(null)).toBe(false);
  });

  it('drops the restored form when the created receipt came after the contract', () => {
    expect(restoredForm(3, 7, entryForm)).toBeNull();
  });

  it('keeps the form when the newest contract came after the receipt', () => {
    // A second flow started in the same thread after an earlier creation.
    expect(restoredForm(9, 4, entryForm)).toBe(entryForm);
  });

  it('keeps the form when no created receipt exists at all', () => {
    expect(restoredForm(2, -1, entryForm)).toBe(entryForm);
  });

  it('is a no-op when there was no form to restore', () => {
    expect(restoredForm(-1, 5, null)).toBeNull();
    expect(restoredForm(-1, -1, null)).toBeNull();
  });
});

describe('envelope bubble labels', () => {
  it('defaults to the brandless action wording', () => {
    expect(envelopeLabels()).toEqual({
      entry: 'Submitting entries...',
      cancel: 'Going back to edit...',
      confirm: 'Submitting...',
      check: 'Checking what happened...',
    });
  });

  it('lets a registry agent override each label', () => {
    expect(envelopeLabels({
      envelopeEntry: 'Checking the requisition...',
      envelopeCancel: 'Reopening the form...',
      envelopeConfirm: 'Creating in Workday...',
      envelopeCheck: 'Looking up the requisition...',
    })).toEqual({
      entry: 'Checking the requisition...',
      cancel: 'Reopening the form...',
      confirm: 'Creating in Workday...',
      check: 'Looking up the requisition...',
    });
  });

  it('keeps the generic mask for envelopes replayed from history', () => {
    expect(displayText('user', '[[TKO_FORM_SUBMIT]] {"tool":"x"}'))
      .toBe('Form submitted - checking the entries...');
  });
});

describe('final-message reconciliation keeps position', () => {
  it('replaces the announce bubble in place - same id, same index, no reorder', () => {
    const announce = msg('local-1', 'Details verified. Review everything, then confirm.');
    const verdictNote: DisplayMessage = { id: 'local-2', role: 'system',
      text: 'Verified against Workday - everything checks out.' };
    const official: DisplayMessage = { id: 'local-1', role: 'assistant',
      text: 'Details verified. Review everything, then confirm.',
      timestamp: '2026-08-04T14:30:00Z' };
    const out = reconcileFinal([announce, verdictNote], 'local-1', 'srv-9', official);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('local-1');
    expect(out[0].timestamp).toBe('2026-08-04T14:30:00Z');
    expect(out[1].id).toBe('local-2');
  });

  it('dedupes a stray server-id copy and appends when no bubble exists', () => {
    const stray = msg('srv-9', 'dup');
    const official: DisplayMessage = { id: 'local-3', role: 'assistant', text: 'hi' };
    const out = reconcileFinal([stray], 'local-3', 'srv-9', official);
    expect(out.map((m) => m.id)).toEqual(['local-3']);
  });
});

describe('submit timeout recovery (run.pending -> checkTool)', () => {
  const review: ReviewModel = {
    rows: [],
    confirmTokens: { submit: 'CONFIRM-CREATE-9f2', cancel: 'GO-BACK' },
    checkTool: 'jrc_submit_check',
  };
  const confirmArgs = {
    job_title: 'Producer',
    supervisory_org: 'SUP-123',
    confirm_action: 'CONFIRM-CREATE-9f2',
  };
  const label = 'Checking what happened in Workday...';

  it('stashes the check tool with the submit args, minus the confirm token', () => {
    const stash = pendingSubmitFrom(review, confirmArgs);
    expect(stash).toEqual({
      checkTool: 'jrc_submit_check',
      args: { job_title: 'Producer', supervisory_org: 'SUP-123' },
    });
    expect(stash!.args).not.toHaveProperty('confirm_action');
  });

  it('stashes nothing when the review names no check tool', () => {
    const { checkTool: _drop, ...noCheck } = review;
    expect(pendingSubmitFrom(noCheck, confirmArgs)).toBeNull();
    expect(pendingSubmitFrom(undefined, confirmArgs)).toBeNull();
  });

  it('builds the check envelope as the same machine protocol as any submit', () => {
    const envelope = checkEnvelopeFor(pendingSubmitFrom(review, confirmArgs), label)!;
    expect(envelope.content).toBe(
      '[[TKO_FORM_SUBMIT]] {"tool":"jrc_submit_check",'
      + '"args":{"job_title":"Producer","supervisory_org":"SUP-123"}}');
    expect(envelope.displayText).toBe(label);
    // The user never sees the raw envelope, even on a history reload.
    expect(displayText('user', envelope.content))
      .toBe('Form submitted - checking the entries...');
  });

  it('dispatches exactly one check turn and clears the stash (no loop)', () => {
    const box: { current: PendingSubmit | null } = {
      current: pendingSubmitFrom(review, confirmArgs),
    };
    const sent: Array<[string, string | undefined]> = [];
    const send = (c: string, d?: string) => { sent.push([c, d]); };

    expect(dispatchPendingCheck(box, label, send)).toBe(true);
    expect(box.current).toBeNull();
    // A second run.pending (the check tool is slow too) must NOT re-fire.
    expect(dispatchPendingCheck(box, label, send)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toContain('"tool":"jrc_submit_check"');
    expect(sent[0][1]).toBe(label);
  });

  it('does nothing when no submit is outstanding (a non-submit turn timed out)', () => {
    const box: { current: PendingSubmit | null } = { current: null };
    const sent: string[] = [];
    expect(dispatchPendingCheck(box, label, (c) => { sent.push(c); })).toBe(false);
    expect(sent).toHaveLength(0);
    expect(checkEnvelopeFor(null, label)).toBeNull();
  });
});

describe('form arrival against an edited form (fast-typist race)', () => {
  const entry = (id: string): ActiveForm => ({
    submitTool: 'jrc_verify',
    contract: { id, title: 'Job requisition', sections: [] } as unknown as FormContract,
  });
  const withFixes = (id: string): ActiveForm => ({
    submitTool: 'jrc_verify',
    contract: {
      id, title: 'Job requisition', sections: [],
      annotations: { fixes: [{ field: 'job_title', message: 'Required' }] },
    } as unknown as FormContract,
  });
  const review: ActiveForm = {
    submitTool: 'jrc_create',
    contract: {
      id: 'review', title: 'Review', sections: [],
      review: { title: 'Check', rows: [], confirmTokens: { cancel: 'go_back', submit: 'create' } },
    } as unknown as FormContract,
  };
  const dirty: DirtyForm = { formId: 'entry', values: { job_title: 'Producer, Live Events' } };

  it('replaces as before when nothing has been typed', () => {
    expect(formArrivalFor(null, entry('entry'))).toEqual({ action: 'replace' });
    expect(formArrivalFor(null, review)).toEqual({ action: 'replace' });
  });

  it('keeps the typed values when the SAME form re-renders', () => {
    expect(formArrivalFor(dirty, entry('entry')))
      .toEqual({ action: 'merge', seed: { job_title: 'Producer, Live Events' } });
  });

  it('still takes the fix round - the arriving contract wins, the values do not', () => {
    // Merge means the arriving contract (annotations and all) is applied; only
    // the seed comes from what the reader typed.
    const arrival = formArrivalFor(dirty, withFixes('entry'));
    expect(arrival.action).toBe('merge');
    expect(arrival).toEqual({ action: 'merge', seed: dirty.values });
  });

  it('drops a review that lands on an edited form', () => {
    expect(formArrivalFor(dirty, review)).toEqual({ action: 'drop' });
  });

  it('replaces when the flow moved on to a different form', () => {
    expect(formArrivalFor(dirty, entry('compensation'))).toEqual({ action: 'replace' });
  });

  /**
   * "Start over" is DECLARED, not inferred from the id (spec jobreq-chaos
   * CV-3). Tools used to signal it by freshening the contract id with a clock
   * token, which meant a tool whose id is genuinely constant could never say
   * it - `eibc_start` re-rendered "eib-upload" and the workbook already
   * uploaded merged straight back in. `fresh` wins over id equality; the id is
   * back to meaning identity alone.
   */
  describe('a contract that declares itself fresh', () => {
    const freshEntry = (id: string): ActiveForm => ({
      submitTool: 'jrc_validate',
      contract: { id, title: 'Job requisition', sections: [], fresh: true } as unknown as FormContract,
    });

    it('REPLACES the dirty form even when the id is identical', () => {
      expect(formArrivalFor(dirty, freshEntry('entry'))).toEqual({ action: 'replace' });
    });

    it('clears the held seed even when the id is identical', () => {
      expect(seedSurvives('entry', freshEntry('entry'))).toBe(false);
    });

    it('pins the non-fresh same-id case: still a merge', () => {
      expect(formArrivalFor(dirty, entry('entry')))
        .toEqual({ action: 'merge', seed: dirty.values });
      expect(seedSurvives('entry', entry('entry'))).toBe(true);
    });

    it('pins the non-fresh different-id case: still a replace', () => {
      expect(formArrivalFor(dirty, entry('jobreq-other'))).toEqual({ action: 'replace' });
      expect(seedSurvives('entry', entry('jobreq-other'))).toBe(false);
    });

    it('does not override the review drop - a fresh review is still a review', () => {
      const freshReview = {
        submitTool: 'jrc_create',
        contract: { ...review.contract, fresh: true },
      } as ActiveForm;
      expect(formArrivalFor(dirty, freshReview)).toEqual({ action: 'drop' });
      expect(seedSurvives('entry', freshReview)).toBe(true);
    });
  });

  /**
   * The other half of the 2026-08-11 employee-switch fix. Scoping a contract id
   * makes a switch REPLACE instead of merge, but `key={contract.id}` then
   * remounts the renderer, which re-reads `initialValues` - so a seed left over
   * from the submitted form painted the previous employee's answers back onto
   * the rebuilt one. See seedSurvives.
   */
  describe('seedSurvives', () => {
    it('drops the seed when one entry form is replaced by a DIFFERENT one', () => {
      expect(seedSurvives('jobchange-mega-e90023', entry('jobchange-mega-e90022')))
        .toBe(false);
    });

    it('keeps the seed when the same entry form comes back', () => {
      expect(seedSurvives('jobchange-mega-e90023', entry('jobchange-mega-e90023')))
        .toBe(true);
    });

    it('KEEPS the seed for a review - the confirm envelope is built from it', () => {
      // Clearing here would break every submit in the app with "Missing form
      // state for the submit": reviewConfirm reads formSeed plus the remembered
      // entry contract.
      expect(seedSurvives('jobchange-mega-e90023', review)).toBe(true);
    });

    it('keeps the seed when there is no previous entry form to compare', () => {
      expect(seedSurvives(undefined, entry('jobchange-mega-e90022'))).toBe(true);
    });
  });

  /**
   * The RELOAD half of the same rule (review of the 2026-08-11 campaign).
   * openThread took the newest envelope as the seed unconditionally, so a
   * thread whose history reads "mega form for A -> switch envelope -> mega form
   * rebuilt for B" restored B's form painted with A's answers, worker_id and
   * all - which the next submit reads as another switch.
   */
  describe('restoredSeed', () => {
    const seed = { worker_id: 'E90022', business_title: 'Systems Analyst' };

    it('drops the seed when the thread rebuilt a DIFFERENT entry form', () => {
      const rebuilt = entry('jobchange-mega-e90023');
      expect(restoredSeed(seed, 'jobchange-mega-e90022', rebuilt, rebuilt))
        .toBeUndefined();
    });

    it('keeps the seed when the restored entry form is the one it was typed on', () => {
      const same = entry('jobchange-mega-e90022');
      expect(restoredSeed(seed, 'jobchange-mega-e90022', same, same)).toBe(seed);
    });

    it('keeps the seed for a review restored on top of its own entry form', () => {
      // The restored review's confirm control is built from formSeed plus the
      // remembered entry contract; clearing it here would refuse the submit.
      expect(restoredSeed(seed, 'jobchange-mega-e90022',
        entry('jobchange-mega-e90022'), review)).toBe(seed);
    });

    it('drops it for a review whose entry form has moved on', () => {
      expect(restoredSeed(seed, 'jobchange-mega-e90022',
        entry('jobchange-mega-e90023'), review)).toBeUndefined();
    });

    it('keeps the seed when the history carried no entry contract at all', () => {
      expect(restoredSeed(seed, undefined, null, null)).toBe(seed);
      expect(restoredSeed(seed, undefined, entry('x'), null)).toBe(seed);
    });

    it('has nothing to do when no envelope was found', () => {
      expect(restoredSeed(undefined, 'jobchange-mega-e90022',
        entry('jobchange-mega-e90023'), null)).toBeUndefined();
    });

    /**
     * `fresh` IS AN ARRIVAL-TIME POLICY AND MUST NOT REACH THE RELOAD PATH.
     * Live-stream freshness answers "a contract just landed on a form the
     * reader is working in - whose values win?". On reload nothing is landing:
     * the render already happened, the reader answered THAT form and submitted
     * it, and the envelope in history is the answer to the very contract being
     * restored.
     *
     * Delegating the flag would break the commonest thread in the app -
     * jrc_start (fresh) -> fill -> submit -> review -> reload - because
     * confirmReview builds its submit envelope from formSeed plus the
     * remembered entry contract. Dropping it there is "Missing form state for
     * the submit" on confirm and a BLANK form on Edit details: the 2026-07-31
     * reload incident, reopened.
     */
    const freshEntry = (id: string): ActiveForm => ({
      submitTool: 'jrc_validate',
      contract: { id, title: 'Job requisition', sections: [], fresh: true } as unknown as FormContract,
    });
    const jrSeed = { job_title: 'Producer, Live Events', openings: '1' };

    it('KEEPS the seed on a reload mid-review of a form that started fresh', () => {
      // jrc_start sent `fresh`; the thread restores that entry contract with a
      // review on top of it, and confirmReview needs the seed.
      expect(restoredSeed(jrSeed, 'jobreq-entry',
        freshEntry('jobreq-entry'), review)).toBe(jrSeed);
    });

    it('KEEPS the seed when the restored form itself is the fresh entry form', () => {
      // Reload with no review on top: "Edit details" must reopen filled, not
      // blank. The live rule would say replace-and-clear here; the reload rule
      // must not, because the seed IS this contract's own answers.
      const restored = freshEntry('jobreq-entry');
      expect(restoredSeed(jrSeed, 'jobreq-entry', restored, restored)).toBe(jrSeed);
    });

    it('still drops it when a fresh restored form is a DIFFERENT one', () => {
      // The id comparison is untouched: freshness changes nothing about it.
      expect(restoredSeed(jrSeed, 'jobreq-entry', freshEntry('jobchange-find'), null))
        .toBeUndefined();
    });
  });
});


describe('auto-continued turns (long-running jobs)', () => {
  const auto: AutoContinue = {
    tool: 'eibc_submit',
    args: { stage_token: 'abc123', confirm_action: 'Continue loading' },
    delayMs: 40,
  };

  it('builds the SAME envelope shape a click would have sent', () => {
    const out = autoContinueEnvelope(auto, 'Loading the payments...');
    expect(out).not.toBeNull();
    expect(out!.displayText).toBe('Loading the payments...');
    expect(out!.delayMs).toBe(40);
    const [sentinel, payload] = [
      out!.content.slice(0, ENVELOPE_SENTINEL.length),
      out!.content.slice(ENVELOPE_SENTINEL.length).trim(),
    ];
    expect(sentinel).toBe(ENVELOPE_SENTINEL);
    expect(JSON.parse(payload)).toEqual({
      tool: 'eibc_submit',
      args: { stage_token: 'abc123', confirm_action: 'Continue loading' },
    });
  });

  it('falls back to the shared delay when the tool names none', () => {
    const { delayMs: _drop, ...noDelay } = auto;
    expect(autoContinueEnvelope(noDelay, 'x')!.delayMs)
      .toBe(AUTO_CONTINUE_DEFAULT_MS);
  });

  it('sends nothing when nothing is armed', () => {
    expect(autoContinueEnvelope(null, 'x')).toBeNull();
  });
});

/**
 * THE DEAD-END GUARD STRING (P2-3, wave-2 campaign).
 *
 * Every agent yaml tells the model that if an envelope names a tool outside its
 * own prefix it must "reply exactly: 'Rejected: unknown form tool.' and stop".
 * When that branch fires, the turn ends with an internal machine string as the
 * last line of the conversation - no explanation, and no hint of the one fact
 * that matters, which is that the guard ran BEFORE any tool and nothing was
 * sent. The client turns it into an honest card with a way forward.
 */
describe('the envelope guard refusal', () => {
  const COPY = { toolError: 'TOOL ERROR COPY', envelopeRefusal: 'NOTHING WAS SENT' };

  it('recognises the string family the five agent yamls specify', () => {
    for (const raw of [
      'Rejected: unknown form tool.',
      'Rejected: unknown form tool',
      '"Rejected: unknown form tool."',
      'rejected: unknown form tool.',
      'Rejected:  unknown form tool.',
      '  Rejected: unknown form tool.  ',
    ]) {
      expect(looksLikeEnvelopeRefusal(raw), `missed the refusal: ${raw}`).toBe(true);
    }
  });

  /**
   * ANCHORED, NOT A SUBSTRING SEARCH. The yamls say "reply exactly", so the
   * realistic deviations are the quotes the model was shown and a trailing stop.
   * A bare `includes` would replace a GOOD reply that merely mentions the phrase
   * with an error card, which is a worse failure than missing an odd variant.
   */
  it('does not fire on a reply that merely MENTIONS the refusal', () => {
    for (const raw of [
      'I cannot do that. Rejected: unknown form tool.',
      'If the tool is unknown I reply "Rejected: unknown form tool." and stop.',
      'Your last submission was rejected: unknown form tool was named.',
    ]) {
      expect(looksLikeEnvelopeRefusal(raw), `false positive: ${raw}`).toBe(false);
    }
  });

  /**
   * A REFUSAL IS A TURN IN WHICH NOTHING HAPPENED. The guard string is
   * model-emitted and nothing at the platform level stops a model calling a tool
   * and then echoing it, so a turn that already painted a form or a receipt is
   * not treated as a dead end however its closing line reads.
   */
  it('is not a dead end when the turn already produced an answer', () => {
    const raw = 'Rejected: unknown form tool.';
    expect(failureCopyFor(raw, COPY, false)?.text).toBe('NOTHING WAS SENT');
    expect(
      failureCopyFor(raw, COPY, true),
      'a turn that rendered a form or receipt was reported as a dead end',
    ).toBeNull();
    // A genuine tool error is still a failure whatever else the turn produced.
    expect(failureCopyFor('Error invoking tool with kwargs {}', COPY, true)?.text)
      .toBe('TOOL ERROR COPY');
  });

  it('does not fire on ordinary agent prose', () => {
    for (const raw of [
      'I rejected the duplicate row and kept the rest.',
      'That form tool is not one I know about - tell me what you want to change.',
      'Here is the review for your job change.',
      'Rejected the change? No - it went through.',
    ]) {
      expect(looksLikeEnvelopeRefusal(raw), `false positive: ${raw}`).toBe(false);
    }
  });

  it('renders as a failure card, with the raw string behind the disclosure', () => {
    const out = failureCopyFor('Rejected: unknown form tool.', COPY);
    expect(out).toEqual({
      text: 'NOTHING WAS SENT',
      errorDetails: 'Rejected: unknown form tool.',
    });
  });

  it('a tool error still wins its own copy', () => {
    const raw = 'Error invoking tool with kwargs {"a": 1}';
    expect(looksLikeToolError(raw)).toBe(true);
    expect(failureCopyFor(raw, COPY)?.text).toBe('TOOL ERROR COPY');
  });

  it('an ordinary reply is not a failure at all', () => {
    expect(failureCopyFor('Here is the review for your job change.', COPY)).toBeNull();
  });
});

/** Registry copy templates carry {count} and a {s} plural suffix. */
describe('applyCountCopy', () => {
  it('pluralizes without a verb-agreement problem', () => {
    const t = '{count} item{s} to fix - see the form.';
    expect(applyCountCopy(t, 1)).toBe('1 item to fix - see the form.');
    expect(applyCountCopy(t, 3)).toBe('3 items to fix - see the form.');
    expect(applyCountCopy(t, 0)).toBe('0 items to fix - see the form.');
  });

  it('leaves a template with no tokens alone', () => {
    expect(applyCountCopy('Something needs attention.', 2))
      .toBe('Something needs attention.');
  });
});
