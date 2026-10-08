import { useEffect, useMemo, useRef, useState } from 'react';
import type { Field, Option } from '../lib/contract';
import { LIST_RENDER_CAP, MULTISELECT_INLINE_MAX } from '../lib/config';

interface Props {
  field: Field;
  options: Option[];
  value: string[];
  onChange: (keys: string[]) => void;
  onBlur: () => void;
}

export function MultiSelect(props: Props) {
  return props.options.length <= MULTISELECT_INLINE_MAX
    ? <CheckboxMultiSelect {...props} />
    : <ChipMultiSelect {...props} />;
}

/** Inline checkbox group for small multi-select fields. */
function CheckboxMultiSelect({ field, options, value, onChange, onBlur }: Props) {
  const toggle = (key: string) => {
    onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key]);
  };
  return (
    <div className="fe-multiselect" role="group" aria-labelledby={`${field.id}-label`}>
      {options.map((o) => (
        <label key={o.key} className="fe-checkbox">
          <input
            type="checkbox"
            checked={value.includes(o.key)}
            onChange={() => toggle(o.key)}
            onBlur={onBlur}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * Large option sets: searchable dropdown (type to filter, click to add) with
 * removable selected-item chips. Same value shape as the checkbox rendering.
 */
function ChipMultiSelect({ field, options, value, onChange, onBlur }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const byKey = useMemo(() => new Map(options.map((o) => [o.key, o])), [options]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const available = options.filter((o) => !value.includes(o.key));
    if (!q) return available;
    return available.filter(
      (o) => o.label.toLowerCase().includes(q) || o.description?.toLowerCase().includes(q),
    );
  }, [options, value, query]);

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

  const add = (key: string) => {
    onChange([...value, key]);
    setQuery('');
  };
  const remove = (key: string) => onChange(value.filter((k) => k !== key));

  return (
    <div className="fe-combo fe-chipselect" ref={rootRef}>
      {value.length > 0 && (
        <div className="fe-chips">
          {value.map((key) => (
            <span key={key} className="fe-chip">
              <span className="fe-chip-label">{byKey.get(key)?.label ?? key}</span>
              <button
                type="button"
                className="fe-chip-remove"
                aria-label={`Remove ${byKey.get(key)?.label ?? key}`}
                onClick={() => remove(key)}
              >
                {'×'}
              </button>
            </span>
          ))}
        </div>
      )}
      <button
        id={field.id}
        type="button"
        className="fe-input fe-combo-trigger fe-combo-trigger--empty"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{field.placeholder ?? 'Add...'}</span>
        <span className="fe-combo-caret" aria-hidden="true" />
      </button>
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
              if (e.key === 'Enter' && filtered.length === 1) add(filtered[0].key);
            }}
          />
          <ul className="fe-combo-list" role="listbox">
            {filtered.length === 0 && <li className="fe-combo-empty">No matches</li>}
            {visible.map((o) => (
              <li key={o.key}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="fe-combo-option"
                  onClick={() => add(o.key)}
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
