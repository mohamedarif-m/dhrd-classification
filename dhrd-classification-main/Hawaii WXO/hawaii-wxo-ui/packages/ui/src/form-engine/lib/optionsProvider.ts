/**
 * Out-of-band option sets.
 *
 * A contract may say a field's inline rows are only a starter set and name a
 * `source` for the full one (Field.optionsSource). Fetching that set is the
 * HOST's job - the engine never knows a transport, an endpoint or a poll
 * policy; it only calls the provider it was handed and renders the result.
 * No provider means no fetch and no behavior change at all.
 */

import { createContext, useContext } from 'react';
import type { TableRow } from './contract';

export interface RemoteOptions {
  rows: TableRow[];
  /** Size of the full set as the host resolved it. */
  total: number;
  /**
   * OPTIONAL: the column ids these rows were built for, in cell order.
   *
   * Rows reach the browser through a host cache with a long TTL, so a payload
   * can outlive the column list it was built against. When a tool stamps this
   * field the engine matches CELLS TO COLUMNS BY ID instead of by position, and
   * a column that was reordered or inserted mid-list is a non-event. When the
   * ids do not cover the contract's columns the payload is refused outright
   * (see `verifyRows`) rather than rendered on the hope that it lines up.
   *
   * Additive: the host serves whatever the tool returned, and a payload without
   * it falls back to the positional width check.
   */
  columns?: string[];
}

/**
 * Per-call knobs. `refresh` asks the host to BYPASS its cached copy of the
 * source - the engine sets it when a payload failed `verifyRows`, so a stale
 * row set is replaced rather than sat on. A host that ignores the argument
 * still satisfies the type; it simply cannot self-heal.
 */
export interface OptionsFetchOptions {
  refresh?: boolean;
}

/** Resolves the full option set for a source, or null when it is unavailable. */
export type OptionsProvider = (
  source: string, opts?: OptionsFetchOptions,
) => Promise<RemoteOptions | null>;

export const OptionsProviderContext = createContext<OptionsProvider | null>(null);

export function useOptionsProvider(): OptionsProvider | null {
  return useContext(OptionsProviderContext);
}
