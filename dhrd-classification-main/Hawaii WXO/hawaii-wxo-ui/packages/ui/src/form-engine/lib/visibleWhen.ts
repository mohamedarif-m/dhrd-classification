/**
 * `visibleWhen` - generic conditional visibility, evaluated in the browser.
 *
 * A field or a section declares a condition on ANOTHER field's CURRENT value.
 * While the condition does not hold the field is not rendered, it is not
 * validated, and its value is left OUT of the submit envelope - but the
 * renderer keeps the value in its own state, so re-showing the field brings
 * back what the user had typed.
 *
 * How it differs from the older `behaviors.visibility` verb: that one is a
 * single controller/value pair and a field it hides still rides the envelope.
 * `visibleWhen` is the general form (four operators, AND arrays, chains that
 * settle) and it OMITS what it hides. Both are honored; absence of both means
 * always visible, so every contract written before this key keeps working.
 *
 * Chains settle because conditions read EFFECTIVE values - the working values
 * with every hidden field removed - computed to a fixed point. So when A hides
 * B, a condition on B sees B as absent and hides C as well.
 */

import type { Field, FieldValue, FormContract, FormValues, Section } from './contract';

/** Scalars a condition can compare against. Option-bearing fields compare on
 * the option KEY, which is what the values object and the envelope carry. */
export type ConditionValue = string | number | boolean;

/**
 * One condition: the field it reads, plus exactly ONE operator.
 *
 * - `equals`   the field's value is this scalar (string-compared, so the
 *              number field value '2' matches 2)
 * - `in`       the value is one of these scalars
 * - `checked`  a checkbox/toggle field is (or is not) ticked, read through
 *              `isCheckedValue` so a value that came back from a round trip as
 *              "true"/"on"/"1"/"yes" counts as ticked
 * - `notEmpty` the field has any value at all ('' , [] , false and unset are
 *              all empty)
 * - `notEquals` the value is NOT this scalar   (1.14.0)
 * - `notIn`    the value is none of these      (1.14.0)
 *
 * A multi-value field (multiselect, hierarchy path) satisfies `equals` / `in`
 * when ANY of its keys matches, and correspondingly fails `notEquals` / `notIn`
 * when any key matches.
 *
 * THE NEGATIVE OPERATORS DO NOT INVERT THE ABSENT-FIELD RULE. A condition whose
 * field is missing or currently hidden is FALSE whatever the operator, so a
 * rule can never switch a field ON because its controller disappeared. Making
 * `notEquals` true for an absent controller would be the other reading, and it
 * is the one that makes a chain flicker fields into existence as the form above
 * them collapses.
 */
export interface FieldCondition {
  /** id of another field in the same form. */
  field: string;
  equals?: ConditionValue;
  in?: ConditionValue[];
  checked?: boolean;
  notEmpty?: true;
  notEquals?: ConditionValue;
  notIn?: ConditionValue[];
}

/**
 * OR (1.14.0). An array of conditions is an AND, so the disjunction needs a
 * name: `{ any: [...] }` holds when ANY of its branches holds, and a branch is
 * itself a whole spec - so a branch may be an array, which is an AND. That is
 * enough for arbitrary and/or nesting without a second grammar.
 *
 * `any: []` is FALSE, not true. It states nothing, and the established rule for
 * a condition that states nothing is that nothing is shown on its account. (An
 * empty AND array is visible, which is the opposite default - but that one
 * means "no rule", and this one means "a rule with no way to hold".)
 */
export interface AnyCondition {
  any: VisibleWhen[];
}

export type VisibleWhenCondition = FieldCondition | AnyCondition;

/** One condition, or an array of them - an array is an AND. */
export type VisibleWhen = VisibleWhenCondition | VisibleWhenCondition[];

function isAny(c: VisibleWhenCondition): c is AnyCondition {
  return !!c && Array.isArray((c as AnyCondition).any);
}

/** Chains are short by construction; this caps the settling loop regardless. */
export const VISIBLE_WHEN_MAX_PASSES = 5;

/**
 * The strings a checkbox value comes back as once it has been round-tripped
 * through a tool, a JSON envelope, a query string or a spreadsheet. Compared
 * trimmed and lower-cased.
 */
const CHECKED_STRINGS = new Set(['true', 'on', '1', 'yes']);

/**
 * Is this value a TICKED checkbox?
 *
 * A checkbox is boolean in the renderer's own state, but it does not stay
 * boolean: the value goes out in an envelope, comes back seeded by a tool, and
 * arrives as `"true"`, `"on"`, `"1"` or `"yes"` depending on who serialized it.
 * The engine has to read every one of those as ticked, or a rule written
 * against the field means one thing before the round trip and the opposite
 * after it.
 *
 * ACCEPTED AS TICKED: `true`; the strings `"true"`, `"on"`, `"1"`, `"yes"` in
 * any case, with surrounding whitespace ignored; the number `1`.
 *
 * NOT TICKED: `false`; `"false"`, `"off"`, `"0"`, `"no"`; `undefined`, `null`
 * and `''`; the number `0`. Anything else - another string, another number, an
 * array, an object - is NOT ticked. An unrecognised value never throws and
 * never reads as ticked, because the failure that costs something is a hidden
 * field appearing, not a shown field staying hidden.
 */
