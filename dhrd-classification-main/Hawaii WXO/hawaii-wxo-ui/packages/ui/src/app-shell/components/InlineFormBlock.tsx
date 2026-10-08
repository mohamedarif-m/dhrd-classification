import {
  FormAnnotations,
  FormRenderer,
  ReviewPanel,
  type FormValues,
  type RemoteOptions,
  type UploadProvider,
} from '../../form-engine';
import type { ActiveForm } from '../lib/chat/liveTypes';

/** Inline form presentation: collapsed card / inline (default) / expanded overlay. */
export type FormView = 'inline' | 'expanded' | 'collapsed';

/**
 * The one form block, anchored into the message stream by AgentSurface. Renders
 * nothing when no form is active.
 */
export function InlineFormBlock({
  form, seed, view, busy, onView, optionsProvider, uploadProvider, onSubmit, onReviewConfirm,
  onValuesChange,
}: {
  form: ActiveForm | null;
  seed: FormValues | undefined;
  view: FormView;
  busy: boolean;
  onView: (view: FormView) => void;
  optionsProvider: (
    source: string, opts?: { refresh?: boolean },
  ) => Promise<RemoteOptions | null>;
  /** Uploads each accepted file; absent leaves `file` fields metadata-only. */
  uploadProvider?: UploadProvider;
  onSubmit: (values: FormValues) => void;
  onReviewConfirm: (token: string) => void;
  /** Every user edit in an entry form, with the full committed values. */
  onValuesChange?: (values: FormValues) => void;
}) {
  if (!form) return null;

  if (view === 'collapsed') {
    // The card is a resume affordance, so it stays hidden while a turn runs.
    if (busy) return null;
    return (
      <button type="button" className="form-card" onClick={() => onView('inline')}>
        <span className="form-card-kicker">Form</span>
        <span className="form-card-title">{form.contract.title}</span>
        <span className="form-card-open">Show</span>
      </button>
    );
  }

  return (
    <div className={`inline-form fe-rise-in${view === 'expanded' ? ' inline-form--expanded' : ''}`}>
      <div className="inline-form-bar">
        <span className="inline-form-title">{form.contract.title}</span>
        <div className="inline-form-actions">
          <button
            type="button"
            className="inline-form-btn"
            onClick={() => onView(view === 'expanded' ? 'inline' : 'expanded')}
          >
            {view === 'expanded' ? 'Back to chat' : 'Expand'}
          </button>
          {view !== 'expanded' && (
            <button type="button" className="inline-form-btn" onClick={() => onView('collapsed')}>
              Hide
            </button>
          )}
        </div>
      </div>
      {form.contract.review ? (
        // A REVIEW CONTRACT IS NOT ONLY ITS REVIEW MODEL.
        //
        // This branch used to render ReviewPanel and nothing else, so a review
        // contract's `annotations` were dropped on the floor - every note and
        // every warning the tool composed for the confirm screen existed only
        // on the wire. Two of them were measured missing on 2026-08-13: the
        // Assign Recruiter future-effective-date explanation (the reader was
        // told nothing about the change being SCHEDULED rather than immediate)
        // and the EIB Automatic Processing NOTICE, which is the loudest single
        // sentence this product writes and was invisible on the one screen
        // where somebody authorizes the payments.
        //
        // SECTIONS STAY UNRENDERED, and that is a DELIBERATE SAFETY DECISION
        // rather than a leftover (2026-08-13, and see eib-chaos.spec.ts SR-2).
        // A review contract's sections are not decoration: EIB's carry the
        // processing-mode control, and Automatic Processing COMPLETES every
        // payment immediately with no approver and no undo. That control has
        // never been clickable in this UI. Making it clickable is a change to
        // a write path's safety envelope and needs its own review, its own
        // tests and its own live verification - it must not arrive as a side
        // effect of a copy fix. So this renders the WORDS and not the CONTROL:
        // the notice above says what the workbook asked for, and the only
        // actions on the surface remain the confirm tokens at the foot.
        <>
          {/* SAID ONCE. `review.note` renders as the header description a few
              lines below, and the tools compose the same sentence into BOTH
              places - measured twice over on the Job Change review, ~70px
              apart. `alreadyShown` lets the annotation block stand down for
              anything the note below already says; see notesNotAlreadySaid for
              why the note is the copy that wins. */}
          <FormAnnotations
            annotations={form.contract.annotations}
            alreadyShown={form.contract.review.note}
          />
          {/* No onEdit: per-section Edit buttons stay out, so the confirm
              tokens at the foot are the review's only actions. */}
          <ReviewPanel
            review={form.contract.review}
            onConfirm={onReviewConfirm}
            disabled={busy}
            attachment={form.attachment}
          />
        </>
      ) : (
        <FormRenderer
          key={form.contract.id}
          contract={form.contract}
          initialValues={seed}
          optionsProvider={optionsProvider}
          uploadProvider={uploadProvider}
          disabled={busy}
          onValuesChange={onValuesChange}
          onSubmit={(v) => { onView('collapsed'); onSubmit(v); }}
        />
      )}
    </div>
  );
}
