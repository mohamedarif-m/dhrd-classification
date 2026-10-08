import { useEffect, useMemo, useRef, useState } from 'react';
import type { Field, Option } from '../lib/contract';
import { LIST_RENDER_CAP } from '../lib/config';
import { optionsFromRows, useRemoteRows } from '../lib/useRemoteRows';

interface Props {
  field: Field;
  options: Option[];
  value: string | null;
  invalid: boolean;
  disabledReason?: string;
  onChange: (key: string | null) => void;
  onBlur: () => void;
}

/** Searchable single-select dropdown. */
export function Combobox({ field, options, value, invalid, disabledReason, onChange, onBlur }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  // OUT-OF-BAND OPTION SET. Until it resolves - and forever if it fails, or if
  // the host wired no provider - the contract's inline options are what
  // renders. That inline set is not a browsable sample: for a sourced combobox
  // a tool ships the CURRENT value and little else, so the control shows the
  // right thing immediately and the full list swaps in behind it.
  //
  // SCOPED TO ACTUAL COMBOBOX FIELDS, and that is load-bearing. HierarchyField
  // draws each of its LEVELS with this component and hands it the hierarchy's
  // own field, source spec and all - so an unscoped hook here fetched the org
  // rows once per level on top of the hierarchy's own fetch, printed the state
  // note once per level, and tried to read a tree's rows as a flat option list.
  // The side channel belongs to the control the tool declared, not to whatever
  // happens to render a dropdown.
  const sourced: Field = field.type === 'combobox'
    ? field
    : { ...field, optionsSource: undefined };
  const { rows: fetched, state: fetchState, note, retry } = useRemoteRows(sourced);

  const allOptions = useMemo(() => {
    if (!fetched) return options;
    const remote = optionsFromRows(fetched, field.optionsSource);
    if (!remote.length) return options;
    // THE CURRENT VALUE SURVIVES THE SWAP. A prefill the fetched set happens
    // not to contain - a workbook naming a plan the catalogue has since
    // retired, say - must not silently vanish from the control the moment the
    // rows land, because a vanished selection reads as "I chose nothing" and
    // submits as an empty change.
    if (value && !remote.some((o) => o.key === value)) {
      // The inline set is where a carried value normally comes from, but it is
      // not guaranteed to hold one: a tool can ship a `defaultValue` with no
      // matching inline option, and a remount after a pick re-seeds from the
      // contract while the fetch is failing. Falling through to `remote` then
      // left the trigger reading "Select..." over a form that still HELD and
      // still SUBMITTED the value - a display that disagrees with the envelope,
      // which is the one thing a picker must never do. Same fallback the
      // side-channel hierarchy uses for a leaf it cannot place.
      const carried = options.find((o) => o.key === value)
        ?? { key: value, label: value };
      return [carried, ...remote];
    }
    return remote;
  }, [fetched, field.optionsSource, options, value]);

  const selected = allOptions.find((o) => o.key === value) ?? null;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allOptions;
    return allOptions.filter(
      (o) => o.label.toLowerCase().includes(q) || o.description?.toLowerCase().includes(q),
    );
  }, [allOptions, query]);

  // Large live lists (1700+ options): cap the DOM, search narrows the rest.
  const visible = filtered.length > LIST_RENDER_CAP
    ? filtered.slice(0, LIST_RENDER_CAP)
    : filtered;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
        onBlur();
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, onBlur]);

  const pick = (key: string) => {
    onChange(key);
    setOpen(false);
    setQuery('');
    onBlur();
  };

  if (disabledReason) {
    return <div className="fe-input fe-combo-disabled">{disabledReason}</div>;
  }

  return (
    <div className="fe-combo" ref={rootRef}>
      <button
        id={field.id}
        type="button"
        className={`fe-input fe-combo-trigger${selected ? '' : ' fe-combo-trigger--empty'}`}
        aria-invalid={invalid || undefined}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{selected ? selected.label : field.placeholder ?? 'Select...'}</span>
        <span className="fe-combo-caret" aria-hidden="true" />
      </button>
      {/* Same rule as the table and the hierarchy: the state copy is contract
          data and an unauthored state shows nothing, but a FAILED load stays
          recoverable whether or not the tool wrote a note for it. Rendered
          under the trigger rather than inside the panel so it is readable
          without opening the dropdown. */}
      {(note || fetchState === 'failed') && (
        <p className="fe-table-note">
          {note}
          {fetchState === 'failed' && (
            <button type="button" className="fe-table-retry" onClick={retry}>
              {field.optionsSource?.retryLabel ?? 'Try again'}
            </button>
          )}
        </p>
      )}
      {open && (
        <div className="fe-combo-panel">
          <input
            className="fe-input fe-combo-search"
            type="text"
            placeholder="Search..."
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              if (e.key === 'Enter' && filtered.length === 1) pick(filtered[0].key);
            }}
          />
          <ul className="fe-combo-list" role="listbox">
            {selected && (
              <li>
                <button type="button" className="fe-combo-option fe-combo-clear"
                  onClick={() => { onChange(null); setOpen(false); setQuery(''); onBlur(); }}>
                  Clear selection
                </button>
              </li>
            )}
            {filtered.length === 0 && <li className="fe-combo-empty">No matches</li>}
            {visible.map((o) => (
              <li key={o.key}>
                <button
                  type="button"
                  role="option"
                  aria-selected={o.key === value}
                  className={`fe-combo-option${o.key === value ? ' fe-combo-option--selected' : ''}`}
                  onClick={() => pick(o.key)}
                >
                  <span>{o.label}</span>
                  {o.description && <span className="fe-combo-desc">{o.description}</span>}
                </button>
              </li>
            ))}
            {filtered.length > LIST_RENDER_CAP && (
              <li className="fe-combo-empty">
                Showing {LIST_RENDER_CAP} of {filtered.length} - keep typing to narrow down
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
