import type { FieldValue, FixAnnotation, FormValues } from './contract';

/**
 * WHEN HAS A SERVER FIX BEEN DEALT WITH?
 *
 * A fix is a blocking callout the tool pinned to a named field: "this value is
 * not acceptable". The reader changes the value, the pin goes away, and the
 * form stops shouting about something they have already dealt with.
 *
 * P2-4, wave-2 field campaign (2026-08-13). FormRenderer used to answer this
 * with a component-local `useState` map of cleared field ids, and component
 * state does not survive a remount. The review surface and the entry form are
 * two different branches of one ternary in InlineFormBlock, so EVERY
 * review -> "Edit details" transition unmounts the renderer and mounts a fresh
 * one. Meanwhile nothing ever strips `annotations.fixes` off the held contract
 * when a later verdict comes back clean, so the failed round's fixes are still
 * riding it. The result the campaign measured: the reader corrects a value, the
 * pin clears, they submit, the verdict passes, they open the review, they click
 * Edit to change something else - and the pin is BACK, on a value the server has
 * since accepted.
 *
 * THE RULE, AND WHY IT IS NOT "REMEMBER WHAT WAS CLEARED". Remembering clicks
 * is remembering the wrong thing: it survives a value being changed BACK to the
 * one the tool refused, which would leave a genuinely bad value with no pin on
 * it. What actually retires a fix is the VALUE MOVING OFF the one the fix was
 * raised on. So this records the value each fixed field held at the moment the
 * fix arrived, and a fix is stale exactly while the field no longer holds it.
 * Reverting to the refused value brings the pin back, which is honest.
 *
 * KEYED ON THE FIXES ARRAY ITSELF, by object identity, in a WeakMap. That is
 * the whole trick, and it is what makes the two cases distinguishable:
 *
 *   - A REMOUNT hands the renderer the SAME contract object out of the app
 *     shell's `entryFormRef`, so the same `fixes` array arrives, so the recorded
 *     baseline is still there and a corrected value still reads as stale. The
 *     pin does not come back.
 *   - A NEW VERDICT builds a new annotations block with a NEW fixes array
 *     (useAgentChat's verdict branch, and any contract arriving off the wire).
 *     No baseline, so nothing is suppressed and a re-raised complaint on a field
 *     the reader already edited SHOWS - which it must, because the tool has just
 *     looked at the new value and refused it too.
 *
 * A WeakMap also means no bookkeeping: entries die with the contracts that own
 * them, there is no cap to tune and no cross-test leakage beyond the lifetime of
 * the array a test itself created.
 */
const BASELINES = new WeakMap<readonly FixAnnotation[], Map<string, string>>();

/** Stable comparison key for a field value; `undefined` and `null` are one. */
function valueKey(value: FieldValue | undefined): string {
  if (value === undefined || value === null) return 'null';
  return JSON.stringify(value);
}

/**
 * Record what each fixed field held when this fix set arrived. FIRST WRITE
 * WINS: the point of the record is the value the tool refused, so a later
 * render of the same fix set must never overwrite it with the corrected one.
 * Safe and cheap to call on every render of the same array.
 */
export function recordFixBaseline(
  fixes: readonly FixAnnotation[] | undefined,
  values: FormValues,
): void {
  if (!fixes || fixes.length === 0) return;
  if (BASELINES.has(fixes)) return;
  const baseline = new Map<string, string>();
  for (const fix of fixes) baseline.set(fix.field, valueKey(values[fix.field]));
  BASELINES.set(fixes, baseline);
}

/**
 * Has this field moved off the value its fix was raised on? False whenever
 * there is nothing recorded - a fix set nobody has baselined yet is shown in
 * full, which is the safe direction.
 */
export function isFixStale(
  fixes: readonly FixAnnotation[] | undefined,
  fieldId: string,
  current: FieldValue | undefined,
): boolean {
  if (!fixes) return false;
  const baseline = BASELINES.get(fixes);
  if (!baseline) return false;
  const raisedOn = baseline.get(fieldId);
  if (raisedOn === undefined) return false;
  return valueKey(current) !== raisedOn;
}
