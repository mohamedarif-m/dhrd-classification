import { useState } from 'react';

export interface ErrorCardProps {
  /** Short human line; never the raw error. */
  message: string;
  /** Raw error/debug text, hidden behind a disclosure. */
  details?: string;
  retryLabel?: string;
  onRetry?: () => void;
}

/**
 * Compact inline failure card for chat flows: human message, optional Retry,
 * and a collapsed disclosure holding the raw text for debugging. Raw errors
 * are never rendered inline in the conversation.
 */
export function ErrorCard({ message, details, retryLabel = 'Try again', onRetry }: ErrorCardProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="fe-error-card" role="alert">
      <div className="fe-error-card-row">
        <span className="fe-error-card-msg">{message}</span>
        {onRetry && (
          <button type="button" className="fe-btn fe-btn--ghost fe-error-card-retry" onClick={onRetry}>
            {retryLabel}
          </button>
        )}
      </div>
      {details && (
        <div className="fe-error-card-details">
          <button type="button" className="fe-error-card-toggle" aria-expanded={open}
            onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide details' : 'Details'}
          </button>
          {open && <pre className="fe-error-card-raw">{details}</pre>}
        </div>
      )}
    </div>
  );
}
