import { useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import type { Field, FormValues } from '../lib/contract';
import { rowCells } from '../lib/contract';
import { LIST_RENDER_CAP } from '../lib/config';
import { visibleRows } from '../lib/behaviors';
import { useRemoteRows } from '../lib/useRemoteRows';

interface Props {
  field: Field;
  value: string | null;
  invalid: boolean;
  /** Whole-form values; only the `rowFilter` controller is read. */
  values: FormValues;
  onChange: (rowKey: string | null) => void;
  onBlur: () => void;
}

/** Distance from the bottom of the scroll box that reveals the next page. */
const SCROLL_REVEAL_PX = 200;

/** Searchable single-select table (worker-style rows). */
export function TableField({ field, value, invalid, values, onChange, onBlur }: Props) {
  const [query, setQuery] = useState('');
  const columns = field.columns ?? [];
  // `selectable: false` is a DISPLAY table: same chrome, same search, but the
  // pick column and every path to a selection are gone (contract.ts).
  const selectable = field.selectable !== false;
  const colSpan = selectable ? columns.length + 1 : columns.length;

  // Out-of-band full row set. Until it resolves - and forever if it fails or no
  // host provider exists - the contract's starter rows are what renders.
  const { rows: fetched, state: fetchState, note, retry } = useRemoteRows(field);

  /**
   * The held row the fetched set does not contain, or null when there is
   * nothing to carry. Kept SEPARATE from the row set so that the row filter
   * below narrows the fetched rows only; see the note there.
   */
  const carried = useMemo(() => {
    const starter = field.rows ?? [];
    // THE CURRENT VALUE SURVIVES THE SWAP - the same guarantee Combobox makes,
    // and it was missing here.
    //
    // The fetched set REPLACED the starter rows wholesale, so a held value the
    // full set happens not to contain simply stopped being on screen. The form
    // went on HOLDING it and SUBMITTING it: measured 2026-08-13, the envelope
    // carried "Morgan Fields (E90005)" while that name appeared nowhere in the
    // rendered table. A picker that submits what it does not show is the one
    // thing a picker must never do - on this product the hidden value is an
    // employee, a plan or an organization.
    //
    // Carried PLAIN, with no marker, exactly as Combobox carries it: the row
    // is a real choice the tool put there, the user can see it, select it and
    // change it, and annotating it would invent a distinction the tool never
    // made. The original starter row is reused when there is one, so its cells
    // are the real ones; a value with no row anywhere still gets a row rather
    // than a hole, keyed by the value with the remaining columns blank.
    // NO FETCH IS NOT A REASON TO HIDE THE VALUE EITHER. `fetched` is null both
    // before a side-channel load resolves and forever when the field declares no
    // source at all; in that state the starter rows are the whole world, and a
    // value they do not contain (a prefill, an edit round carrying a row the
    // tool did not re-send) had nothing showing it. Same defect, same rule.
    const live = fetched ?? starter;
    if (!value || live.some((r) => r.key === value)) return null;
    const held = starter.find((r) => r.key === value);
    if (held) return held;
    const width = (field.columns ?? []).length || 1;
    const cells = Array.from({ length: width }, (_, i) => (i === 0 ? value : ''));
    return { key: value, cells };
  }, [fetched, field.rows, field.columns, value]);

  const allRows = useMemo(() => fetched ?? field.rows ?? [], [fetched, field.rows]);
  /**
   * Order of operations: rowFilter narrows the LIVE row set first (starter rows
   * or the swapped-in full set - tags ride the rows either way), then the search
   * query, then the render cap.
   *
   * THE HELD ROW IS SHOWN WHATEVER THE FILTER SAYS. Until 2026-08-13 this file
   * argued the opposite, and the argument was: a row the filter drops keeps its
   * value but is not force-shown, because "the user just toggled the control
   * that hid it, and unticking brings it back". The wave-2 field campaign
   * overturned it. Repro, on Assign Recruiter: pick a requisition under
   * "Unassigned", then flip the filter to "Assigned". The picker now renders
   * with NOTHING selected - no checked radio, no highlighted row - while the
   * form still holds the value and the review that follows proposes a
   * requisition the reader never saw on screen.
   *
   * That is the same defect as the fetch-absence case one block up, reached by a
   * different door, and it fails the same rule: A PICKER MUST NOT SUBMIT WHAT IT
   * DOES NOT SHOW. On this product the unseen value is an employee, a plan or an
   * organization. "Untick to see it again" is not a defence when the screen
   * gives the reader no reason to suspect there is anything to untick FOR.
   *
   * THE RESURRECT GUARD IS UNTOUCHED, and the distinction it draws still holds
   * exactly. A held row that the filter drops is shown BECAUSE IT IS HELD - it
   * is the answer this form currently carries, and the reader is entitled to see
   * the thing they are about to submit. An UNHELD row the filter drops stays
   * hidden: nothing is riding on it, so the toggle means what it says. The guard
   * in `carried` above enforces the other half - a row the fetched set already
   * holds is never prepended a SECOND time - which is why the held row below is
   * taken from `allRows` rather than from the starter set: one row, current
   * cells, shown once.
   */
  const rows = useMemo(() => {
    const filtered = visibleRows(field, values, allRows);
    if (carried) return [carried, ...filtered];
    if (!value || filtered.some((r) => r.key === value)) return filtered;
    const held = allRows.find((r) => r.key === value);
    return held ? [held, ...filtered] : filtered;
  }, [field, values, allRows, carried, value]);

  /**
   * THE ROW SET NEVER REORDERS UNDER THE READER'S OWN CLICK.
   *
   * The pin below floats the current value to the top of the default view. It
   * used to key off `value` alone, which meant it re-ran on EVERY pick: inside
   * a 260px scroll box (engine.css `.fe-table-scroll`) the row the reader had
   * just clicked teleported to index 0, off screen, and a DIFFERENT row slid
   * into the space under the cursor. Measured 2026-08-14: click row 40 (Kai
   * Reed) and the checked row jumps to the top out of view while row 40 now
   * reads "Jordan Porter" - which reads as a dead click, and invites a second
   * click that lands on someone else entirely.
   *
   * So the pin is a FIRST-PAINT affordance for an INCOMING value (a prefill, an
   * edit round, restored browser state): the reader did not put that value
   * there and has no idea where in 1700 rows it lives, so the component floats
   * it. A value the reader picked HERE needs no floating - they are looking
   * straight at it - and moving it is pure harm.
   *
   * `pinKeyRef` holds the value that earned a pin. It is refreshed only when
   * the value moves to something this component did not just emit; the pick
   * handlers record what they emit in `userPickRef`. Written during render on
   * purpose: an effect would pin one paint LATE, and the guarantee is that a
   * prefilled row 250 deep is first on the very first paint.
   *
   * THE GUARANTEE THIS ACTUALLY MAKES, and the corner the first cut of the gate
   * reopened: THE CHECKED ROW IS ALWAYS RENDERED SOMEWHERE. Gating the pin on
   * provenance alone lost that for a pick made out of a search result. Repro on
   * a 1712-row org picker: search, tick a row that sits at index 250 of the
   * unsearched list, clear the query. The pin does not apply (the reader picked
   * it), index 250 is past LIST_RENDER_CAP, and the row is not in the DOM at
   * all - an invisible checked row that the form still submits, which is the
   * A PICKER MUST NOT SUBMIT WHAT IT DOES NOT SHOW rule broken by a third door.
   *
   * So the pin has a second, narrower trigger: a value whose row would not be
   * RENDERABLE in the default view is floated whoever put it there. That cannot
   * bring the dead click back, because a row inside the first cap's worth - the
   * only rows a reader can click without searching first - is never eligible.
   * The threshold is the CONSTANT, not the grown `cap`: keying it on the live
   * cap would un-pin the row the moment a scroll revealed the next page, which
   * is the same reorder-under-the-reader defect wearing the opposite sign.
   */
  const pinKeyRef = useRef<string | null>(value);
  const userPickRef = useRef<string | null>(null);
  if (value !== pinKeyRef.current && value !== userPickRef.current) {
    pinKeyRef.current = value;
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      // Default (unsearched) view. Two values earn the top slot, and nothing
      // else does: an INCOMING one (edit round, prefill, held browser state),
      // because the reader did not put it there and cannot know where in 1700
      // rows it sits; and any value whose row falls past the render cap, which
      // would otherwise be checked and completely absent from the DOM.
      if (value) {
        const idx = rows.findIndex((r) => r.key === value);
        const unrenderable = idx >= LIST_RENDER_CAP;
        if (idx > 0 && (pinKeyRef.current === value || unrenderable)) {
          return [rows[idx], ...rows.slice(0, idx), ...rows.slice(idx + 1)];
        }
      }
      return rows;
    }
    // While searching, normal filtering order applies (the selected row still
    // shows its checked state whenever it matches).
    return rows.filter((r) => r.cells.some((c) => c.toLowerCase().includes(q)));
  }, [rows, query, value]);

  // Live tables reach 1700+ rows; the DOM holds one page at a time and grows as
  // the user scrolls, so every row is reachable by scrolling alone.
  const [cap, setCap] = useState(LIST_RENDER_CAP);
  useEffect(() => { setCap(LIST_RENDER_CAP); }, [query, rows]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining <= SCROLL_REVEAL_PX) setCap((c) => c + LIST_RENDER_CAP);
  };

  const visible = filtered.length > cap ? filtered.slice(0, cap) : filtered;

  /** One path for every pick, so the pin above always sees who moved the value. */
  const pick = (key: string) => {
    userPickRef.current = key;
    onChange(key);
    onBlur();
  };

  /**
   * AN EMPTY SEARCH RESULT MUST NOT OVERCLAIM. "No matches" is a statement
   * about the whole list, and it is only true once the whole list is here. A
   * field with an `optionsSource` renders the tool's STARTER rows until the
   * side channel resolves - 30 of 900 on the org picker - and while it is
   * pending, or after it failed, a search ran over that fraction. Saying "No
   * matches" there tells the reader their organization does not exist, when
   * what happened is that it has not loaded. The honest copy names the fraction
   * searched; the retry on the note above (rendered for `failed`) is how the
   * reader gets the rest.
   */
  const loaded = allRows.length;
  const declaredTotal = field.optionsSource?.total;
  const partialSet = !!field.optionsSource && fetchState !== 'ready';
  const emptyCopy = !partialSet
    ? 'No matches'
    : declaredTotal && declaredTotal > loaded
      ? `No matches in the first ${loaded} of ${declaredTotal} rows loaded`
      : `No matches in the ${loaded} rows loaded so far`;

  return (
    <div className={`fe-table-wrap${invalid ? ' fe-table-wrap--invalid' : ''}`}>
      <input
        className="fe-input fe-table-search"
        type="text"
        placeholder={field.placeholder ?? 'Search...'}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {/* State copy is contract data; an unauthored state shows nothing. The
          retry action is the one exception: a failed load must stay
          recoverable even when the contract wrote no failed note. */}
      {(note || fetchState === 'failed') && (
        <p className="fe-table-note">
          {note}
          {fetchState === 'failed' && (
            <button
              type="button"
              className="fe-table-retry"
              onClick={retry}
            >
              {field.optionsSource?.retryLabel ?? 'Try again'}
            </button>
          )}
        </p>
      )}
      <div className="fe-table-scroll" onScroll={onScroll}>
        {/* The display modifier is not cosmetic: the narrow-screen rules below
            640px position the stacked row around a pick cell in column one
            (a 40px gutter, and the bold/muted split keyed off nth-child).
            Without the pick column those rules land one column out. */}
        <table className={`fe-table${selectable ? '' : ' fe-table--display'}`}>
          <thead>
            <tr>
              {selectable && <th className="fe-table-pick" aria-label="Select" />}
              {columns.map((c) => <th key={c.id}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={colSpan} className="fe-table-empty">{emptyCopy}</td></tr>
            )}
            {visible.map((r) => (
              <tr
                key={r.key}
                className={selectable && r.key === value ? 'fe-table-row--selected' : ''}
                /* A SINGLE-SELECT TABLE DOES NOT TOGGLE OFF. Clicking the row
                   used to CLEAR it when it was already the value, which no
                   radio group anywhere behaves like: the reader clicking the
                   row they just chose (to confirm it, or because the first
                   click seemed not to register) silently emptied the field.
                   It also fired on the radio itself by bubbling, so a click on
                   a checked radio cleared it too. Picking the same row again is
                   now idempotent, which makes the bubbled second emit harmless
                   - no stopPropagation needed, and the radio cell keeps working
                   for keyboard users who never produce a row click at all. */
                onClick={selectable ? () => pick(r.key) : undefined}
              >
                {selectable && (
                  <td className="fe-table-pick">
                    <input
                      type="radio"
                      name={field.id}
                      checked={r.key === value}
                      onChange={() => pick(r.key)}
                    />
                  </td>
                )}
                {/* ONE CELL PER DECLARED COLUMN, always. A row that is short
                    pads with blanks on the right instead of letting the
                    values that follow slide left under the wrong heading -
                    the live defect on the employee picker, where a worker
                    with no manager rendered their employee id under Manager
                    and left the ID column empty. Extra cells are ignored,
                    never appended. */}
                {rowCells(r, columns).map((c, i) => <td key={i}>{c}</td>)}
              </tr>
            ))}
            {filtered.length > visible.length && (
              <tr>
                <td colSpan={colSpan} className="fe-table-empty">
                  Showing {visible.length} of {filtered.length} - scroll for more
                  or keep typing to narrow
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
