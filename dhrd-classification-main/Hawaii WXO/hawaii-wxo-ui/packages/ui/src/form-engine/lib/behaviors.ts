import type {
  Field, FormContract, FormValues, Option, TableRow, ValueModeSpec, Visibility,
} from './contract';
import { isRendered } from './contract';
import { effectiveValues, visibleWhenMet } from './visibleWhen';

function matches(rule: Visibility, values: FormValues): boolean {
  const actual = values[rule.controllerField];
  const wanted = rule.showWhen;
  if (Array.isArray(wanted)) return typeof actual === 'string' && wanted.includes(actual);
  return actual === wanted;
}

/**
 * Both visibility rules on a field: the `behaviors.visibility` verb and the
 * general `visibleWhen` conditions. Either one hiding the field hides it.
 * Pass EFFECTIVE values (see visibleWhen.ts) when chains have to settle;
 * `visibleFields` below does that for you.
 */
export function isFieldVisible(field: Field, values: FormValues): boolean {
  const rule = field.behaviors?.visibility;
  if (rule && !matches(rule, values)) return false;
  return visibleWhenMet(field.visibleWhen, values);
}

export function isSectionVisible(
  section: FormContract['sections'][number],
  values: FormValues,
): boolean {
  if (section.visibility && !matches(section.visibility, values)) return false;
  return visibleWhenMet(section.visibleWhen, values);
}

/** All fields currently shown, across visible sections. Conditions are read
 * against the effective values, so `visibleWhen` chains settle first.
 *
 * SHOWN is literal: a `carryHidden` field draws nothing, so it is not here.
 * That is what keeps it out of validation (validateForm walks this list) - a
 * rule on a field with no DOM node is an error nobody can find, let alone
 * clear. Its VALUE is unaffected; the envelope is built from the contract, not
 * from this. */
export function visibleFields(contract: FormContract, values: FormValues): Field[] {
  const effective = effectiveValues(contract, values);
  return contract.sections
    .filter((s) => isSectionVisible(s, effective))
    .flatMap((s) => s.fields)
    .filter((f) => isRendered(f) && isFieldVisible(f, effective));
}

/** Options for a combobox/multiselect, honoring dependentFilter and exclude. */
export function resolveOptions(field: Field, values: FormValues): Option[] {
  const filter = field.behaviors?.dependentFilter;
  let options: Option[];
  if (!filter) {
    options = field.options ?? [];
  } else {
    const parentValue = values[filter.parent];
    if (typeof parentValue !== 'string' || !parentValue) return [];
    options = filter.optionsByParentKey[parentValue] ?? [];
  }
  const exclude = field.behaviors?.exclude;
  if (exclude) {
    // controllerField is one id or a list of ids; selected keys union.
    const controllers = Array.isArray(exclude.controllerField)
      ? exclude.controllerField
      : [exclude.controllerField];
    const taken = new Set<string>();
    for (const id of controllers) {
      const controller = values[id];
      if (Array.isArray(controller)) {
        // Multi-value / hierarchy controllers: every key (path key) is taken.
        for (const v of controller) if (typeof v === 'string' && v) taken.add(v);
      } else if (typeof controller === 'string' && controller) {
        taken.add(controller);
      }
    }
    if (taken.size) options = options.filter((o) => !taken.has(o.key));
  }
  return options;
}

/**
 * Rows a table field should render right now, honoring `rowFilter`.
 *
 * `rows` defaults to the contract's inline rows; pass the live set when a
 * table has swapped in an out-of-band full set (tags ride the rows either way).
 * Returns every row when no filtering is active - no `rowFilter` behavior, an
 * empty/unset controller, a controller key absent from `showTags`, or a tag
 * union that comes out empty. While filtering IS active a row must carry at
 * least one active tag, so untagged rows drop out.
 */
export function visibleRows(
  field: Field, values: FormValues, rows: TableRow[] = field.rows ?? [],
): TableRow[] {
  const filter = field.behaviors?.rowFilter;
  if (!filter) return rows;
  const controller = values[filter.controllerField];

  // Controller keys: booleans read as 'true'/'false'; multi-value controllers
  // (multiselect) contribute every pick and their tag lists union.
  const keys: string[] = [];
  if (typeof controller === 'boolean') {
    keys.push(String(controller));
  } else if (Array.isArray(controller)) {
    for (const v of controller) if (typeof v === 'string' && v) keys.push(v);
  } else if (typeof controller === 'string' && controller) {
    keys.push(controller);
  }

  const active = new Set<string>();
  for (const key of keys) {
    for (const tag of filter.showTags[key] ?? []) active.add(tag);
  }
  if (active.size === 0) return rows;
  return rows.filter((r) => r.tags?.some((t) => active.has(t)));
}

/** Active value-mode spec for a field, or null when no valueMode behavior applies. */
export function resolveValueMode(field: Field, values: FormValues): ValueModeSpec | null {
  const vm = field.behaviors?.valueMode;
  if (!vm) return null;
  const controller = values[vm.controllerField];
  if (typeof controller !== 'string') return null;
  return vm.modes[controller] ?? null;
}

/**
 * When a parent value changes, dependent children whose current value is no
 * longer offered must reset. Returns the ids to clear.
 */
export function staleDependents(
  contract: FormContract, changedFieldId: string, values: FormValues,
): string[] {
  const stale: string[] = [];
  for (const section of contract.sections) {
    for (const field of section.fields) {
      const filter = field.behaviors?.dependentFilter;
      if (filter?.parent !== changedFieldId) continue;
      const current = values[field.id];
      if (current === null || current === undefined || current === '') continue;
      const options = resolveOptions(field, values);
      const keys = new Set(options.map((o) => o.key));
      const ok = Array.isArray(current)
        ? current.every((v) => typeof v === 'string' && keys.has(v))
        : typeof current === 'string' && keys.has(current);
      if (!ok) stale.push(field.id);
    }
  }
  return stale;
}