export function isCheckedValue(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string' || typeof value === 'number') {
    return CHECKED_STRINGS.has(String(value).trim().toLowerCase());
  }
  return false;
}

function isEmptyValue(value: FieldValue | undefined): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value === false) return true;
  return false;
}

/**
 * Scalar comparison across the shapes a value can arrive in. Field values are
 * string-shaped in the contract (a number field holds '2'), so a tool may
 * author either `"equals": 2` or `"equals": "2"` and mean the same thing.
 */
function sameScalar(value: unknown, wanted: ConditionValue): boolean {
  if (value === wanted) return true;
  if (value === null || value === undefined) return false;
  if (typeof value === 'object') return false;
  return String(value) === String(wanted);
}

function valueMatches(value: FieldValue | undefined, wanted: ConditionValue): boolean {
  // Multi-value fields (multiselect keys, a hierarchy key path) match on any key.
  if (Array.isArray(value)) return value.some((v) => sameScalar(v, wanted));
  return sameScalar(value, wanted);
}

/**
 * Evaluate ONE condition against a values object.
 *
 * A condition whose field is absent from `values` is FALSE - that covers both
 * an id that does not exist in the form and a field that is itself hidden
 * right now (hidden fields are removed from the effective values). A condition
 * carrying no operator is false as well: it states nothing, so nothing is
 * shown on its account. Several operators on one condition all have to hold.
 */
export function conditionMet(
  condition: VisibleWhenCondition, values: FormValues,
): boolean {
  if (!condition) return false;
  if (isAny(condition)) {
    // Empty disjunction states nothing; see AnyCondition.
    return condition.any.length > 0
      && condition.any.some((branch) => visibleWhenMet(branch, values));
  }
  if (typeof condition.field !== 'string') return false;
  if (!(condition.field in values)) return false;
  const value = values[condition.field];

  let stated = false;
  if (condition.checked !== undefined) {
    stated = true;
    // BOTH sides go through the same coercion, so `checked: true` and
    // `checked: false` stay exact mirrors of each other. Comparing the raw
    // value with `=== true` made every non-boolean truthy shape - "true" from
    // a tool, "on" from a form post - satisfy `checked: false`.
    if (isCheckedValue(value) !== isCheckedValue(condition.checked)) return false;
  }
  if (condition.notEmpty !== undefined) {
    stated = true;
    if (condition.notEmpty ? isEmptyValue(value) : !isEmptyValue(value)) return false;
  }
  if (condition.in !== undefined) {
    stated = true;
    if (!Array.isArray(condition.in) || !condition.in.some((w) => valueMatches(value, w))) {
      return false;
    }
  }
  if (condition.equals !== undefined) {
    stated = true;
    if (!valueMatches(value, condition.equals)) return false;
  }
  if (condition.notEquals !== undefined) {
    stated = true;
    if (valueMatches(value, condition.notEquals)) return false;
  }
  if (condition.notIn !== undefined) {
    stated = true;
    if (!Array.isArray(condition.notIn)
      || condition.notIn.some((w) => valueMatches(value, w))) {
      return false;
    }
  }
  return stated;
}

/** Evaluate a whole `visibleWhen` spec (single condition or AND array). No
 * spec, or an empty array, means visible. */
export function visibleWhenMet(spec: VisibleWhen | undefined, values: FormValues): boolean {
  if (!spec) return true;
  const conditions = Array.isArray(spec) ? spec : [spec];
  if (conditions.length === 0) return true;
  return conditions.every((c) => conditionMet(c, values));
}

// ---- dev diagnostics -------------------------------------------------------

const warnedReferences = new Set<string>();

function inDevMode(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.NODE_ENV;
  return env !== 'production';
}

/**
 * A `visibleWhen` pointing at a field id the contract does not declare is an
 * authoring mistake: the condition can never hold, so the field never shows.
 * Warned once per contract/owner/reference, in dev only, and never thrown -
 * a bad reference must not take the form down.
 */
function warnUnknownReference(contract: FormContract, ownerId: string, reference: string) {
  if (!inDevMode()) return;
  const key = `${contract.id}:${ownerId}:${reference}`;
  if (warnedReferences.has(key)) return;
  warnedReferences.add(key);
  console.warn(
    `[form-engine] visibleWhen on "${ownerId}" references unknown field `
    + `"${reference}" in contract "${contract.id}"; the condition is false, so `
    + `"${ownerId}" will never be shown.`,
  );
}

