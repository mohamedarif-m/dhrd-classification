/**
 * IS THIS SIDE-CHANNEL ROW SET STILL THE ONE THIS CONTRACT DECLARES?
 *
 * The full row set for a source is fetched out of band and cached by the host
 * for hours. The contract that declares the COLUMNS ships with the form, fresh,
 * every time. So the two can disagree: import tools that add a column, and the
 * cache keeps serving rows built for the old column list until the TTL expires.
 *
 * Padding a short row (see `rowCells`) fixes exactly one shape of that
 * disagreement - a column appended at the END. It does nothing for a column
 * inserted in the MIDDLE, which is the shape that actually shipped: the
 * employee picker's columns became
 * [worker, title, manager, PENDING, id], so a cached 4-cell row
 * [worker, title, manager, id] pads to five and renders the EMPLOYEE ID under
 * the "Pending" header with the Employee ID column blank. Every value from the
 * insertion point on is one column out and every one of them looks plausible.
 *
 * There is no way to tell, from the rows alone, which cells are misplaced. So
 * the engine does not guess: a row set that does not match the contract is NOT
 * TRUSTED, full stop. The field falls back to the state it already has for "the
 * side channel has not landed" - the contract's inline starter rows, the
 * pending/failed note - and the fetch is re-issued with a cache bust.
 *
 * A wrong number on the screen under a header the user believes is a worse
 * outcome than a short list or a spinner, because only the first one is
 * invisible to the person acting on it.
 */

import type { TableColumn, TableRow } from './contract';

export type RowsVerdict =
  /** Safe to render; `rows` are aligned to the contract's declared columns. */
  | { trusted: true; rows: TableRow[] }
  /** Refuse the payload. `reason` is diagnostic only - never user-facing copy. */
  | { trusted: false; reason: string };

/**
 * Check a FETCHED row set against the columns the contract declares, and align
 * it when the payload says which columns it was built for.
 *
 * Three cases, in order:
 *
 * 1. NO DECLARED COLUMNS (a combobox or a side-channel hierarchy - they read
 *    named cell indexes, not a column grid). Nothing to check against; the rows
 *    pass through untouched, exactly as before this check existed.
 *
 * 2. THE PAYLOAD NAMES ITS COLUMNS (`RemoteOptions.columns`). Match by id: each
 *    declared column takes the cell that payload column of the same id sits at.
 *    Reordering and mid-list insertion both stop mattering. The payload is
 *    refused if it repeats an id, if it is missing an id the contract declares,
 *    or if any row is not exactly as wide as the payload's own column list -
 *    each of those means the rows are not the rows those ids describe.
 *
 * 3. THE PAYLOAD IS BARE. All the engine can compare is width: every row must
 *    have exactly one cell per declared column. A single row of the wrong width
 *    condemns the WHOLE set, because rows are built by one tool in one shape -
 *    one stale row means a stale payload, and the rest of it is only silently
 *    wrong rather than detectably wrong.
 *
 * Inline starter rows never come through here: they ship inside the contract
 * that declares the columns, so they cannot be stale. `rowCells` remains their
 * last-resort normalizer.
 */
export function verifyRows(
  rows: TableRow[],
  columns?: TableColumn[],
  payloadColumns?: string[],
): RowsVerdict {
  const declared = columns ?? [];
  if (!declared.length) return { trusted: true, rows };

  if (payloadColumns && payloadColumns.length) {
    const at = new Map<string, number>();
    for (let i = 0; i < payloadColumns.length; i += 1) {
      const id = payloadColumns[i];
      if (at.has(id)) {
        return { trusted: false, reason: `payload repeats column id "${id}"` };
      }
      at.set(id, i);
    }
    const missing = declared.filter((c) => !at.has(c.id)).map((c) => c.id);
    if (missing.length) {
      return {
        trusted: false,
        reason: `payload columns [${payloadColumns.join(', ')}] are missing `
          + `declared column(s) [${missing.join(', ')}]`,
      };
    }
    const width = payloadColumns.length;
    const bad = rows.find((r) => r.cells.length !== width);
    if (bad) {
      return {
        trusted: false,
        reason: `row "${bad.key}" has ${bad.cells.length} cells for `
          + `${width} payload columns`,
      };
    }
    // Re-seat every cell under the column the payload said it belongs to. A
    // contract column the payload carries but this contract does not declare is
    // simply dropped - it has no header to render under.
    return {
      trusted: true,
      rows: rows.map((r) => ({
        ...r,
        cells: declared.map((c) => r.cells[at.get(c.id) as number] ?? ''),
      })),
    };
  }

  const bad = rows.find((r) => r.cells.length !== declared.length);
  if (bad) {
    return {
      trusted: false,
      reason: `row "${bad.key}" has ${bad.cells.length} cells for `
        + `${declared.length} declared columns`,
    };
  }
  return { trusted: true, rows };
}
