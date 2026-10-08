/**
 * Stream normalizer against the LIVE captured fixture (JobReq_C on
 * tko-pilot-wxo, 2026-07-30). The trimmed fixture preserves every event
 * envelope and meta path exactly as captured; only giant option lists were
 * shortened.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { WireEvent } from '../../chat/liveTypes';
import { createSseParser, normalizeEvent, thinkingCopyFor } from '../streamNormalizer';
import {
  CONTRACT_META_KEY,
  DOWNLOAD_META_KEY,
  extractAttachment,
  extractMeta,
} from '../toolMeta';

const fixturePath = fileURLToPath(new URL(
  '../../../../../../../docs/fixtures/jrc-start-stream-trimmed.ndjson', import.meta.url));
const fixtureEvents: WireEvent[] = readFileSync(fixturePath, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('normalizeEvent on the live capture', () => {
  const normalized = fixtureEvents.flatMap(normalizeEvent);

  it('sees the run start with thread and run ids', () => {
    const start = normalized.find((e) => e.kind === 'run-started');
    expect(start).toBeTruthy();
    expect(start && 'threadId' in start && start.threadId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('emits platform thinking lines from run.step.intermediate', () => {
    const thinking = normalized.filter((e) => e.kind === 'thinking');
    expect(thinking.length).toBeGreaterThanOrEqual(5);
    expect(thinking[0]).toMatchObject({ text: expect.stringContaining('processing') });
  });

  it('surfaces the tool call with its agent display name', () => {
    const call = normalized.find((e) => e.kind === 'tool-call');
    expect(call).toMatchObject({
      tool: 'jrc_widget_start',
      agent: 'Job Requisition (Custom UI)',
    });
  });

  it('extracts the Form Contract with contract-carried submitTool and todayIso', () => {
    const forms = normalized.filter((e) => e.kind === 'form');
    expect(forms.length).toBeGreaterThanOrEqual(1);
    const form = forms[0] as Extract<(typeof forms)[number], { kind: 'form' }>;
    expect(form.form.contract.id).toBe('jobreq-entry');
    expect(form.form.contract.sections.map((s) => s.id))
      .toEqual(['basics', 'organization', 'location', 'compensation', 'documents']);
    // Post-diet: the submit tool is CONTRACT data (legacy widget meta is gone).
    expect(form.form.submitTool).toBe('jrc_validate');
    expect(form.form.contract.submitTool).toBe('jrc_validate');
    // Authoritative business "today" rides on the contract.
    expect(form.form.contract.todayIso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the diet stream carries no legacy widget meta anywhere', () => {
    const raw = readFileSync(fixturePath, 'utf8');
    expect(raw).not.toContain('com.ibm.orchestrate/widget');
  });

  it('multi-controller exclude (string[]) survives normalization intact', () => {
    const forms = normalized.filter((e) => e.kind === 'form');
    const form = forms[0] as Extract<(typeof forms)[number], { kind: 'form' }>;
    const location = form.form.contract.sections.find((s) => s.id === 'location');
    const posting = location?.fields.find((f) => f.id === 'posting_locations');
    expect(posting?.behaviors?.exclude?.controllerField)
      .toEqual(['location', 'primary_posting_location']);
  });

  it('captures the assistant text and final message with server timestamp', () => {
    const text = normalized.find((e) => e.kind === 'text');
    expect(text && 'text' in text && text.text).toContain('job requisition form');
    const final = normalized.find((e) => e.kind === 'final-message');
    expect(final).toMatchObject({ isAsync: false, createdOn: expect.stringContaining('2026-') });
  });

  it('terminates on run.completed/done', () => {
    expect(normalized.filter((e) => e.kind === 'completed').length).toBeGreaterThanOrEqual(1);
  });

  it('ignores unknown event types without erroring', () => {
    expect(normalizeEvent({ event: 'totally.unknown', data: { x: 1 } })).toEqual([]);
  });
});

describe('run.pending (proxy-synthesized timeout signal)', () => {
  it('maps to a run-pending event carrying the run id', () => {
    expect(normalizeEvent({ event: 'run.pending', data: { run_id: 'r-42' } }))
      .toEqual([{ kind: 'run-pending', runId: 'r-42' }]);
  });

  it('survives a run.pending with no run id', () => {
    expect(normalizeEvent({ event: 'run.pending', data: {} }))
      .toEqual([{ kind: 'run-pending', runId: undefined }]);
  });

  it('does not terminate the stream (done still completes it)', () => {
    expect(normalizeEvent({ event: 'done', data: {} }))
      .toEqual([{ kind: 'completed' }]);
  });
});

describe('contract meta reader (contract-only, no widget path)', () => {
  it('reads submitTool from the contract itself; wrapper submit_tool is secondary', () => {
    const contract = {
      version: 1, id: 'c1', title: 'Contract form', submitTool: 'jrc_validate',
      sections: [{ id: 's', title: 'S', fields: [] }],
    };
    const form = extractMeta({
      [CONTRACT_META_KEY]: { contract, submit_tool: 'wrapper_tool' },
    } as never);
    expect(form?.contract.id).toBe('c1');
    expect(form?.submitTool).toBe('jrc_validate');
  });

  it('accepts a bare FormContract at the contract key', () => {
    const meta = {
      [CONTRACT_META_KEY]: {
        version: 1, id: 'bare', title: 'Bare', submitTool: 'jrc_submit',
        sections: [{ id: 's', title: 'S', fields: [] }],
      },
    };
    const form = extractMeta(meta as never);
    expect(form?.contract.id).toBe('bare');
    expect(form?.submitTool).toBe('jrc_submit');
  });

  /**
   * The reader casts the meta payload to a FormContract rather than rebuilding
   * it field by field, so tool-authored contract keys survive normalization
   * untouched. `fresh` is the one whose LOSS would be silent and expensive: a
   * dropped flag turns "start over" back into a merge of the abandoned attempt
   * (spec jobreq-chaos CV-3), with nothing failing anywhere else.
   */
  it('passes tool-authored contract flags (fresh) through untouched', () => {
    const wrapped = extractMeta({
      [CONTRACT_META_KEY]: {
        contract: {
          version: 1, id: 'jobreq-entry', title: 'Job requisition', fresh: true,
          submitTool: 'jrc_validate', sections: [{ id: 's', title: 'S', fields: [] }],
        },
      },
    } as never);
    expect(wrapped?.contract.fresh).toBe(true);

    const bare = extractMeta({
      [CONTRACT_META_KEY]: {
        version: 1, id: 'jobreq-entry', title: 'Job requisition', fresh: true,
        submitTool: 'jrc_validate', sections: [{ id: 's', title: 'S', fields: [] }],
      },
    } as never);
    expect(bare?.contract.fresh).toBe(true);

    // ...and a contract that does not declare it stays undefined, never false
    // by construction: absence is what every merging re-render sends.
    const plain = extractMeta({
      [CONTRACT_META_KEY]: {
        version: 1, id: 'jobreq-entry', title: 'Job requisition',
        submitTool: 'jrc_validate', sections: [{ id: 's', title: 'S', fields: [] }],
      },
    } as never);
    expect(plain?.contract.fresh).toBeUndefined();
  });

  it('a legacy widget meta alone yields NO form (that read path is deleted)', () => {
    const meta = {
      'com.ibm.orchestrate/widget': {
        response_type: 'forms',
        json_schema: { properties: { title: { type: 'string' } } },
        on_event: [{ tool: 'jrc_validate' }],
      },
    };
    expect(extractMeta(meta as never)).toBeNull();
  });
});

