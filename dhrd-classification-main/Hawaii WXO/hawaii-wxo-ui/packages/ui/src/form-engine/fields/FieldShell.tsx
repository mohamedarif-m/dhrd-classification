import type { ReactNode } from 'react';

interface Props {
  htmlFor?: string;
  label: string;
  required?: boolean;
  helper?: string;
  error?: string | null;
  fix?: string | null;
  children: ReactNode;
}

/**
 * The one line under a control: server fix wins, then a validation error,
 * then the helper. Extracted from FieldShell because the field types that
 * draw their own label (checkbox, toggle) cannot use the shell without
 * printing the label twice - and before this existed they simply DROPPED the
 * error, so a required checkbox that failed validation showed nothing at all
 * and the form looked stuck. Every field type now shares this rule.
 */
export function FieldMessages({ helper, error, fix }: Pick<Props, 'helper' | 'error' | 'fix'>) {
  if (fix) {
    return (
      <p className="fe-error" role="alert">
        <span className="fe-fix-tag">FIX</span> {fix}
      </p>
    );
  }
  if (error) return <p className="fe-error" role="alert">{error}</p>;
  if (helper) return <p className="fe-helper">{helper}</p>;
  return null;
}

/** Label + control + helper/error frame shared by every field type. */
export function FieldShell({ htmlFor, label, required, helper, error, fix, children }: Props) {
  return (
    <div className={`fe-field${error || fix ? ' fe-field--invalid' : ''}`}>
      <label className="fe-label" htmlFor={htmlFor}>
        {label}
        {required && <span className="fe-required" aria-hidden="true"> *</span>}
      </label>
      {children}
      <FieldMessages helper={helper} error={error} fix={fix} />
    </div>
  );
}
