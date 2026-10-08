import type { Receipt } from '../lib/contract';
import { formatMoneyText } from '../lib/money';

export interface ReceiptCardProps {
  receipt: Receipt;
}

/**
 * Outcome card for a completed submission: status tone, the tool's title with
 * the record id as a mono badge, and label/value rows in the same look as the
 * review surface the user confirmed.
 *
 * Everything readable is contract data. The only copy the engine owns is the
 * structural labels below - mechanical list headings, like the combobox's
 * "No matches" - so the card never speaks for the tool.
 */
export function ReceiptCard({ receipt }: ReceiptCardProps) {
  const failed = receipt.status === 'not_created';
  const rows = receipt.rows ?? [];
  const notified = receipt.approversNotified ?? [];
  const skipped = receipt.approversSkipped ?? [];
  // Only a real, non-empty id is a reference. A tool that has no event to cite
  // sends '' (or omits the key) and the line must not appear at all, the same
  // absent-means-absent rule the lists above follow.
  const wid = typeof receipt.eventWid === 'string' ? receipt.eventWid.trim() : '';

  return (
    <div className={`fe-receipt${failed ? ' fe-receipt--failed' : ''}`}>
      <header className="fe-receipt-head">
        {receipt.title && <h3 className="fe-receipt-title">{receipt.title}</h3>}
        {/* The event id was parsed off the contract and dropped until
            2026-08-11: through the JobChange_C campaign every successful
            submit carried an `eventWid` that nothing ever rendered, so a user
            finished a transaction with no reference to quote to HR or to look
            up in Workday. "Workday event" is engine-owned copy, and that is
            allowed for the same reason "Approvers notified" and "Not reached"
            are: it is a fixed STRUCTURAL label naming what the adjacent value
            is, not a statement about the transaction. The card still says
            nothing the tool did not say. */}
        {wid && (
          <p className="fe-receipt-wid">
            <span className="fe-receipt-wid-label">Workday event</span>
            <span className="fe-receipt-wid-value">{wid}</span>
          </p>
        )}
      </header>

      {(rows.length > 0 || notified.length > 0 || skipped.length > 0) && (
        <dl className="fe-review-rows fe-receipt-rows">
          {/* Same amount formatting as the review the user confirmed, for the
              same reason and by the same narrow rule (lib/money.ts): what the
              receipt reports must read like what they authorized. */}
          {rows.map((row, i) => (
            <div key={i} className="fe-review-row">
              <dt>{row.label}</dt>
              <dd>{formatMoneyText(row.value)}</dd>
            </div>
          ))}
          {notified.length > 0 && (
            <div className="fe-review-row">
              <dt>Approvers notified</dt>
              <dd>{notified.join(', ')}</dd>
            </div>
          )}
          {skipped.length > 0 && (
            <div className="fe-review-row fe-receipt-row--caution">
              <dt>Not reached</dt>
              <dd>{skipped.join(', ')}</dd>
            </div>
          )}
        </dl>
      )}

      {receipt.note && <p className="fe-receipt-note">{receipt.note}</p>}
    </div>
  );
}
