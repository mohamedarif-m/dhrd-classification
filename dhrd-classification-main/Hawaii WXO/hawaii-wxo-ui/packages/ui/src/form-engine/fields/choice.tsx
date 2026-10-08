import type { Field, Option } from '../lib/contract';

interface ToggleProps {
  field: Field;
  value: boolean;
  onChange: (value: boolean) => void;
  onBlur: () => void;
}

export function Toggle({ field, value, onChange, onBlur }: ToggleProps) {
  return (
    <label className="fe-toggle" htmlFor={field.id}>
      <input
        id={field.id}
        type="checkbox"
        role="switch"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        onBlur={onBlur}
      />
      <span className="fe-toggle-track" aria-hidden="true" />
      <span>{field.label}</span>
    </label>
  );
}

interface RadioGroupProps {
  field: Field;
  options: Option[];
  value: string | null;
  onChange: (key: string) => void;
  onBlur: () => void;
}

/** Small option sets shown flat instead of behind a dropdown. */
export function RadioGroup({ field, options, value, onChange, onBlur }: RadioGroupProps) {
  return (
    <div className="fe-radio-group" role="radiogroup" aria-labelledby={`${field.id}-label`}>
      {options.map((o) => (
        <label key={o.key} className="fe-checkbox">
          <input
            type="radio"
            name={field.id}
            checked={value === o.key}
            onChange={() => onChange(o.key)}
            onBlur={onBlur}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}
