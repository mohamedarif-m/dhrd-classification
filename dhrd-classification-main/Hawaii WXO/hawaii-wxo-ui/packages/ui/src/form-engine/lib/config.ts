/**
 * Named rendering constants for the engine.
 *
 * These are JS-level knobs (DOM caps, timings, control sizing) that have no
 * CSS-variable representation, so they do not belong in the theme tokens -
 * those are emitted as custom properties and consumed by engine.css only.
 * Everything here is exported so a host app can read the same values it is
 * rendering against instead of re-deriving them from a literal.
 */

/**
 * Maximum options/rows rendered into the DOM at once by the searchable list
 * controls (combobox, chip multi-select, table). Live option sets reach the
 * thousands; search narrows the rest and a footer row states the cap. The
 * table also uses it as its page size: scrolling to the bottom reveals another
 * cap's worth, so every row is reachable without searching.
 */
export const LIST_RENDER_CAP = 200;

/**
 * Multi-select presentation switch: at or below this many options the field
 * stays a flat checkbox group; above it, a searchable chip dropdown.
 */
export const MULTISELECT_INLINE_MAX = 8;

/** Rotation interval for the generic fallback thinking phrases. */
export const THINKING_ROTATE_INTERVAL_MS = 2400;

/** Advance interval for STAGED thinking copy (a registry list): each phrase
 * holds long enough to actually read before the next one appears. */
export const THINKING_STAGE_INTERVAL_MS = 5000;

/** Visible rows of a textarea field before it scrolls (it stays resizable). */
export const TEXTAREA_ROWS = 4;
