import type { Field, FieldValue, FormValues } from '../lib/contract';
import { contributesValue, isRendered } from '../lib/contract';
import { resolveOptions, resolveValueMode } from '../lib/behaviors';
import { dateFloor } from '../lib/validation';
import { isCheckedValue, resolveHelper } from '../lib/visibleWhen';
import { FieldMessages, FieldShell } from '../fields/FieldShell';
import {
  CheckboxInput, DateInput, NumberInput, TextArea, TextInput,
} from '../fields/inputs';
import { Combobox } from '../fields/Combobox';
import { HierarchyField } from '../fields/HierarchyField';
import { MultiSelect } from '../fields/MultiSelect';
import { TableField } from '../fields/TableField';
import { FileField } from '../fields/FileField';
import { FileDownload } from '../fields/FileDownload';
import { RadioGroup, Toggle } from '../fields/choice';
import type { FileValue } from '../lib/contract';

const stringArray = (value: FieldValue | undefined): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

export interface FieldResolverProps {
  field: Field;
  values: FormValues;
  error: string | null;
  fix: string | null;
  onChange: (value: FieldValue) => void;
  onBlur: () => void;
  /** The form's authoritative business date (contract.todayIso); date floors only. */
  today?: string;
  /**
   * Registers this field's OUTER element, the same way FormRenderer's
   * `sectionRef` registers a section. A failed submit uses it to scroll the
   * first errored field into view and put the caret in it; without a handle on
   * the wrapper the renderer would have to guess at the DOM. Absent: nothing
   * is registered and the field renders exactly as before.
   */
  containerRef?: (el: HTMLElement | null) => void;
}

/**
 * THE single mapping from semantic field kind to presentation. Contracts say
 * what a field means; this resolver decides how it looks. Improving a pattern
 * here upgrades every form and every project at once, with zero tool changes.
 */
