import type { Field, FieldValue } from '../lib/contract';
import { TEXTAREA_ROWS } from '../lib/config';
import { isCheckedValue } from '../lib/visibleWhen';

export interface InputProps {
  field: Field;
  value: FieldValue | undefined;
  invalid: boolean;
  onChange: (value: FieldValue) => void;
  onBlur: () => void;
  /** Overrides from an active valueMode (label/suffix handled by FormRenderer). */
  suffix?: string;
  /** Date fields: contract-derived calendar floor (see dateFloor). */
  min?: string;
}

const str = (v: FieldValue | undefined) =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

export function TextInput({ field, value, invalid, onChange, onBlur }: InputProps) {
  return (
    <input
      id={field.id}
      className="fe-input"
      type="text"
      value={str(value)}
      placeholder={field.placeholder}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
    />
  );
}

export function TextArea({ field, value, invalid, onChange, onBlur }: InputProps) {
  return (
    <textarea
      id={field.id}
      className="fe-input fe-textarea"
      rows={TEXTAREA_ROWS}
      value={str(value)}
      placeholder={field.placeholder}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
    />
  );
}

export function NumberInput({ field, value, invalid, onChange, onBlur, suffix }: InputProps) {
  return (
    <div className="fe-input-row">
      <input
        id={field.id}
        className="fe-input"
        type="text"
        inputMode="decimal"
        value={str(value)}
        placeholder={field.placeholder}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
      {suffix && <span className="fe-suffix">{suffix}</span>}
    </div>
  );
}

export function DateInput({ field, value, invalid, onChange, onBlur, min }: InputProps) {
  return (
    <input
      id={field.id}
      className="fe-input fe-input--date"
      type="date"
      value={str(value)}
      min={min}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
    />
  );
}

export function CheckboxInput({ field, value, onChange, onBlur }: InputProps) {
  return (
    <label className="fe-checkbox" htmlFor={field.id}>
      <input
        id={field.id}
        type="checkbox"
        checked={isCheckedValue(value)}
        onChange={(e) => onChange(e.target.checked)}
        onBlur={onBlur}
      />
      <span>{field.label}</span>
    </label>
  );
}