describe('SSE parser (proxy frame format)', () => {
  it('parses frames split across chunks and skips heartbeats', () => {
    const seen: WireEvent[] = [];
    const parser = createSseParser((ev) => seen.push(ev));
    parser.push('event: run.started\ndata: {"event": "run.st');
    parser.push('arted", "data": {"run_id": "r1"}}\n\n: hb\n\n');
    parser.push('event: done\ndata: {"event": "done", "data": {}}\n\n');
    expect(seen.map((e) => e.event)).toEqual(['run.started', 'done']);
  });
});

describe('thinking copy tiers', () => {
  const registryCopy = { jrc_widget_start: 'Loading the form lists...' };
  const tools = { jrc_widget_review: { display_name: 'JRC Widget Review' } };

  it('tier 1: registry copy per tool', () => {
    expect(thinkingCopyFor('jrc_widget_start', registryCopy, tools))
      .toBe('Loading the form lists...');
  });
  it('tier 2: display name from the tools API', () => {
    expect(thinkingCopyFor('jrc_widget_review', registryCopy, tools))
      .toBe('Running JRC Widget Review...');
  });
  it('tier 3: prettified tool name', () => {
    expect(thinkingCopyFor('jrc_widget_comp', registryCopy, tools))
      .toBe('Running jrc widget comp...');
  });
});

