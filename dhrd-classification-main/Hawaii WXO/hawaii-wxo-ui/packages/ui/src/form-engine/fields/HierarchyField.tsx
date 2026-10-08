import { useMemo } from 'react';
import type { Field, FieldValue, Option } from '../lib/contract';
import { hierarchyTree, optionsAtIn, pathTo } from '../lib/hierarchy';
import { useRemoteRows } from '../lib/useRemoteRows';
import { Combobox } from './Combobox';

interface Props {
  field: Field;
  /** A key path, or the bare leaf key a prefilled side-channel field carries. */
  value: FieldValue;
  invalid: boolean;
  onChange: (path: string[]) => void;
  onBlur: () => void;
}

const keyPath = (value: FieldValue): string[] => (
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '')
    : typeof value === 'string' && value ? [value]
      : []
);

/**
 * One semantic hierarchy field rendered as linked searchable dropdowns:
 * each level filters the next, deeper picks reset when a parent changes.
 * The levels stack naturally on narrow widths (grid auto-fit).
 *
 * The tree is either inlined on the field or assembled from rows fetched over
 * the options side channel; the two render and emit identically. While a
 * side-channel fetch is in flight the CURRENT SELECTION still shows - it is
 * carried on the value itself, as a bare leaf key - so a prefilled form never
 * looks empty, and the moment the rows land that key expands into its path.
 */
export function HierarchyField({ field, value, invalid, onChange, onBlur }: Props) {
  const levels = field.levels ?? [];
  const { rows, state, note, retry } = useRemoteRows(field);
  const tree = useMemo(() => hierarchyTree(field, rows), [field, rows]);

  // The value the form holds is either an already-expanded path or the leaf key
  // alone. Resolving by the DEEPEST key covers both, and covers a partial path
  // (only the outer levels picked) just as well, because every node key is
  // unique across the tree.
  const held = keyPath(value);
  const deepest = held.length ? held[held.length - 1] : null;
  const resolved = deepest ? pathTo(tree, deepest) : null;
  // A key the tree cannot place - prefill that arrived before the rows, or a
  // value the current tree no longer holds - is still shown, at the last level,
  // rather than silently reading as "nothing selected". It is NOT a path: the
  // levels above it are unknown, so the working path stays empty until a pick
  // replaces it.
  //
  // EVERY unplaceable value, not only the short ones. This used to be gated on
  // `held.length < levels.length`, which quietly split the two shapes that
  // reach this field: a BARE LEAF KEY (a side-channel prefill, shorter than the
  // levels) was carried, and a FULL KEY PATH (what an EDIT ROUND carries, since
  // the previous submit emitted the path and the tool ships it straight back)
  // was not. A full path the tree can no longer walk then rendered "Select..."
  // at every level while the form went on HOLDING and SUBMITTING it - measured
  // 2026-08-13, the envelope carried the whole
  // ["division:WWE", "department:WWE|Marketing", "Talent (SUBDEPT_WWEtalent)"]
  // with "Talent" nowhere on screen. That is the table picker's P1 in a third
  // control, and on this product the hidden value is an ORGANIZATION. When the
  // deepest key cannot be placed the levels above it are unknown WHATEVER the
  // path's length - `pathTo` searches the whole tree, so an unresolved deepest
  // key is absent from the tree entirely and no level could have drawn it.
  const unplaced = !resolved && deepest ? deepest : null;
  const path = resolved ?? (unplaced ? [] : held);

  const pickAt = (levelIndex: number, key: string | null) => {
    const next = path.slice(0, levelIndex);
    if (key) next[levelIndex] = key;
    onChange(next);
  };

  return (
    <div>
      <div className="fe-hierarchy">
        {levels.map((level, i) => {
          const last = i === levels.length - 1;
          let options: Option[] = optionsAtIn(tree, path, i);
          let levelValue = path[i] ?? null;
          if (last && unplaced) {
            // Show the held key as the selection until the real node exists.
            options = [{ key: unplaced, label: unplaced }];
            levelValue = unplaced;
          }
          const parentPicked = i === 0 || Boolean(path[i - 1]) || Boolean(last && unplaced);
          return (
            <div key={level.id} className="fe-hierarchy-level">
              <span className="fe-label fe-hierarchy-label" id={`${field.id}-${level.id}`}>
                {level.label}
              </span>
              <Combobox
                field={{ ...field, id: `${field.id}-${level.id}-input`, placeholder: 'Select...' }}
                options={options}
                value={levelValue}
                invalid={invalid && !levelValue}
                disabledReason={parentPicked
                  ? undefined
                  : `Select ${levels[i - 1].label.toLowerCase()} first`}
                onChange={(key) => pickAt(i, key)}
                onBlur={onBlur}
              />
            </div>
          );
        })}
      </div>
      {/* State copy is contract data; an unauthored state shows nothing. The
          retry action is the one exception: a failed load must stay
          recoverable even when the contract wrote no failed note. */}
      {(note || state === 'failed') && (
        <p className="fe-hierarchy-note">
          {note}
          {state === 'failed' && (
            <button type="button" className="fe-hierarchy-retry" onClick={retry}>
              {field.optionsSource?.retryLabel ?? 'Try again'}
            </button>
          )}
        </p>
      )}
    </div>
  );
}
