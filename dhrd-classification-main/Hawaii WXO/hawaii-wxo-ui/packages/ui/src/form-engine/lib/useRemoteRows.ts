/**
 * The one place a field asks the host for its out-of-band row set.
 *
 * Both controls that read the options side channel - the searchable table and
 * the side-channel hierarchy - share this hook, so they share one fetch policy,
 * one set of contract-authored state notes and one retry affordance. No source
 * on the field, or no host provider, means no fetch and no behavior change.
 */

import { useEffect, useState } from 'react';
import type { Field, Option, OptionsSourceSpec, TableRow } from './contract';
import { useOptionsProvider } from './optionsProvider';
import { verifyRows } from './rowIntegrity';

export type FetchState = 'idle' | 'pending' | 'ready' | 'failed';

export interface RemoteRows {
  /** Fetched rows, or null while pending / when there is nothing to fetch. */
  rows: TableRow[] | null;
  state: FetchState;
  /** Contract-authored copy for the current state; undefined when unauthored. */
  note?: string;
  /** Re-runs the fetch; the failed state is always recoverable. */
  retry: () => void;
}

/**
 * Side-channel rows -> combobox options.
 *
 * The side channel serves ONE row shape (`{key, cells}`) whatever control is
 * reading it, so a tool can point a dropdown and a table at the same source and
 * the host serves it once. Which cell reads as the label - and which, if any,
 * as the secondary text - is contract data (`OptionsSourceSpec.labelCell` /
 * `descriptionCell`), because only the tool knows what its own columns mean.
 *
 * The option KEY is the row's own key unless `valueCell` names a cell, which is
 * the same rule the side-channel hierarchy already follows: the key is the
 * server's canonical option string and the thing that rides the envelope.
 *
 * A cell index names a DECLARED POSITION, so a row too short to reach it
 * yields NOTHING for that position - the label falls back to the key and the
 * description is simply absent. It never reaches further along and borrows the
 * next value, which is the same rule the table renderer follows when it pads a
 * short row (see `rowCells`): a missing value stays missing in its own column.
 */
export function optionsFromRows(
  rows: TableRow[], spec?: OptionsSourceSpec,
): Option[] {
  const labelCell = spec?.labelCell ?? 0;
  const descCell = spec?.descriptionCell;
  const valueCell = spec?.valueCell;
  const out: Option[] = [];
  for (const row of rows) {
    const key = valueCell === undefined
      ? row.key
      : (row.cells[valueCell] ?? row.key);
    if (!key) continue;
    const description = descCell === undefined ? undefined : row.cells[descCell];
    out.push({
      key,
      // A row whose label cell is missing still has to be pickable, so the key
      // stands in rather than rendering a blank line the user cannot identify.
      label: row.cells[labelCell] ?? key,
      ...(description ? { description } : {}),
    });
  }
  return out;
}

/**
 * ONE FETCH PER SOURCE, however many fields ask for it.
 *
 * The hook is per FIELD INSTANCE, which was fine while only a table or a
 * hierarchy read the side channel - one or two controls per form. A form that
 * repeats a sourced dropdown per row is a different shape: measured live on the
 * EIB fix form, twelve blocks x three pickers issued 58 `/api/options` requests
 * for the same three lists, and held 36 copies of the rows in memory.
 *
 * So identical (provider, source) pairs share one in-flight promise and one
 * result. Keyed by the provider object as well as the source, because two hosts
 * (or one host that has switched agents) do not share a namespace - and held in
 * a WeakMap so a discarded provider takes its cache with it.
 *
 * A FAILED fetch is evicted rather than remembered. The failed state is
 * user-recoverable by design (every sourced control offers a retry), and a
 * cached null would make that button a no-op for every field on the form.
 */
type SourceCache = Map<string, Promise<RemoteOptionsLike | null>>;
type RemoteOptionsLike = { rows: TableRow[]; total?: number; columns?: string[] };
type ProviderFn = (
  source: string, opts?: { refresh?: boolean },
) => Promise<RemoteOptionsLike | null>;