export function FieldResolver({
  field, values, error, fix, onChange, onBlur, today, containerRef,
}: FieldResolverProps) {
  // CARRIED, NOT SHOWN. A carryHidden field draws nothing anywhere - no
  // wrapper, no label, no control. FormRenderer already filters it out before
  // layout; this is the guard for any host that resolves a field directly, so
  // "never rendered" is a property of the field and not of one caller.
  if (!isRendered(field)) return null;

  const invalid = Boolean(error || fix);
  const value = values[field.id];
  const mode = resolveValueMode(field, values);
  // A field that contributes no value cannot be required, whatever the
  // contract says: a display table (selectable: false) has no control to fill
  // in, so an asterisk on it would promise a blocker that validation - which
  // skips it for the same reason - will never enforce. One predicate decides
  // both, so the mark and the rule can never disagree.
  const required = field.validation?.required && contributesValue(field);
  // THE HELPER IS A LIVE VALUE, not a constant. `helperWhen` lets a contract
  // name a line that depends on what is in the form right now; with no such
  // rules this is `field.helper` and nothing has changed. Computed once here
  // so every field family below - shell, checkbox/toggle, readOnly - shows the
  // same line, exactly as they already share `FieldMessages`.
  const helper = resolveHelper(field, values);
  const wide = ['textarea', 'table', 'file', 'filedownload', 'hierarchy'].includes(field.type);
  const common = { field, value, invalid, onChange, onBlur };

  // OUTPUT, not input. A display-only value drawn in the same bordered box as
  // an editable control reads as "type something here" - the live report was a
  // pay range that looked like an empty input. Same label, same helper, same
  // grid slot; the value is just static text.
  if (field.readOnly) {
    const shown = Array.isArray(value)
      ? value.filter((v) => v !== null && v !== undefined).join(', ')
      : value === null || value === undefined || value === '' ? '' : String(value);
    return (
      <div className={wide ? 'fe-field--wide' : undefined} ref={containerRef}>
        <FieldShell label={field.label} helper={helper} error={error} fix={fix}>
          <p className="fe-readonly-value" data-testid={`fe-readonly-${field.id}`}>
            {shown || '—'}
          </p>
        </FieldShell>
      </div>
    );
  }

  let control;
  let label = field.label;
  switch (field.type) {
    case 'text': control = <TextInput {...common} />; break;
    case 'textarea': control = <TextArea {...common} />; break;
    case 'number':
      if (mode) label = mode.label;
      control = <NumberInput {...common} suffix={mode?.suffix} />;
      break;
    case 'date':
      // Calendar floor from contract data: past-invalid dates are unpickable
      // in the picker itself; validation stays as the typed-date backstop.
      control = <DateInput {...common} min={dateFloor(field, values, today)} />;
      break;
    // Checkbox and toggle draw their OWN label next to the control, so they
    // cannot go through FieldShell without printing the label twice - but they
    // must still show what is wrong. They previously rendered the helper and
    // dropped `error` and `fix` on the floor: a required checkbox that failed
    // validation displayed NOTHING, which is the same "the form is stuck"
    // report as the off-screen errors. `FieldMessages` is the shell's own
    // message rule, so all three field families now say the same thing the
    // same way and no field type can hold an unrenderable error.
    case 'checkbox':
      return (
        <div className={`fe-field fe-field--wide${invalid ? ' fe-field--invalid' : ''}`} ref={containerRef}>
          <CheckboxInput {...common} />
          <FieldMessages helper={helper} error={error} fix={fix} />
        </div>
      );
    case 'toggle':
      return (
        <div className={`fe-field fe-field--wide${invalid ? ' fe-field--invalid' : ''}`} ref={containerRef}>
          <Toggle field={field} value={isCheckedValue(value)} onChange={onChange} onBlur={onBlur} />
          <FieldMessages helper={helper} error={error} fix={fix} />
        </div>
      );
    case 'radio':
      control = (
        <RadioGroup
          field={field}
          options={resolveOptions(field, values)}
          value={typeof value === 'string' ? value : null}
          onChange={onChange}
          onBlur={onBlur}
        />
      );
      break;
    case 'combobox': {
      const filter = field.behaviors?.dependentFilter;
      const parentEmpty = Boolean(filter && !values[filter.parent]);
      control = (
        <Combobox
          field={field}
          options={resolveOptions(field, values)}
          value={typeof value === 'string' ? value : null}
          invalid={invalid}
          disabledReason={parentEmpty && filter
            ? filter.emptyParentHint ?? `Select ${filter.parent.replace(/_/g, ' ')} first`
            : undefined}
          onChange={onChange}
          onBlur={onBlur}
        />
      );
      break;
    }
    case 'hierarchy':
      control = (
        <HierarchyField
          field={field}
          value={value}
          invalid={invalid}
          onChange={onChange}
          onBlur={onBlur}
        />
      );
      break;
    case 'multiselect':
      control = (
        <MultiSelect
          field={field}
          options={resolveOptions(field, values)}
          value={stringArray(value)}
          onChange={onChange}
          onBlur={onBlur}
        />
      );
      break;
    case 'table':
      control = (
        <TableField
          field={field}
          value={typeof value === 'string' ? value : null}
          invalid={invalid}
          values={values}
          onChange={onChange}
          onBlur={onBlur}
        />
      );
      break;
    case 'file':
      control = (
        <FileField
          field={field}
          value={Array.isArray(value) ? (value as FileValue[]) : []}
          invalid={invalid}
          onChange={onChange}
          onBlur={onBlur}
        />
      );
      break;
    case 'filedownload':
      control = <FileDownload field={field} />;
      break;
    default:
      // Graceful degradation: unknown kinds render as labeled text with a notice.
      control = (
        <>
          <TextInput {...common} />
          <p className="fe-helper">
            Unsupported field type "{(field as Field).type}" - shown as text.
          </p>
        </>
      );
  }

  return (
    <div className={wide ? 'fe-field--wide' : undefined} ref={containerRef}>
      <FieldShell
        htmlFor={field.id}
        label={label}
        required={required}
        helper={helper}
        error={error}
        fix={fix}
      >
        {control}
      </FieldShell>
    </div>
  );
}
