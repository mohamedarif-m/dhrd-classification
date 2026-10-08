import { useState } from 'react';
import { formatRelative } from '../../form-engine';
import type { ThreadRow } from '../lib/chat/liveTypes';
import { threadDisplayTitle } from '../lib/view/threadTitle';

/** Thread timestamps ride the wire as epoch seconds; the formatters take ISO. */
const isoOf = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toISOString();

/** The server caps a thread title at 80 characters. */
export const TITLE_MAX_LENGTH = 80;

/**
 * What a commit attempt actually produces: the title to save, or null when
 * there is nothing to do (blank, whitespace-only, or unchanged). Pure so the
 * rename semantics are testable without a DOM.
 */
export function commitTitle(draft: string, current?: string | null): string | null {
  const title = draft.trim().slice(0, TITLE_MAX_LENGTH);
  if (!title) return null;
  if (title === (current ?? '')) return null;
  return title;
}

/**
 * The in-row title editor. Enter or the check button commits; Escape cancels;
 * BLUR CANCELS TOO - an accidental commit is worse than a lost keystroke, so
 * the only ways to save are deliberate ones. The check button suppresses the
 * default mousedown so its own click is not eaten by the blur-cancel.
 */
export function ThreadRenameEditor({ value, onChange, onCommit, onCancel }: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="sidebar-thread-edit">
      <input
        className="sidebar-thread-edit-input"
        aria-label="Chat name"
        value={value}
        maxLength={TITLE_MAX_LENGTH}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onCommit(); }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        onBlur={onCancel}
      />
      <button
        type="button"
        className="sidebar-thread-edit-ok"
        aria-label="Save chat name"
        title="Save"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onCommit}
      >
        ✓
      </button>
    </div>
  );
}

/** Chat history for the workspace sidebar. */
export function ThreadList({ threads, activeThread, onOpen, onRename, onNew, agentName }: {
  threads: ThreadRow[];
  activeThread: string | null;
  onOpen: (id: string) => void;
  /** Fired with the row and the already-trimmed new title. */
  onRename: (row: ThreadRow, newTitle: string) => void;
  onNew: () => void;
  /**
   * Name of the agent these threads belong to, used to build a readable label
   * for a thread the server titled with a placeholder. Absent falls back to
   * the old literal title, so a host that does not pass it is unaffected.
   */
  agentName?: string;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const cancel = () => { setEditingId(null); setDraft(''); };
  const commit = (row: ThreadRow) => {
    const title = commitTitle(draft, row.title);
    cancel();
    if (title) onRename(row, title);
  };

  return (
    <div className="sidebar-group">
      <h2 className="sidebar-heading">Chats</h2>
      <button type="button" className="sidebar-item sidebar-item--new" onClick={onNew}>
        <span className="sidebar-item-name">+ New chat</span>
      </button>
      {threads.map((t) => (
        <div
          key={t.thread_id}
          className={`sidebar-item sidebar-thread${t.thread_id === activeThread ? ' sidebar-item--active' : ''}`}
        >
          {editingId === t.thread_id ? (
            <ThreadRenameEditor
              value={draft}
              onChange={setDraft}
              onCommit={() => commit(t)}
              onCancel={cancel}
            />
          ) : (
            <>
              <button type="button" className="sidebar-thread-open" onClick={() => onOpen(t.thread_id)}>
                {/* "start" is what the platform titles almost every thread in
                    this product, because "start" is what the welcome copy asks
                    the reader to type. A column of identical rows is not a
                    history; see lib/view/threadTitle. */}
                <span className="sidebar-item-name">
                  {agentName
                    ? threadDisplayTitle(t.title, agentName, isoOf(t.updated_at))
                    : (t.title || 'Untitled chat')}
                </span>
                <span className="sidebar-item-tag">
                  {formatRelative(isoOf(t.updated_at))}
                </span>
              </button>
              <button
                type="button"
                className="sidebar-thread-rename"
                aria-label="Rename chat"
                onClick={() => {
                  // Seeded from what the row SHOWS, not from what is stored: a
                  // reader editing "Job Change - Aug 13, 2:41 PM" should get
                  // that to edit, not the placeholder "start" behind it.
                  setDraft(agentName
                    ? threadDisplayTitle(t.title, agentName, isoOf(t.updated_at))
                    : (t.title || ''));
                  setEditingId(t.thread_id);
                }}
              >
                Rename
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
