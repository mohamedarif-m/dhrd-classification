/**
 * TAKE THE USER TO THE PROBLEM.
 *
 * LIVE DEFECT 2026-08-12 (JobChange mega form, ~1650px tall): pressing submit
 * with a required field empty painted the errors far ABOVE the fold and did
 * nothing where the user was looking. No scroll, no focus, no word beside the
 * button. It reads as "the button is broken" - the reporter pressed it again
 * and again and filed the form as dead.
 *
 * A failed submit must therefore MOVE the view and the caret. This module owns
 * that motion so both entry points - the submit handler and the "jump to
 * first" control in the actions row - are the same behaviour and not two
 * lookalikes that drift.
 *
 * No React and no engine types on purpose: it takes an element and an id.
 */

/** Anything that can take a caret, minus the ones that cannot right now. */
const FOCUSABLE_SELECTOR = [
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'button',
  'a[href]',
  '[tabindex]',
].join(',');

/** Reads the media query defensively - SSR and jsdom may have no matchMedia. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function isUsable(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled')) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  return el.getAttribute('tabindex') !== '-1';
}

/**
 * THE FALLBACK LADDER. A field is not guaranteed to own a labelled control:
 * a table picker is a grid of rows, a file download is a link, a read-only
 * line is static text. So:
 *   1. the control whose id IS the field id - the one the label points at;
 *   2. failing that, the first usable focusable descendant (a table's first
 *      row button, a download link);
 *   3. failing that, the wrapper itself, made focusable with tabIndex -1.
 * Step 3 always succeeds, so a keyboard user always lands somewhere they can
 * act from and the next Tab continues from the right place.
 */
export function focusTargetFor(wrapper: HTMLElement, fieldId: string): HTMLElement {
  const candidates = Array.from(
    wrapper.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(isUsable);
  const own = candidates.find((el) => el.id === fieldId);
  if (own) return own;
  if (candidates.length > 0) return candidates[0];
  wrapper.tabIndex = -1;
  return wrapper;
}

/**
 * Scroll a field's wrapper into view and put the caret in it. Motion honours
 * `prefers-reduced-motion: reduce` (instant instead of smooth), and both DOM
 * calls are guarded: jsdom implements neither reliably, and a host that
 * renders server-side must not crash on a missing method.
 */
export function scrollAndFocusField(wrapper: HTMLElement, fieldId: string): void {
  if (typeof wrapper.scrollIntoView === 'function') {
    wrapper.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'center',
    });
  }
  const target = focusTargetFor(wrapper, fieldId);
  if (typeof target.focus === 'function') target.focus();
}

/** "3 required fields above need attention" - singular when there is one. */
export function errorSummaryText(count: number): string {
  return count === 1
    ? '1 required field above needs attention'
    : `${count} required fields above need attention`;
}
