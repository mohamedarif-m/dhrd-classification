import {
  base64ByteLength,
  DEFAULT_ATTACHMENT_MIME,
  type DownloadAttachment,
  type ReviewModel,
} from '../lib/contract';
import { fileExt, formatFileSize } from '../fields/FileField';
import { formatMoneyText } from '../lib/money';

export interface ReviewPanelProps {
  review: ReviewModel;
  onEdit?: (sectionId: string) => void;
  onConfirm: (token: string) => void;
  /** Disables both confirm actions while a submit is in flight - the
   * side-effectful token must never be sendable twice concurrently. */
  disabled?: boolean;
  /** File the tool handed back with this review, saved straight from the page. */
  attachment?: DownloadAttachment;
}

/** Grouped review rows with edit-jumps and explicit confirm buttons. */
export function ReviewPanel({ review, onEdit, onConfirm, disabled, attachment }: ReviewPanelProps) {
  const sections = new Map<string, typeof review.rows>();
  for (const row of review.rows) {
    const list = sections.get(row.sectionId) ?? [];
    list.push(row);
    sections.set(row.sectionId, list);
  }
  // Heading copy is data (row.sectionTitle) whenever the builder supplied it;
  // titleize is only the fallback for hand-authored review models.
  const headingFor = (sectionId: string, rows: typeof review.rows): string =>
    rows.find((r) => r.sectionTitle)?.sectionTitle ?? titleize(sectionId);

  return (
    <div className="fe-review">
      <header className="fe-form-header">
        <h2 className="fe-form-title">{review.title ?? 'Review'}</h2>
        {review.note && <p className="fe-form-desc">{review.note}</p>}
      </header>

      {[...sections.entries()].map(([sectionId, rows]) => (
        <section key={sectionId} className="fe-section">
          <div className="fe-review-section-head">
            <h3 className="fe-section-title">{headingFor(sectionId, rows)}</h3>
            {onEdit && (
              <button type="button" className="fe-btn fe-btn--ghost" onClick={() => onEdit(sectionId)}>
                Edit
              </button>
            )}
          </div>
          <dl className="fe-review-rows">
            {/* Amounts get thousands separators here - and ONLY amounts that
                carry a currency marker, so an id made of digits is never
                regrouped. See lib/money.ts; every other value is the tool's
                string, verbatim, as always. */}
            {rows.map((row, i) => (
              <div key={i} className="fe-review-row">
                <dt>{row.label}</dt>
                <dd>{formatMoneyText(row.value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}

      {attachment && (
        <div className="fe-file">
          <div className="fe-file-chip fe-file-chip--download">
            <span className="fe-file-ext">{fileExt(attachment.filename)}</span>
            <span className="fe-file-name">{attachment.filename}</span>
            <span className="fe-file-size">{formatFileSize(base64ByteLength(attachment.base64))}</span>
            <a
              className="fe-file-action"
              href={`data:${attachment.mimeType ?? DEFAULT_ATTACHMENT_MIME};base64,${attachment.base64}`}
              download={attachment.filename}
            >
              Download
            </a>
          </div>
          {/* Copy about the file is the tool's, never this component's. */}
          {attachment.note && <p className="fe-form-desc">{attachment.note}</p>}
        </div>
      )}

      {(review.warnings?.length ?? 0) > 0 && (
        <div className="fe-warnings" role="alert">
          {review.warnings!.map((w, i) => <p key={i}>{w.message}</p>)}
        </div>
      )}

      <div className="fe-form-actions">
        <button
          type="button"
          className="fe-btn fe-btn--ghost"
          disabled={disabled}
          onClick={() => onConfirm(review.confirmTokens.cancel)}
        >
          {review.confirmTokens.cancelLabel ?? 'Go back'}
        </button>
        <button
          type="button"
          className="fe-btn fe-btn--primary"
          disabled={disabled}
          onClick={() => onConfirm(review.confirmTokens.submit)}
        >
          {disabled ? 'Working...' : (review.confirmTokens.submitLabel ?? 'Confirm and submit')}
        </button>
      </div>
    </div>
  );
}

/** Last-resort heading when a review model carries no sectionTitle. */
function titleize(id: string): string {
  return id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