function checkReferences(
  contract: FormContract, ownerId: string, spec: VisibleWhen | undefined, known: Set<string>,
) {
  if (!spec) return;
  for (const condition of Array.isArray(spec) ? spec : [spec]) {
    if (!condition) continue;
    if (isAny(condition)) {
      // Recurse: a branch is a whole spec, so an unknown reference can hide
      // inside a disjunction just as easily as at the top level.
      for (const branch of condition.any) {
        checkReferences(contract, ownerId, branch, known);
      }
      continue;
    }
    if (typeof condition.field === 'string' && !known.has(condition.field)) {
      warnUnknownReference(contract, ownerId, condition.field);
    }
  }
}

// ---- fixed point -----------------------------------------------------------

/**
 * Ids of every field currently hidden BY A `visibleWhen` RULE - its own, or
 * the one on its section - settled to a fixed point so chains agree with each
 * other. The older `behaviors.visibility` verb is deliberately not part of
 * this set: what it hides still rides the envelope, exactly as before.
 */
export function hiddenFieldIds(contract: FormContract, values: FormValues): Set<string> {
  const sections = contract.sections ?? [];
  const declared = new Set<string>();
  let hasRule = false;
  for (const section of sections) {
    if (section.visibleWhen) hasRule = true;
    for (const field of section.fields ?? []) {
      declared.add(field.id);
      if (field.visibleWhen) hasRule = true;
    }
  }
  if (!hasRule) return new Set();

  for (const section of sections) {
    checkReferences(contract, section.id, section.visibleWhen, declared);
    for (const field of section.fields ?? []) {
      checkReferences(contract, field.id, field.visibleWhen, declared);
    }
  }

  let hidden = new Set<string>();
  for (let pass = 0; pass < VISIBLE_WHEN_MAX_PASSES; pass += 1) {
    const effective = omit(values, hidden);
    const next = new Set<string>();
    for (const section of sections) {
      const sectionShown = visibleWhenMet(section.visibleWhen, effective);
      for (const field of section.fields ?? []) {
        if (!sectionShown || !visibleWhenMet(field.visibleWhen, effective)) next.add(field.id);
      }
    }
    if (next.size === hidden.size && [...next].every((id) => hidden.has(id))) return hidden;
    hidden = next;
  }
  return hidden;
}

function omit(values: FormValues, ids: Set<string>): FormValues {
  if (ids.size === 0) return values;
  const out: FormValues = {};
  for (const [id, value] of Object.entries(values)) {
    if (!ids.has(id)) out[id] = value;
  }
  return out;
}

/**
 * The working values with every `visibleWhen`-hidden field REMOVED. This is
 * what conditions, validation, the review read-back and the submit envelope
 * all read; the renderer's own state keeps the removed values so re-showing a
 * field restores what was typed.
 */
export function effectiveValues(contract: FormContract, values: FormValues): FormValues {
  return omit(values, hiddenFieldIds(contract, values));
}

/**
 * The helper line to DRAW for this field against the given values.
 *
 * `helperWhen` entries are tried in order and the FIRST whose condition holds
 * replaces `field.helper`; none holding (or no entries at all) yields
 * `field.helper` unchanged, which is what makes every contract written before
 * the key behave identically. Pass the EFFECTIVE values (hidden fields
 * removed) - the same set every other condition reads - so a rule can never be
 * satisfied by a field that is not on screen.
 *
 * Order is the tie-break on purpose: a contract that overlaps two conditions
 * has said which one it means by writing it first, and picking "the last" or
 * "the most specific" would be a rule the author cannot see in the JSON.
 *
 * AN ENTRY WITH NO CONDITION NEVER MATCHES - the one place this departs from
 * `visibleWhenMet`, where an absent spec means "no rule, so visible". Here an
 * absent spec would mean "a helper that replaces the static one for ever",
 * which is not a rule anybody writes on purpose; it is a dropped condition,
 * and honoring it would silently delete the field's real helper. An entry with
 * no `helper` string is skipped for the same reason.
 */
export function resolveHelper(field: Field, values: FormValues): string | undefined {
  const rules = field.helperWhen;
  if (!Array.isArray(rules)) return field.helper;
  for (const rule of rules) {
    if (!rule || typeof rule.helper !== 'string') continue;
    const { when } = rule;
    if (!when) continue;
    if (Array.isArray(when) && when.length === 0) continue;
    if (visibleWhenMet(when, values)) return rule.helper;
  }
  return field.helper;
}

/** Whether one field's own `visibleWhen` holds against the given values. */
export function fieldVisibleWhenMet(field: Field, values: FormValues): boolean {
  return visibleWhenMet(field.visibleWhen, values);
}

/** Whether one section's own `visibleWhen` holds against the given values. */
export function sectionVisibleWhenMet(section: Section, values: FormValues): boolean {
  return visibleWhenMet(section.visibleWhen, values);
}
