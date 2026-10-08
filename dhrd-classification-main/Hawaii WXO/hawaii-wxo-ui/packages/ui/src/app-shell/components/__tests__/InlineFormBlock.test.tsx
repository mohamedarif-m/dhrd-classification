import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FormContract } from '../../../form-engine';
import { InlineFormBlock } from '../InlineFormBlock';
import type { ActiveForm } from '../../lib/chat/liveTypes';

const reviewForm: ActiveForm = {
  submitTool: 'jrc_create',
  contract: {
    id: 'review',
    title: 'Review',
    sections: [],
    review: {
      title: 'Check the requisition',
      rows: [
        { sectionId: 'role', sectionTitle: 'Role', label: 'Job title', value: 'Analyst' },
        { sectionId: 'comp', sectionTitle: 'Compensation', label: 'Grade', value: 'G3' },
      ],
      confirmTokens: { cancel: 'go_back', submit: 'create' },
    },
  } as unknown as FormContract,
};

const renderForm = (form: ActiveForm) => renderToStaticMarkup(
  <InlineFormBlock
    form={form}
    seed={undefined}
    view="inline"
    busy={false}
    onView={() => {}}
    optionsProvider={async () => null}
    onSubmit={() => {}}
    onReviewConfirm={() => {}}
  />,
);

const render = () => renderForm(reviewForm);

describe('review actions', () => {
  it('renders no per-section Edit buttons', () => {
    const html = render();
    expect(html).toContain('Compensation');
    expect(html).not.toContain('>Edit<');
  });

  it('keeps the confirm-token buttons as the only review actions', () => {
    const html = render();
    expect(html).toContain('Go back');
    expect(html).toContain('Confirm and submit');
  });

  it('renders nothing without an active form', () => {
    expect(renderToStaticMarkup(
      <InlineFormBlock
        form={null}
        seed={undefined}
        view="inline"
        busy={false}
        onView={() => {}}
        optionsProvider={async () => null}
        onSubmit={() => {}}
        onReviewConfirm={() => {}}
      />,
    )).toBe('');
  });
});

/**
 * A REVIEW CONTRACT'S ANNOTATIONS RENDER; ITS SECTIONS DO NOT.
 *
 * Both halves are asserted here because both are decisions rather than
 * accidents, and a test that only checked the first would let the second be
 * "fixed" by anyone who read the render path and assumed sections were an
 * oversight. See InlineFormBlock's own comment and eib-chaos.spec.ts SR-2.
 */
describe('review contract annotations', () => {
  /** The Assign Recruiter case: the server composes a scheduling explanation. */
  const withNote = (notes: string[]): ActiveForm => ({
    ...reviewForm,
    contract: { ...reviewForm.contract, annotations: { notes } } as unknown as FormContract,
  });

  it('renders nothing extra when the contract carries no annotations', () => {
    const html = render();
    expect(html).not.toContain('fe-notes');
    expect(html).not.toContain('fe-warnings');
  });

  it('ASSIGNREC: the future-effective-date note reaches the reader', () => {
    const note = 'Effective date 2026-08-20 is in the future, so this assignment '
      + 'is scheduled; Workday keeps showing the current recruiter until then.';
    const html = renderForm(withNote([note]));
    expect(html).toContain('fe-notes');
    expect(html).toContain('2026-08-20 is in the future');
  });

  it('EIBC: the Automatic Processing NOTICE reaches the reader', () => {
    const notice = 'WARNING - the workbook asks for Automatic Processing. Left as it '
      + 'is, this load routes every payment through the normal approval chain.';
    const html = renderForm(withNote(['Step 3 of 3 - review', notice]));
    expect(html).toContain(notice);
    // Both notes, in contract order, not just the last one.
    expect(html.indexOf('Step 3 of 3')).toBeLessThan(html.indexOf('WARNING -'));
  });

  it('renders contract warnings amber and alerting, as the form surface does', () => {
    const html = renderForm({
      ...reviewForm,
      contract: {
        ...reviewForm.contract,
        annotations: { warnings: [{ message: 'The pay group changed since you started.' }] },
      } as unknown as FormContract,
    });
    expect(html).toContain('fe-warnings');
    expect(html).toContain('role="alert"');
    expect(html).toContain('The pay group changed since you started.');
  });

  it('SAFETY: review SECTIONS stay unrendered, control and all', () => {
    // The shape EIB actually sends: the notice as a note, and the
    // processing-mode control as a review-contract SECTION. The words must
    // render; the control must not become clickable. Changing this line is
    // changing a write path's safety envelope - see the component comment.
    const html = renderForm({
      ...reviewForm,
      contract: {
        ...reviewForm.contract,
        annotations: { notes: ['WARNING - the workbook asks for Automatic Processing.'] },
        sections: [{
          id: 'processing',
          title: 'How should these payments be processed?',
          fields: [{
            id: 'processing_mode',
            type: 'radio',
            label: 'Processing mode',
            options: [
              { key: 'manual', label: 'Normal Workday approvals' },
              { key: 'auto', label: 'Automatic Processing' },
            ],
            defaultValue: 'manual',
          }],
        }],
      } as unknown as FormContract,
    });
    expect(html).toContain('WARNING - the workbook asks for Automatic Processing.');
    expect(html).not.toContain('How should these payments be processed?');
    expect(html).not.toContain('Automatic Processing<');
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain('processing_mode');
  });
});

describe('review download attachment', () => {
  // 12 base64 chars with no padding = 9 bytes; formatFileSize rounds up to 1 KB.
  const attachment = { filename: 'corrected.xlsx', base64: 'UEsDBBQABgAI' };

  it('renders no download affordance when no attachment came with the form', () => {
    expect(render()).not.toContain('href="data:');
  });

  it('renders one download anchor with the filename and a data URI', () => {
    const html = renderForm({ ...reviewForm, attachment });
    expect(html.match(/href="data:/g)).toHaveLength(1);
    expect(html).toContain('download="corrected.xlsx"');
    expect(html).toContain(
      'href="data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,UEsDBBQABgAI"',
    );
    expect(html).toContain('fe-file-chip--download');
    expect(html).toContain('XLSX');
    expect(html).toContain('1 KB');
  });

  it('uses the tool-supplied mimeType when it sends one', () => {
    const html = renderForm({
      ...reviewForm,
      attachment: { ...attachment, mimeType: 'text/csv' },
    });
    expect(html).toContain('href="data:text/csv;base64,UEsDBBQABgAI"');
  });

  it('renders the tool-authored note only when the tool sends one', () => {
    expect(renderForm({ ...reviewForm, attachment })).not.toContain('Two rows were corrected.');
    expect(renderForm({
      ...reviewForm,
      attachment: { ...attachment, note: 'Two rows were corrected.' },
    })).toContain('Two rows were corrected.');
  });
});
