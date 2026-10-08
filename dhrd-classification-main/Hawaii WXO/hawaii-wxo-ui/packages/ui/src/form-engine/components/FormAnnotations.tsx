import type { Annotations } from '../lib/contract';

export interface FormAnnotationsProps {
  /** The contract's annotations block; absent or empty renders nothing. */
  annotations?: Annotations;
  /**
   * Copy that is ALREADY on the surface below this block. Any note whose text
   * appears inside it is dropped here rather than printed twice - see
   * `notesNotAlreadySaid`. Absent: every note renders, exactly as before.
   */
  alreadyShown?: string;
}

/**
 * The contract's NOTES and WARNINGS, rendered above whatever surface follows.
 *
 * Extracted from FormRenderer so the rule for what a contract's annotations
 * look like is written once and every surface that has annotations to show can
 * show them the same way. FormRenderer draws it above the sections; the app
 * shell draws it above a REVIEW panel, which until 2026-08-13 drew nothing at
 * all (see InlineFormBlock).
 *
 * FIXES ARE DELIBERATELY NOT HERE. A fix is a message pinned to a NAMED FIELD;
 * it renders on that field, by FieldResolver, and a fix with no field on screen
 * to pin to is unfindable rather than merely unstyled. This component draws
 * only the two annotation kinds that belong to the FORM rather than to a field.
 */
/**
 * The notes that are not already said by `alreadyShown`.
 *
 * THE DUPLICATE NOTE ON THE JC REVIEW (wave-2 campaign, 2026-08-13). The tools
 * compose one sentence and put it in two places: `annotations.notes`, which
 * renders here, and `review.note`, which ReviewPanel renders as the header
 * description a few lines below. Measured on the Job Change review, the same
 * text appeared twice about 70px apart, and a reader who has just been told
 * something twice starts wondering which one is the real one.
 *
 * THE REVIEW NOTE WINS, and the annotation is the copy that gives way. It is
 * the direction that keeps more, not less: the review note is the SUPERSET
 * (the annotation appears INSIDE it, usually with the surrounding sentence the
 * tool wrote for the confirm screen), and it sits directly under the review's
 * own title, which is where a reader looks first. Printing the bare fragment
 * above it adds no information and costs the surface a whole block.
 *
 * Containment, not equality, on purpose: the tool's two copies are rarely
 * character-identical - one is a fragment of the other. Whitespace is
 * normalized so a wrapped copy still matches. An empty note is not "contained"
 * in anything.
 */
/**
 * Below this length a note is not treated as "already said" however well it
 * matches. Containment is the right test for the real case - one sentence the
 * tools composed into two places - but a degenerate note ("Yes", "None") would
 * be contained in almost any prose by accident, and suppressing a note nobody
 * repeated loses information outright.
 */
const MIN_DEDUPE_LENGTH = 12;

export function notesNotAlreadySaid(notes: string[], alreadyShown?: string): string[] {
  const said = (alreadyShown ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!said) return notes;
  return notes.filter((n) => {
    const note = n.replace(/\s+/g, ' ').trim().toLowerCase();
    if (note.length < MIN_DEDUPE_LENGTH) return true;
    // Word boundaries so a note is only "already said" when it appears as whole
    // words, not as a fragment inside a longer one.
    const at = said.indexOf(note);
    if (at < 0) return true;
    const before = at === 0 ? ' ' : said[at - 1];
    const after = at + note.length >= said.length ? ' ' : said[at + note.length];
    return /[\w]/.test(before) || /[\w]/.test(after);
  });
}

export function FormAnnotations({ annotations, alreadyShown }: FormAnnotationsProps) {
  const notes = notesNotAlreadySaid(annotations?.notes ?? [], alreadyShown);
  const warnings = annotations?.warnings ?? [];
  if (!notes.length && !warnings.length) return null;
  return (
    <>
      {notes.length > 0 && (
        <div className="fe-notes">
          {notes.map((n, i) => <p key={i}>{n}</p>)}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="fe-warnings" role="alert">
          {warnings.map((w, i) => <p key={i}>{w.message}</p>)}
        </div>
      )}
    </>
  );
}
