import { useEffect, useMemo, useRef, useState } from 'react';
import type { Field, FieldValue, FormContract, FormValues } from '../lib/contract';
import { authoritativeDefault, contractDefaults, isRendered } from '../lib/contract';
import { isFieldVisible, isSectionVisible, staleDependents, visibleFields } from '../lib/behaviors';
import { errorSummaryText, scrollAndFocusField } from '../lib/errorNavigation';
import { effectiveValues } from '../lib/visibleWhen';
import { validateField, validateForm } from '../lib/validation';
import { isFixStale, recordFixBaseline } from '../lib/fixState';
import { contractToday } from '../lib/time';
import { FieldResolver } from './FieldResolver';
import { FormAnnotations } from './FormAnnotations';
import { OptionsProviderContext, type OptionsProvider } from '../lib/optionsProvider';
import { UploadProviderContext, type UploadProvider } from '../lib/uploadProvider';

export interface FormRendererProps {
  contract: FormContract;
  initialValues?: FormValues;
  /**
   * Called with the validated values when the user submits. Fields hidden by
   * a `visibleWhen` rule are NOT in the object handed over - they never reach
   * a tool - while the renderer keeps their state internally.
   */
  onSubmit?: (values: FormValues) => void;
  /**
   * A turn is in flight, so the submit control is inert and says so - the same
   * prop, and the same reason, as ReviewPanel's. Without it a fast double
   * click submits twice and starts two runs against one form; the second is
   * indistinguishable from a deliberate resubmit by the time it reaches a
   * tool. Absent = enabled, exactly as before.
   */
  disabled?: boolean;
  /** Scroll target registration so a review panel can jump back to a section. */
  sectionRef?: (sectionId: string, el: HTMLElement | null) => void;
  /**
   * Resolves the full option set for a field that declares optionsSource.
   * Absent: fields render their inline (starter) rows, exactly as before.
   */
  optionsProvider?: OptionsProvider;
  /**
   * Transfers each file a `file` field accepts and returns its platform URL.
   * Absent: files stay metadata-only and the envelope carries names, exactly
   * as before.
   */
  uploadProvider?: UploadProvider;
  /**
   * Called after every USER edit with the full committed values. Never fires
   * for the initial values, so a host can treat the first call as "this form
   * is now dirty" - which is exactly what the app shell does to keep an
   * in-flight re-render from discarding what is being typed.
   */
  onValuesChange?: (values: FormValues) => void;
}

