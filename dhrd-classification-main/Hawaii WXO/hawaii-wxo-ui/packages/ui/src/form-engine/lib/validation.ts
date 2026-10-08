import type { Field, FieldValue, FormContract, FormErrors, FormValues } from './contract';
import { contributesValue, isRendered } from './contract';
import { resolveValueMode, visibleFields } from './behaviors';
import { contractToday } from './time';

function isEmpty(value: FieldValue | undefined): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value === false) return true;
  return false;
}

/**
 * Validate one field against its rules plus any active value-mode range.
 * `today` is the authoritative business date (contract.todayIso). There is NO
 * browser-clock fallback: with neither minDate nor a contract today, relative
 * date rules defer to the server-side check instead of guessing locally.
 */
export function validateField(field: Field, values: FormValues, today?: string): string | null {
  // readOnly is OUTPUT: the reader has no control that could change it, so a
  // rule on one is unsatisfiable by definition. LIVE DEFECT 2026-08-12 (EIB
  // tools): a field carrying readOnly + required with an empty value wedged
  // the whole form - the error pointed at static text, and no amount of
  // editing anything else could clear it. Any field type, any rule.
  //
  // Not validating them is the documented contract, not a workaround: a
  // readOnly value still rides the envelope unchanged, and enforcement that
  // it is never written belongs to the tool, server-side, where the value
  // actually comes from. Distinct from `selectable: false`, which contributes
  // NOTHING to the envelope - these two are orthogonal and both are needed.
  //
  // A `carryHidden` field is the same argument taken one step further: it has
  // no control AND no static text, so an error on it would point at nothing in
  // the DOM at all. It is never a validation target and never a fix pin.
  if (field.readOnly || !isRendered(field)) return null;
  const rules = field.validation ?? {};
  const value = values[field.id];
  // Error messages use the active value-mode label when one applies.
  const label = resolveValueMode(field, values)?.label ?? field.label;

  if (rules.required && isEmpty(value)) return `${label} is required.`;
  if (isEmpty(value)) return null;

  if (field.type === 'hierarchy' && rules.required && Array.isArray(value)) {
    const levels = field.levels ?? [];
    for (let i = 0; i < levels.length; i += 1) {
      if (!value[i]) return `Select a ${levels[i].label.toLowerCase()}.`;
    }
  }

  if (rules.regex && typeof value === 'string') {
    if (!new RegExp(rules.regex.pattern).test(value)) {
      return rules.regex.message ?? `${label} has an invalid format.`;
    }
  }

  if (field.type === 'number' && typeof value === 'string') {
    if (!/^-?\d*\.?\d*$/.test(value) || value === '-' || value === '.') {
      return `${label} must be a number.`;
    }
    const num = Number(value);
    if (rules.decimal !== undefined) {
      const decimals = (value.split('.')[1] ?? '').length;
      if (decimals > rules.decimal) {
        return rules.decimal === 0
          ? `${label} must be a whole number.`
          : `${label} allows at most ${rules.decimal} decimal places.`;
      }
    }
    const mode = resolveValueMode(field, values);
    if (mode && (mode.disabled || (mode.min === 0 && mode.max === 0))) {
      return `${mode.label}`.includes('not allowed')
        ? mode.label
        : `${mode.label} is not allowed here.`;
    }
    const min = mode?.min ?? rules.min;
    const max = mode?.max ?? rules.max;
    if (min !== undefined && num < min) return `${label} must be at least ${min}.`;
    if (max !== undefined && num > max) return `${label} must be at most ${max}.`;
  }

  if (field.type === 'date' && typeof value === 'string') {
    const minDate = rules.minDate ?? (rules.minDateToday ? today ?? null : null);
    if (minDate && value < minDate) {
      return rules.minDate
        ? `${label} must be on or after ${rules.minDate}.`
        : `${label} cannot be in the past.`;
    }
    if (rules.datePair) {
      const { startField, endField, message } = rules.datePair;
      const start = values[startField];
      const end = values[endField];
      if (typeof start === 'string' && typeof end === 'string' && start > end) {
        return message ?? 'Start date must be on or before the end date.';
      }
    }
  }

  return null;
}

/**
 * Picker floor for a date field: the earliest date the calendar UI should
 * offer. Resolved from CONTRACT DATA only (rules.minDate, or minDateToday via
 * the form's todayIso passed as `today`) - never the browser clock. For a
 * datePair END field the floor is max(contract floor, the start field's
 * CURRENT value), live: clearing the start reverts to the contract floor.
 * Returns undefined when no contract-derived floor exists. The validation
 * messages above remain the backstop (typed dates, browser quirks).
 */
export function dateFloor(field: Field, values: FormValues, today?: string): string | undefined {
  if (field.type !== 'date') return undefined;
  const rules = field.validation ?? {};
  const base = rules.minDate ?? (rules.minDateToday ? today : undefined);
  const pair = rules.datePair;
  if (pair && field.id === pair.endField && pair.startField !== field.id) {
    const start = values[pair.startField];
    if (typeof start === 'string' && start) {
      // ISO YYYY-MM-DD strings compare lexicographically as dates.
      return base && base > start ? base : start;
    }
  }
  return base;
}

/**
 * Validate every visible field. Returns an empty object when the form is clean.
 * A field that carries no answer (a display table - see contributesValue) is
 * skipped: there is nothing the user could have filled in, so no rule of its
 * own, `required` included, can apply to it. A field that draws nothing at all
 * (carryHidden - see isRendered) is skipped for the stronger version of the
 * same reason: there is nowhere to show the error.
 */
export function validateForm(contract: FormContract, values: FormValues): FormErrors {
  const errors: FormErrors = {};
  const today = contractToday(contract);
  for (const field of visibleFields(contract, values)) {
    if (!contributesValue(field)) continue;
    // Belt and braces: visibleFields already drops carryHidden fields, and
    // validateField refuses them too. Neither is allowed to be the only guard.
    if (!isRendered(field)) continue;
    const error = validateField(field, values, today);
    if (error) errors[field.id] = error;
  }
  return errors;
}