describe('download attachment meta reader', () => {
  const payload = {
    filename: 'corrected.xlsx',
    base64: 'UEsDBBQA',
    mimeType: 'application/vnd.ms-excel',
    note: 'Two rows were corrected.',
  };

  it('reads a well-formed payload without decoding the bytes', () => {
    expect(extractAttachment({ [DOWNLOAD_META_KEY]: payload } as never)).toEqual(payload);
  });

  it('keeps mimeType and note optional', () => {
    const attachment = extractAttachment({
      [DOWNLOAD_META_KEY]: { filename: 'a.xlsx', base64: 'AAAA' },
    } as never);
    expect(attachment).toEqual({ filename: 'a.xlsx', base64: 'AAAA' });
  });

  it('yields undefined with no meta, no key, or a non-object payload', () => {
    expect(extractAttachment(null)).toBeUndefined();
    expect(extractAttachment({ [CONTRACT_META_KEY]: {} } as never)).toBeUndefined();
    expect(extractAttachment({ [DOWNLOAD_META_KEY]: 'nope' } as never)).toBeUndefined();
  });

  it('yields undefined for a malformed payload', () => {
    const bad = [
      { filename: 'a.xlsx' },                       // no base64
      { filename: 'a.xlsx', base64: '' },           // empty base64
      { base64: 'AAAA' },                           // no filename
      { filename: 12, base64: 'AAAA' },             // non-string filename
      { filename: 'a.xlsx', base64: ['AAAA'] },     // non-string base64
    ];
    for (const p of bad) {
      expect(extractAttachment({ [DOWNLOAD_META_KEY]: p } as never)).toBeUndefined();
    }
  });
});

describe('an attachment rides with the form it arrived with', () => {
  const contractFor = (id: string) => ({
    version: 1, id, title: id, submitTool: 'jrc_create',
    sections: [{ id: 's', title: 'S', fields: [] }],
  });

  const deltaEvent = (meta: Record<string, unknown>): WireEvent => ({
    event: 'run.step.delta',
    data: {
      delta: {
        step_details: [
          { type: 'tool_response', content: JSON.stringify({ _meta: meta, content: [] }) },
        ],
      },
    },
  });

  const formsFrom = (ev: WireEvent) => normalizeEvent(ev)
    .filter((e): e is Extract<typeof e, { kind: 'form' }> => e.kind === 'form');

  it('attaches the file to the form in the same meta block', () => {
    const [form] = formsFrom(deltaEvent({
      [CONTRACT_META_KEY]: contractFor('with-file'),
      [DOWNLOAD_META_KEY]: { filename: 'corrected.xlsx', base64: 'UEsDBBQA' },
    }));
    expect(form.form.contract.id).toBe('with-file');
    expect(form.form.attachment).toEqual({ filename: 'corrected.xlsx', base64: 'UEsDBBQA' });
  });

  it('a later attachment-free form does not inherit it', () => {
    formsFrom(deltaEvent({
      [CONTRACT_META_KEY]: contractFor('with-file'),
      [DOWNLOAD_META_KEY]: { filename: 'corrected.xlsx', base64: 'UEsDBBQA' },
    }));
    const [next] = formsFrom(deltaEvent({ [CONTRACT_META_KEY]: contractFor('plain') }));
    expect(next.form.contract.id).toBe('plain');
    expect(next.form.attachment).toBeUndefined();
  });

  it('an attachment with no contract yields no form event', () => {
    expect(formsFrom(deltaEvent({
      [DOWNLOAD_META_KEY]: { filename: 'corrected.xlsx', base64: 'UEsDBBQA' },
    }))).toHaveLength(0);
  });
});


describe('the auto-continue instruction', () => {
  const contract = {
    version: 1, id: 'eib-progress', title: 'Loading in progress', sections: [],
    review: { rows: [{ label: 'Loaded so far', value: '12 of 40', sectionId: 'p' }],
      confirmTokens: { submit: 'Continue loading', cancel: 'Back to the workbook' } },
    submitTool: 'eibc_submit',
  };
  const withMeta = (meta: Record<string, unknown>) => normalizeEvent({
    event: 'run.step.delta',
    data: { delta: { step_details: [{ type: 'tool_response', name: 'eibc_submit',
      content: JSON.stringify({ _meta: meta,
        content: [{ type: 'text', text: 'Loaded 12 of 40 - continuing.' }] }) }] } },
  });

  it('rides the form event it arrived with', () => {
    const events = withMeta({
      'tko/form-contract@v1': contract,
      'tko/auto-continue@v1': {
        tool: 'eibc_submit',
        args: { stage_token: 'tok', confirm_action: 'Continue loading' },
        delayMs: 1200,
      },
    });
    const form = events.find((e) => e.kind === 'form');
    expect(form).toBeDefined();
    expect(form && 'autoContinue' in form ? form.autoContinue : null).toEqual({
      tool: 'eibc_submit',
      args: { stage_token: 'tok', confirm_action: 'Continue loading' },
      delayMs: 1200,
    });
  });

  it('is absent when the tool did not ask for one', () => {
    const events = withMeta({ 'tko/form-contract@v1': contract });
    const form = events.find((e) => e.kind === 'form');
    expect(form && 'autoContinue' in form ? form.autoContinue : undefined)
      .toBeUndefined();
  });
});