const sharedFetches = new WeakMap<object, SourceCache>();

/** Exported for tests and for a host that wants a clean slate. */
export function clearOptionsCache(provider?: ProviderFn): void {
  if (provider) sharedFetches.delete(provider as unknown as object);
}

function fetchShared(
  provider: ProviderFn, source: string, refresh = false,
): Promise<RemoteOptionsLike | null> {
  let bySource = sharedFetches.get(provider as unknown as object);
  if (!bySource) {
    bySource = new Map();
    sharedFetches.set(provider as unknown as object, bySource);
  }
  // A refresh is asked for precisely because what the shared entry holds was
  // refused, so the in-process copy goes with the host's.
  if (refresh) bySource.delete(source);
  const cached = bySource.get(source);
  if (cached) return cached;
  const pending = provider(source, refresh ? { refresh: true } : undefined).then(
    (result) => {
      // Nothing usable came back: forget it, so a retry is a real retry.
      if (!result || !result.rows || !result.rows.length) {
        bySource?.delete(source);
      }
      return result;
    },
    (err) => {
      bySource?.delete(source);
      throw err;
    },
  );
  bySource.set(source, pending);
  return pending;
}

/**
 * A FETCHED ROW SET THAT DOES NOT MATCH THE CONTRACT IS TREATED AS ABSENT.
 *
 * The host caches the full row set for hours; the contract that declares the
 * columns is minted fresh with the form. When tools add a column, the cache
 * serves rows built for the old list, and if that column went in mid-list every
 * value after it renders one header out (see `rowIntegrity`). The engine cannot
 * tell which cells moved, so it refuses the payload instead of guessing:
 *
 * - the rows read as NOT LANDED - the field shows its inline starter rows and
 *   the pending copy it already has for "the full list is still coming";
 * - the fetch is re-issued ONCE with a cache bust, so a stale host copy is
 *   replaced rather than sat on;
 * - if the busted payload is wrong too, the state goes to `failed`, which is
 *   the state that offers the user a retry. It never loops.
 */
export function useRemoteRows(field: Field): RemoteRows {
  const provider = useOptionsProvider();
  const source = field.optionsSource?.source;
  const [rows, setRows] = useState<TableRow[] | null>(null);
  const [state, setState] = useState<FetchState>('idle');
  // Bumped by the retry action; re-running the effect re-calls the provider.
  const [attempt, setAttempt] = useState(0);
  // 0 = reading whatever the host had. 1 = we already refused one payload and
  // forced a cache-busting refetch; there is no second bust.
  const [bust, setBust] = useState(0);
  // Deps want a stable primitive: the field object is rebuilt every render, but
  // the declared column ids only change when the contract does.
  const columnsKey = (field.columns ?? []).map((c) => c.id).join('|');

  useEffect(() => {
    if (!source || !provider) return;
    let live = true;
    setRows(null);
    setState('pending');
    // Shared per (provider, source) - see fetchShared. A retry bumps `attempt`,
    // and because a failed fetch is evicted from the cache the next call really
    // does go back to the host.
    fetchShared(provider, source, bust > 0).then(
      (result) => {
        if (!live) return;
        if (!result || !result.rows.length) {
          setState('failed');
          return;
        }
        const verdict = verifyRows(result.rows, field.columns, result.columns);
        if (verdict.trusted) {
          setRows(verdict.rows);
          setState('ready');
          return;
        }
        if (bust === 0) {
          // Stay PENDING: no rows, starter set on screen, refetch in flight.
          setBust(1);
          return;
        }
        // The host served a mismatched set twice. Stop; hand the user a retry.
        setState('failed');
      },
      () => { if (live) setState('failed'); },
    );
    return () => { live = false; };
  }, [field.id, columnsKey, source, provider, attempt, bust]);

  return {
    rows,
    state,
    // No fetch in flight (no source, or no host provider) = nothing to say.
    note: state === 'idle' ? undefined : field.optionsSource?.notes?.[state],
    retry: () => setAttempt((a) => a + 1),
  };
}
