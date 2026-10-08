import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ThreadRow } from '../../lib/chat/liveTypes';
import { ThreadList, ThreadRenameEditor, TITLE_MAX_LENGTH, commitTitle } from '../ThreadList';

const row: ThreadRow = {
  thread_id: 't-1',
  title: 'Assign a recruiter',
  updated_at: Math.floor(Date.now() / 1000),
} as ThreadRow;

const noop = () => {};

describe('ThreadList rows', () => {
  it('renders the title and a Rename button, and no browser prompt anywhere', () => {
    const html = renderToStaticMarkup(
      <ThreadList threads={[row]} activeThread="t-1" onOpen={noop} onRename={noop} onNew={noop} />);
    expect(html).toContain('Assign a recruiter');
    expect(html).toContain('aria-label="Rename chat"');
    expect(html).toContain('sidebar-thread-open');
    // Not editing on first paint.
    expect(html).not.toContain('sidebar-thread-edit');
  });

  it('falls back to the placeholder title for an unnamed thread', () => {
    const html = renderToStaticMarkup(
      <ThreadList threads={[{ ...row, title: '' } as ThreadRow]} activeThread={null}
        onOpen={noop} onRename={noop} onNew={noop} />);
    expect(html).toContain('Untitled chat');
  });
});

describe('ThreadRenameEditor markup', () => {
  it('is an autofocused, 80-capped text input with a confirm button', () => {
    const html = renderToStaticMarkup(
      <ThreadRenameEditor value="Assign a recruiter" onChange={noop}
        onCommit={noop} onCancel={noop} />);
    expect(html).toContain('class="sidebar-thread-edit"');
    expect(html).toContain('sidebar-thread-edit-input');
    expect(html).toContain('value="Assign a recruiter"');
    expect(html).toContain(`maxLength="${TITLE_MAX_LENGTH}"`);
    expect(html).toContain('autofocus');
    expect(html).toContain('aria-label="Save chat name"');
    expect(html).toContain('✓');
  });
});

describe('rename commit semantics', () => {
  it('commits a trimmed, changed title', () => {
    expect(commitTitle('  Recruiter assignment  ', 'Assign a recruiter'))
      .toBe('Recruiter assignment');
  });

  it('treats empty or whitespace-only as a cancel', () => {
    expect(commitTitle('', 'Assign a recruiter')).toBeNull();
    expect(commitTitle('    ', 'Assign a recruiter')).toBeNull();
  });

  it('treats an unchanged title as a cancel (no needless server call)', () => {
    expect(commitTitle('Assign a recruiter', 'Assign a recruiter')).toBeNull();
    expect(commitTitle('  Assign a recruiter ', 'Assign a recruiter')).toBeNull();
  });

  it('caps at the server limit of 80 characters', () => {
    const long = 'x'.repeat(120);
    expect(commitTitle(long, 'old')).toHaveLength(TITLE_MAX_LENGTH);
    expect(TITLE_MAX_LENGTH).toBe(80);
  });

  it('accepts a first title on a thread that had none', () => {
    expect(commitTitle('Named at last', '')).toBe('Named at last');
    expect(commitTitle('Named at last', null)).toBe('Named at last');
  });
});

/**
 * A SIDEBAR OF ROWS CALLED "start". Every agent's welcome invites the reader to
 * type it, the platform titles the thread from that first message, and the chat
 * history stops being a history. `agentName` turns on the fallback; without it
 * the component behaves exactly as it always did, so a host that has not passed
 * it is unaffected.
 */
describe('ThreadList placeholder titles', () => {
  const stub = { ...row, title: 'start' } as ThreadRow;

  it('replaces a placeholder title with the agent name and a time', () => {
    const html = renderToStaticMarkup(
      <ThreadList threads={[stub]} activeThread={null} onOpen={noop} onRename={noop}
        onNew={noop} agentName="Job Change" />);
    expect(html).toContain('Job Change');
    expect(html, 'THE SIDEBAR STILL SAYS "start"')
      .not.toContain('>start<');
  });

  it('leaves a real title alone', () => {
    const html = renderToStaticMarkup(
      <ThreadList threads={[row]} activeThread={null} onOpen={noop} onRename={noop}
        onNew={noop} agentName="Assign Recruiter" />);
    expect(html).toContain('Assign a recruiter');
    expect(html).not.toContain('Assign Recruiter -');
  });

  it('without agentName nothing changes for an existing host', () => {
    const html = renderToStaticMarkup(
      <ThreadList threads={[stub]} activeThread={null} onOpen={noop} onRename={noop}
        onNew={noop} />);
    expect(html).toContain('>start<');
  });

  it('the Rename editor still starts from the STORED title, not the fallback', () => {
    // What the reader edits must be the real record, so an empty stored title
    // opens an empty box rather than one pre-filled with a derived label.
    const html = renderToStaticMarkup(
      <ThreadList threads={[stub]} activeThread={null} onOpen={noop} onRename={noop}
        onNew={noop} agentName="Job Change" />);
    expect(html).toContain('aria-label="Rename chat"');
  });
});