/** Renders any Form Contract v1 payload: sections, fields, validation, behaviors. */
export function FormRenderer({
  contract, initialValues, onSubmit, disabled, sectionRef, optionsProvider, uploadProvider,
  onValuesChange,
}: FormRendererProps) {
  const [values, setValues] = useState<FormValues>(() => contractDefaults(contract, initialValues));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);

  // Conditional visibility. `values` holds every field the user has touched,
  // INCLUDING the ones a `visibleWhen` rule currently hides - that is what
  // makes re-showing a field restore what was typed. `effective` is the same
  // set minus those hidden fields, settled to a fixed point, and it is what
  // everything that reads values as DATA uses: what renders, what validates,
  // and what `onSubmit` receives.
  const effective = useMemo(() => effectiveValues(contract, values), [contract, values]);

  // SERVER FIXES, and the record of which of them the reader has dealt with.
  //
  // The `fixes` ARRAY is the identity everything below keys on - see
  // fixState.ts. Holding it in a variable rather than re-reading
  // `contract.annotations?.fixes` at each use keeps that identity stable across
  // the render, which is the whole mechanism: the same array means the same
  // form the reader was already working on, a new array means the tool has
  // spoken again.
  const fixes = contract.annotations?.fixes;
  const serverFixes = useMemo(() => {
    const map: Record<string, string> = {};
    for (const fix of fixes ?? []) map[fix.field] = fix.message;
    return map;
  }, [fixes]);
  // Baselined once per fix set, from an effect so render stays pure. The first
  // paint after a fresh set arrives has no baseline yet and therefore shows
  // every fix, which is correct: nothing has been corrected yet. A REMOUNT
  // finds the record already there and keeps the corrected fields quiet.
  useEffect(() => {
    recordFixBaseline(fixes, values);
    // Deliberately keyed on the fix set alone. The values wanted here are the
    // ones held when the set ARRIVED; re-running as they change would rebase
    // the record onto the corrections and resurrect every pin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixes]);

  // Edit reporting: flipped by the first user edit, then the effect below
  // publishes the COMMITTED values after each change. Doing it from an effect
  // (rather than inside the state updater) keeps the updater pure and reports
  // values that React has actually applied.
  const editedRef = useRef(false);
  useEffect(() => {
    if (editedRef.current) onValuesChange?.(values);
    // onValuesChange is intentionally not a dependency: this publishes value
    // changes, not identity changes in the host's callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);

  // AUTHORITATIVE RECONCILE - the ONLY path on which the flag does anything.
  //
  // `contractDefaults` above runs in a useState INITIALIZER, so it decides the
  // values once per mount. A merge arrival - the case the flag exists for -
  // carries the SAME form id, and the host keys this component on that id, so
  // a new contract arrives as a plain re-render with no remount and no
  // reconciliation: the precedence rule was computed at a moment that had
  // already passed. Meanwhile the arriving `annotations` DO re-render, so the
  // reader saw "Applied from your message: Supervisory organization" sitting
  // over a field that had not changed - the announcement guardrail inverted
  // into a false claim, which is worse than the silence it replaced. (Found in
  // review before ship; the value did appear, but only after some unrelated
  // remount - hide/show, an edit round, a reload.)
  //
  // So a NEW CONTRACT REFERENCE lands the authoritative values into the
  // mounted state. Deliberately narrow:
  // - keyed on the contract OBJECT, not its id: the id is stable across
  //   exactly the arrivals this must react to.
  // - it writes ONLY authoritative fields with something to land. Every other
  //   field keeps whatever is being typed into it right now.
  // - no remount, so focus, touched, scroll position and the caret survive. A
  //   `key` bump would land the value and yank the cursor out of the field
  //   somebody was mid-sentence in, which is its own regression.
  // - dependent fields are NOT cleared (`staleDependents` is for user edits).
  //   An override that silently emptied its children would be touching values
  //   the message never named; validation and the review stage catch a
  //   combination that no longer agrees with itself.
  const seenContract = useRef(contract);
  useEffect(() => {
    if (seenContract.current === contract) return;   // mount, or same payload
    seenContract.current = contract;
    const landing: FormValues = {};
    for (const section of contract.sections) {
      for (const field of section.fields) {
        const value = authoritativeDefault(field);
        if (value !== undefined) landing[field.id] = value;
      }
    }
    if (!Object.keys(landing).some((id) => values[id] !== landing[id])) return;
    // The host's dirty tracker feeds on onValuesChange, and the value that just
    // landed MUST be in the seed it holds - otherwise the next arrival
    // reinstates the value this one replaced.
    editedRef.current = true;
    setValues((prev) => ({ ...prev, ...landing }));
    // Keyed on the contract alone: this reacts to a contract ARRIVING, never
    // to the values changing under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract]);

  const setValue = (field: Field, value: FieldValue) => {
    editedRef.current = true;
    setValues((prev) => {
      const next = { ...prev, [field.id]: value };
      for (const staleId of staleDependents(contract, field.id, next)) next[staleId] = null;
      return next;
    });
    setTouched((prev) => ({ ...prev, [field.id]: true }));
  };

  const errorFor = (field: Field): string | null => {
    if (!touched[field.id] && !submitAttempted) return null;
    return validateField(field, effective, contractToday(contract));
  };

  // FIELD REF REGISTRY - the same idea as `sectionRef` above, one level down.
  // A failed submit has to be able to reach the offending field's element, and
  // the only component that knows which field is which is this one.
  const fieldEls = useRef(new Map<string, HTMLElement>());
  const registerField = (id: string, el: HTMLElement | null) => {
    if (el) fieldEls.current.set(id, el);
    else fieldEls.current.delete(id);
  };

  /**
   * The errored fields IN CONTRACT ORDER: sections in the order the contract
   * declares them, fields in the order they appear inside each. `visibleFields`
   * already walks exactly that order, and it is the order the user reads in -
   * NOT the order a Map or a DOM query happens to hand back.
   *
   * Recomputed every render on purpose: the summary must vanish the moment the
   * last error is fixed, not survive until the next submit.
   */
  const erroredIds = useMemo(() => {
    if (!submitAttempted) return [];
    const errors = validateForm(contract, values);
    return visibleFields(contract, values)
      .filter((f) => errors[f.id])
      .map((f) => f.id);
  }, [contract, values, submitAttempted]);

  const goToField = (fieldId: string) => {
    const el = fieldEls.current.get(fieldId);
    if (el) scrollAndFocusField(el, fieldId);
  };

  const handleSubmit = () => {
    setSubmitAttempted(true);
    const errors = validateForm(contract, values);
    if (Object.keys(errors).length === 0) {
      onSubmit?.(effective);
      return;
    }
    // THE FIX FOR "THE BUTTON IS BROKEN". Errors alone are not feedback when
    // they render 1600px above the fold. Move the view and the caret to the
    // first one so the press visibly does something where the user is looking.
    const first = visibleFields(contract, values).find((f) => errors[f.id]);
    if (first) goToField(first.id);
  };

  const form = (
    <div className="fe-form">
      <header className="fe-form-header">
        <h2 className="fe-form-title">{contract.title}</h2>
        {contract.description && <p className="fe-form-desc">{contract.description}</p>}
      </header>

      {/* Notes and warnings are the same markup wherever a contract shows
          them, so the rule lives in one component; a review surface draws the
          identical block above its read-back. */}
      <FormAnnotations annotations={contract.annotations} />

      {contract.sections.filter((s) => isSectionVisible(s, effective)).map((section) => (
        <section
          key={section.id}
          className="fe-section"
          ref={(el) => sectionRef?.(section.id, el)}
        >
          <div className="fe-section-head">
            <h3 className="fe-section-title">{section.title}</h3>
            {section.description && <p className="fe-section-desc">{section.description}</p>}
          </div>
          <div className="fe-section-grid">
            {/* Two filters, two different questions. `isRendered` drops a
                carryHidden field before layout - it emits no element, so it
                takes no grid slot and the fields around it pair exactly as
                they would if it were not in the section at all. Its value is
                untouched: `values` still holds it and envelopeArgs still
                carries it. Any server fix naming such a field is simply never
                looked up (no field renders to look it up), which is the point:
                a fix that pins to no DOM node is unfindable. */}
            {section.fields
              .filter((f) => isRendered(f) && isFieldVisible(f, effective))
              .map((field) => (
                <FieldResolver
                  key={field.id}
                  field={field}
                  values={effective}
                  error={errorFor(field)}
                  fix={serverFixes[field.id]
                    && !isFixStale(fixes, field.id, values[field.id])
                    ? serverFixes[field.id] : null}
                  onChange={(v) => setValue(field, v)}
                  onBlur={() => setTouched((prev) => ({ ...prev, [field.id]: true }))}
                  today={contractToday(contract)}
                  containerRef={(el) => registerField(field.id, el)}
                />
              ))}
          </div>
        </section>
      ))}

      {onSubmit && (
        <div className="fe-form-actions">
          {/* SAY IT WHERE THE BUTTON IS. The per-field errors are correct but
              invisible on a form taller than the viewport; this is the one
              message that is guaranteed to be under the user's eyes when the
              press fails, and it carries a way back to the problem. */}
          {erroredIds.length > 0 && (
            <p className="fe-form-error-summary" role="alert" data-testid="fe-error-summary">
              {errorSummaryText(erroredIds.length)}
              {' - '}
              <button
                type="button"
                className="fe-linkbtn"
                onClick={() => goToField(erroredIds[0])}
              >
                jump to first
              </button>
            </p>
          )}
          <button
            type="button"
            className="fe-btn fe-btn--primary"
            onClick={handleSubmit}
            disabled={disabled}
          >
            {disabled ? 'Working...' : (contract.submitLabel ?? 'Review entries')}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <OptionsProviderContext.Provider value={optionsProvider ?? null}>
      <UploadProviderContext.Provider value={uploadProvider ?? null}>
        {form}
      </UploadProviderContext.Provider>
    </OptionsProviderContext.Provider>
  );
}
