/**
 * Form Contract v1.
 * The JSON shape agent tools emit and this renderer consumes. Everything the UI
 * shows or enforces is data in this contract; the renderer has no per-agent logic.
 */

import { hiddenFieldIds } from './visibleWhen';
import type { VisibleWhen } from './visibleWhen';

/**
 * Field types are SEMANTIC kinds, not widget names. The renderer maps each kind
 * to the best presentation in one place (FieldResolver); tools only send data.
 * - hierarchy: one field carrying a tree; rendered as linked searchable dropdowns.
 * - table: multi-column choice rows; a data table on desktop, stacked list when narrow.
 */
export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'combobox'
  | 'hierarchy'
  | 'table'
  | 'checkbox'
  | 'toggle'
  | 'radio'
  | 'multiselect'
  | 'file'
  | 'filedownload';

export interface Option {
  key: string;
  label: string;
  description?: string;
}

export interface HierarchyLevel {
  id: string;
  label: string;
  /**
   * SIDE-CHANNEL hierarchies only (the field declares an `optionsSource` and
   * ships no inline `tree`): the index of the row cell that supplies this
   * level's label. The levels are declared OUTERMOST first, whatever order the
   * cells sit in on the row - e.g. rows shaped
   * [sub-department, division, department, id] declare
   * [{cell: 1}, {cell: 2}, {cell: 0}]. Ignored when a `tree` is inlined.
   */
  cell?: number;
  /** Side-channel: row cell shown as secondary text beside the label (ids). */
  descriptionCell?: number;
}

export interface HierarchyNode {
  key: string;
  label: string;
  description?: string;
  children?: HierarchyNode[];
}

export interface TableColumn {
  id: string;
  label: string;
}

export interface TableRow {
  key: string;
  /**
   * Values in DECLARED COLUMN ORDER. The renderer aligns them to `columns` by
   * POSITION - cell i belongs to column i - and it draws exactly one cell per
   * declared column whatever this array's length is: a short row pads with
   * blanks on the right, a long one has its extras ignored. So a value can
   * never migrate under a neighbouring header.
   *
   * LIVE DEFECT 2026-08-12 (employee picker, columns
   * [worker, title, manager, id]): a worker with no manager came back with the
   * manager cell OMITTED rather than empty, every later value slid one column
   * left, and employee ids rendered under the Manager heading. Tools must send
   * a PLACEHOLDER ('') for a value they could not source, never a shorter
   * array - the padding below keeps the table honest, but only the tool knows
   * which column it failed to fill.
   */
  cells: string[];
  /**
   * Optional classification labels for this row, authored by the tool (e.g.
   * ["unassigned"], ["assigned", "urgent"]). They are never displayed; a
   * `rowFilter` behavior on the field matches against them to narrow the table.
   * Rows with no tags are shown ONLY while no filtering is active.
   */
  tags?: string[];
}

/**
 * User-facing copy for the three states of an out-of-band options fetch. Every
 * string is contract data: the engine renders exactly what a tool authored and
 * renders NOTHING for a state whose note is absent.
 */
export interface OptionsSourceNotes {
  pending?: string;
  ready?: string;
  failed?: string;
}

/**
 * Declares that this field's inline rows/options are a STARTER set and the full
 * set lives out-of-band under `source`. A host that supplies an options provider
 * fetches it and the control swaps in the full set; a host that does not (or a
 * fetch that fails) keeps the inline rows, so behavior degrades to the starter
 * set and never below it. `total` is the tool's count of the full set, for copy
 * and diagnostics only - the engine trusts what the provider returns.
 *
 * On a HIERARCHY field there are no inline rows to degrade to: the field ships
 * only its levels (each naming the row cell it reads) and its current value,
 * and the tree is assembled client-side from the fetched rows. The form then
 * carries a few hundred bytes instead of the whole tree, and a pick emits
 * exactly the value an inlined tree would have emitted.
 */
export interface OptionsSourceSpec {
  source: string;
  total?: number;
  notes?: OptionsSourceNotes;
  /**
   * Side-channel HIERARCHY only: the row cell that supplies the leaf's submit
   * value. Absent (the norm) means the leaf value is the row's own `key`, which
   * is already the server's canonical option string.
   */
  valueCell?: number;
  /**
   * Side-channel COMBOBOX only: which row cell becomes the option's visible
   * label, and which (optionally) its secondary text. Defaults: cell 0 for the
   * label, no description.
   *
   * A combobox reads the same `{key, cells}` rows a table does - one source can
   * feed both controls, and a tool that swaps a table for a dropdown does not
   * need the host to serve anything new.
   */
  labelCell?: number;
  descriptionCell?: number;
  /**
   * Label of the retry action shown beside the failed note. A failed load is
   * always retryable; this only renames the button ("Try again" by default).
   */
  retryLabel?: string;
}

export interface ValidationRules {
  required?: boolean;
  regex?: { pattern: string; message?: string };
  min?: number;
  max?: number;
  /** Max decimal places allowed; 0 means integers only. */
  decimal?: number;
  /** Date must be today or later (hint flag; minDate carries the real date). */
  minDateToday?: boolean;
  /**
   * Authoritative minimum date (ISO YYYY-MM-DD) computed by the tools in the
   * business timezone. Validate against THIS, never the browser clock.
   */
  minDate?: string;
  /** startField value must be <= endField value. Declare on either field of the pair. */
  datePair?: { startField: string; endField: string; message?: string };
}

export interface DependentFilter {
  /** Field id whose value selects the option list. */
  parent: string;
  optionsByParentKey: Record<string, Option[]>;
  /**
   * Copy shown in place of the control while the parent is unset. Contract
   * data, so the wording is the tool's to choose; when absent the renderer
   * falls back to a generic line derived from the parent id.
   */
  emptyParentHint?: string;
}

export interface ValueModeSpec {
  label: string;
  suffix?: string;
  min?: number;
  max?: number;
  /**
   * Mode not allowed for the picked controller value. Tools may also encode
   * this as {min: 0, max: 0, label: "... - not allowed ..."}; both are honored.
   */
  disabled?: boolean;
}

export interface ValueMode {
  /** Field id whose value picks the active mode. */
  controllerField: string;
  modes: Record<string, ValueModeSpec>;
}

export interface Visibility {
  controllerField: string;
  /** Value(s) of the controller for which this field/section is shown. */
  showWhen: string | string[] | boolean;
}

/**
 * Options equal to the controller field's currently selected key(s) are
 * hidden in this field, so the same choice cannot be picked twice across a
 * related pair or group. Multiple controllers are allowed; their selected
 * keys union before the exclusion is applied.
 */
export interface Exclude {
  controllerField: string | string[];
}

/**
 * Narrows the rows a `table` field renders, driven by another field's value.
 * Every label the user sees lives elsewhere (the controller field's own label
 * and options); the tags and the mapping here are pure contract data, so the
 * same engine serves any classification a tool invents.
 *
 * Semantics: the controller's active key(s) select tag lists out of `showTags`
 * and their UNION is what the table shows. A row is shown when at least one of
 * its `tags` is in that union - so rows with NO tags are hidden while filtering
 * is active, and shown only when it is not. Filtering is inactive (all rows
 * show) when the controller is empty/unset, when its key is absent from
 * `showTags`, or when the resulting union is empty.
 */
export interface RowFilter {
  /** Controller field id (checkbox, toggle, radio, combobox or multiselect). */
  controllerField: string;
  /** Controller value/key -> row tags to SHOW when that value is active.
   * For boolean controllers use keys 'true'/'false'. Missing key or empty
   * controller -> no filtering (all rows). Multiselect: union of picks. */
  showTags: Record<string, string[]>;
}

export interface FieldBehaviors {
  dependentFilter?: DependentFilter;
  valueMode?: ValueMode;
  visibility?: Visibility;
  exclude?: Exclude;
  rowFilter?: RowFilter;
}

/**
 * One value-dependent helper line: the condition that selects it, and the text
 * it puts under the control while that condition holds. Same condition
 * vocabulary as `visibleWhen`, deliberately - one grammar for "read another
 * field's current value", whatever it is being read for.
 */
export interface HelperRule {
  /** One condition or an array of them (an AND). See lib/visibleWhen.ts. */
  when: VisibleWhen;
  /** The helper text shown while `when` holds. */
  helper: string;
}

export interface Field {
  id: string;
  type: FieldType;
  label: string;
  placeholder?: string;
  helper?: string;
  /**
   * A helper that DEPENDS ON THE FORM'S CURRENT VALUES (1.22.0).
   *
   * `helper` is baked into the contract at render time, so a line that should
   * appear the moment a particular value is picked could not appear until the
   * server rendered the form again - and the review's "edit" control reopens
   * the held contract from browser state, with no server round at all. A
   * reader who picked the value, went to review and came back was told nothing
   * on the screen where they could still act on it.
   *
   * THE RULE: the FIRST entry whose `when` holds against the live values
   * REPLACES `helper` for display. None matching (or no entries at all) leaves
   * `helper` exactly as it is - so a contract without this key is byte for
   * byte the form it always was. Evaluated in the browser on every value
   * change, in the same place and against the same values `visibleWhen` reads
   * (the EFFECTIVE values, hidden fields removed), so a condition can never
   * be satisfied by a field that is not on screen.
   *
   * It is DISPLAY ONLY: it never changes the envelope, validation, the review
   * read-back, or whether the field renders. A field hidden by `visibleWhen`
   * draws no helper at all, matching entry or not, because it draws nothing.
   * Server-side text for the same condition (a review warning, the helper on
   * the next real render) stays the source of truth; this is the live echo of
   * it, not a replacement for it.
   */
  helperWhen?: HelperRule[];
  defaultValue?: FieldValue;
  /** combobox / multiselect static options (dependentFilter overrides). */
  options?: Option[];
  /**
   * hierarchy fields: named levels plus the choice tree. The working value is
   * a key path (one key per level); ON SUBMIT the field's envelope value is
   * the LEAF key only (keys are the server's canonical "Name (ID)" strings).
   *
   * The tree may instead be left OUT and the rows named on `optionsSource`,
   * with each level declaring its `cell`: the engine assembles the same tree
   * from the fetched rows. `defaultValue` may then be the leaf key on its own
   * (a plain string) - it renders as the current selection immediately and
   * expands into its full path as soon as the rows land.
   */
  levels?: HierarchyLevel[];
  tree?: HierarchyNode[];
  /** table fields */
  columns?: TableColumn[];
  rows?: TableRow[];
  /**
   * table fields: whether the user picks a row. Default (absent or true) is
   * today's single-select table. `false` makes it a DISPLAY table - the rows
   * are the message ("here are the 24 payments ready to load", "here are the
   * rows I could not fix"), not a question. The table and its search box
   * render exactly as always; only the selection column, its radios and
   * row-click selection are gone. Such a field is envelope-silent (no key at
   * all), never validated, and never a row on the review surface: a display
   * table has no answer to read back.
   *
   * This is NOT `readOnly`. `readOnly` is a static-text OUTPUT whose value
   * still rides the envelope; `selectable: false` keeps the full table chrome
   * and contributes nothing.
   */
  selectable?: boolean;
  /**
   * Full row set available out-of-band. On a table, `rows` above are the
   * starter set; on a hierarchy, the fetched rows are the ONLY source of the
   * tree (see OptionsSourceSpec).
   */
  optionsSource?: OptionsSourceSpec;
  /** file upload fields; defaults come from uploadLimits.ts (platform limits) */
  accept?: string;
  maxSizeMb?: number;
  maxFiles?: number;
  /** filedownload fields: files offered to the user */
  files?: DownloadFile[];
  validation?: ValidationRules;
  behaviors?: FieldBehaviors;
  /**
   * Conditional visibility on another field's current value: one condition or
   * an array of them (AND). While it does not hold the field is not rendered,
   * not validated, and left OUT of the submit envelope. Absent means always
   * visible. See lib/visibleWhen.ts.
   */
  visibleWhen?: VisibleWhen;
  /**
   * The field is OUTPUT, not input: current state the tool is showing, which
   * the user cannot edit. Rendered as static text with no input chrome, so an
   * empty or short value can never be mistaken for a box to fill in. The value
   * still rides the envelope unchanged; enforcement that it is never written
   * belongs to the tool, not to the renderer. Absent means editable.
   */
  readOnly?: boolean;
  /**
   * A CARRIED IDENTITY MARKER: the value rides the submit envelope and is
   * NEVER drawn. Not a styling switch - a field the user is not meant to see
   * at all.
   *
   * Why it exists: the envelope is built from the contract's fields, so the
   * only way to carry a value the tool needs back (the employee id it resolved,
   * a stage token, a run id) was to RENDER it - a readOnly field rides the
   * envelope, while a `visibleWhen`-hidden field is dropped from it. Forms
   * ended up showing an "Employee ID" row for no reason but plumbing. This
   * separates the two: carried, not shown.
   *
   * The exact contract:
   * - RENDERING: nothing at all. No label, no control, no wrapper, no node in
   *   the DOM. It occupies no grid slot, so the two-column pairing and the
   *   order of its neighbours are exactly what they would be if the field were
   *   not in the section.
   * - ENVELOPE: included, identically to a rendered readOnly field - same key,
   *   same value, same coercion, flat args and `packEnvelope` alike. Hiding
   *   must never mean dropping; that is the whole point.
   * - EDITING: impossible by construction - no control exists. It implies
   *   readOnly semantics, so a contract that sets both agrees with itself.
   * - VALIDATION: never. A rule on it could not be satisfied by anyone (same
   *   reason as readOnly, harder: there is not even static text to point at),
   *   so it is never validated and never a fix/error target. An error pinned
   *   to a field with no DOM node is an error nobody can find or clear.
   * - REVIEW: no read-back row. It is not on screen anywhere, and the review
   *   surface is a screen.
   * - `visibleWhen` on a carryHidden field: carryHidden governs RENDERING (it
   *   is never rendered, whatever the condition says) and `visibleWhen` still
   *   governs the ENVELOPE, unchanged - a condition that evaluates false drops
   *   the value from the envelope exactly as it does for any other field.
   *   Two orthogonal rules, neither special-cased: use `visibleWhen` when the
   *   value should be carried only sometimes.
   *
   * OLD ENGINES ignore the key and render the field as they do today, which is
   * as a readOnly field if you also set `readOnly: true` - and you should. The
   * degradation is COSMETIC ONLY: the value rides the envelope either way, so
   * a tool may emit this before every client has upgraded.
   */
  carryHidden?: boolean;
  /**
   * This field's `defaultValue` was derived from the user's OWN current
   * instruction and OUTRANKS a held value on merge; the server must only set
   * it for fields the current message explicitly named, and must announce the
   * change on the form.
   *
   * Why it exists: a redraw of the form on screen MERGES - the values already
   * typed become the seed and win over the arriving defaults, which is what
   * protects typing (see FormContract.fresh for the other half of that rule).
   * But a mid-form instruction - "this belongs to Test Sup Org 1, move it
   * there" - is re-rendered through the same merge, so a field the user had
   * already set kept its old value and the instruction was SILENTLY IGNORED.
   * This flag is the narrow exception: the ONE field the user just named
   * arrives authoritative and lands, everything else still merges.
   *
   * TWO NORMATIVE REQUIREMENTS ON THE SERVER (the renderer cannot check
   * either, and both are what keep the exception from swallowing the rule):
   * 1. Set it ONLY for fields the CURRENT message explicitly produced - never
   *    for a whole re-derived state. A state-wide flag is not "apply my
   *    instruction", it is "throw my typing away".
   * 2. ANNOUNCE every override visibly on the form (an `annotations.notes`
   *    entry naming the fields). A value that changes under the reader with
   *    no notice is indistinguishable from data loss.
   *
   * A nullish `defaultValue` is never authoritative: the flag can only make a
   * value LAND, it can never blank a value the user typed.
   *
   * OLD ENGINES ignore the key and merge as they always did - the arriving
   * value simply loses to the held one, which is today's behaviour.
   */
  authoritative?: boolean;
}

export interface Section {
  id: string;
  title: string;
  description?: string;
  fields: Field[];
  visibility?: Visibility;
  /** Same conditional visibility, applied to the whole section: its heading
   * and every field inside it, whose values drop out of the envelope too. */
  visibleWhen?: VisibleWhen;
}

export interface FixAnnotation {
  field: string;
  message: string;
}

/**
 * Non-blocking caution. The second severity next to fixes: a WARNING is shown
 * prominently (amber) but never prevents submit/confirm - the tool flags a
 * likely problem the user is allowed to override (e.g. currency does not
 * match the location country). `field` optionally names the field concerned;
 * all copy is tool-authored data.
 */
export interface WarningAnnotation {
  field?: string;
  message: string;
}

export interface Annotations {
  /** Server-side FIX callouts, shown as inline errors on the named fields.
   * Fixes are BLOCKING: the tool refuses the values until they change. */
  fixes?: FixAnnotation[];
  /** Informational notes shown above the form. */
  notes?: string[];
  /** Non-blocking cautions shown above the form (amber). */
  warnings?: WarningAnnotation[];
}

export interface ReviewRow {
  label: string;
  value: string;
  sectionId: string;
  /**
   * Section heading for this row, carried as data so the review surface never
   * has to prettify a section id. Absent rows fall back to a derived title.
   */
  sectionTitle?: string;
}

export interface ConfirmTokens {
  /** Machine tokens the UI sends back verbatim on confirm / cancel. */
  submit: string;
  cancel: string;
  submitLabel?: string;
  cancelLabel?: string;
}

export interface ReviewModel {
  rows: ReviewRow[];
  confirmTokens: ConfirmTokens;
  title?: string;
  note?: string;
  /** Non-blocking cautions shown on the review surface, above the confirm
   * actions - the user reads them and may still confirm. */
  warnings?: WarningAnnotation[];
  /**
   * Read-only tool the host envelopes when a submit turn ends WITHOUT a
   * receipt (the run outlived the transport's poll window and came back
   * pending). It reports what actually happened to the submission and answers
   * with either a receipt or a small "resubmit" review. Tool-authored data:
   * the contract is the only source of this name, exactly like submitTool.
   */
  checkTool?: string;
}

export interface FormContract {
  version: 1;
  id: string;
  title: string;
  description?: string;
  submitLabel?: string;
  /**
   * A FRESH contract deliberately starts clean: the UI must REPLACE any
   * in-progress form and discard held values, never merge.
   *
   * The arrival rules (`formArrivalFor`, `seedSurvives`) otherwise read a
   * contract whose id matches the form on screen as a REDRAW of that form, so
   * the values already typed win over the arriving defaults. That is right for
   * a fix round or a prefill re-render, and exactly wrong for "start over": a
   * tool that built a genuinely blank state server-side had the previous
   * attempt's answers painted straight back over it.
   *
   * The intent is DECLARED rather than inferred. Tools used to signal it by
   * freshening the id with a clock token (`jobreq-entry-<epoch>`), which made
   * the id both an identity and a message, and left the inverse hole open: a
   * form with a genuinely constant id could never say "start over" at all.
   * A tool sets `fresh: true` on the one render whose whole meaning is "throw
   * the last attempt away" and leaves it off everywhere else; ids stay stable
   * and keep meaning identity.
   */
  fresh?: boolean;
  /**
   * Authoritative "today" (YYYY-MM-DD) computed by the tools in the business
   * timezone. Date rules (minDateToday, date pairs) validate against THIS
   * value, never the browser clock, so client-side instant validation can
   * never disagree with the server-side check across midnight/timezone edges.
   */
  todayIso?: string;
  /**
   * Tool that receives this form's submit envelope. The contract is the ONLY
   * source of this name; host apps must not infer it from the form id or from
   * any transport-level metadata.
   */
  submitTool?: string;
  /**
   * Pack the WHOLE submit envelope into ONE argument of this name, as a JSON
   * string of {field id: value}, instead of one argument per field.
   *
   * Why a form would ask for that: on watsonx Orchestrate a tool's parameters
   * ARE its input_schema, every schema on the agent is sent to the model on
   * every turn, and the LARGEST one gates that turn's latency. A 265-field fix
   * form measured 15.9 KB of schema and 19-21s of stall on most turns of every
   * round - paid whether or not the form was ever opened. Packed, the same
   * tool declares one string.
   *
   * It changes NOTHING else. The same fields are rendered, validated, hidden
   * by the same `visibleWhen` rules and read back by the same review model;
   * only the shape of the envelope differs, and the ids inside it are
   * identical to the flat args. An engine older than 1.12.0 does not know the
   * key, ignores it and sends the flat args - which is a working call for any
   * tool that still declares them, and the reason a rollout can put the two
   * sides down in either order (see docs/api.md).
   *
   * The name must not collide with a field id in the same contract.
   */
  packEnvelope?: string;
  sections: Section[];
  annotations?: Annotations;
  review?: ReviewModel;
}

/**
 * One file a `file` field is holding.
 *
 * name/size/type are captured locally the moment the file is accepted. The
 * upload keys are filled in ONLY when the host handed the engine an
 * UploadProvider: `status` tracks the transfer, `url` is the platform file URL
 * the provider returned, and `error` is the provider's failure text. Without a
 * provider none of them are ever set and the value stays pure metadata.
 *
 * `url` is what makes a file reachable by a tool. Bytes NEVER travel in the
 * submit envelope - only this URL does.
 */
export interface FileValue {
  name: string;
  /**
   * Bytes, when the value came from a real File pick. A chip carried BACK by
   * an agent (a re-rendered form seeding `defaultValue: [{name, url, status}]`
   * for a file already uploaded) has no size, so this is optional and the chip
   * simply shows no size.
   */
  size?: number;
  type?: string;
  /** Platform file URL, fetchable from inside a wxO tool. Set on upload success. */
  url?: string;
  /** Host-side id for the uploaded file, when the upload endpoint returns one. */
  uploadId?: string;
  /** Transfer state; absent means "no provider, nothing was uploaded". */
  status?: 'uploading' | 'uploaded' | 'failed';
  /** Provider-authored failure text, shown on the chip when status is 'failed'. */
  error?: string;
}

export interface DownloadFile {
  name: string;
  size: number;
  type?: string;
  url?: string;
}

/**
 * One file a tool hands back with a form, carried inline as base64 on the
 * tool's `_meta` block instead of as a URL. Small artifacts only (tens of KB):
 * the bytes travel in the meta payload, so nothing has to be hosted and the
 * user can save the file straight off the review surface.
 *
 * `base64` is the raw base64 of the file bytes, with no `data:` prefix.
 * `mimeType` falls back to DEFAULT_ATTACHMENT_MIME when the tool omits it, and
 * `note` is the tool's own one-line copy about the file (user-facing wording is
 * always tool data, never a component's).
 */
export interface DownloadAttachment {
  filename: string;
  base64: string;
  mimeType?: string;
  note?: string;
}

/** Assumed attachment type when a tool sends no mimeType: an .xlsx workbook. */
export const DEFAULT_ATTACHMENT_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Decoded byte count of a base64 payload, computed without decoding it. */
export function base64ByteLength(base64: string): number {
  const clean = base64.replace(/\s/g, '');
  if (!clean) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(clean.length / 4) * 3 - padding);
}

export type FieldValue =
  | string | number | boolean | string[] | FileValue[] | null;

export type FormValues = Record<string, FieldValue>;

export type FormErrors = Record<string, string>;

/**
 * Server verdict from a background verification pass. It travels on its own
 * transport-level key (the host app owns that name) and is never folded into
 * FormContract.
 */
export interface VerifyVerdict {
  ok: boolean;
  fixes?: FixAnnotation[];
  message?: string;
}

/**
 * One label/value line on a receipt. Same shape as the review surface's rows
 * minus the grouping, so a receipt reads like the review the user confirmed.
 */
export interface ReceiptRow {
  label: string;
  value: string;
}

/**
 * Submission receipt; like VerifyVerdict it rides its own transport key.
 *
 * Two generations in one type. The legacy fields (title/id/lines/text) are a
 * pile of strings the host joins into one message. When `rows` is present the
 * host renders a ReceiptCard instead - a card with a status tone, an id badge
 * and label/value rows - and the legacy fields stay the fallback for tools
 * that have not been converted. Every string is tool-authored data; the
 * engine adds nothing but structural labels.
 */
export interface Receipt {
  title?: string;
  id?: string;
  lines?: string[];
  text?: string;
  /** Outcome tone. Absent is treated as created (legacy receipts only fire
   * on success). */
  status?: 'created' | 'not_created';
  /** Workday-style event id for the transaction, shown as small muted text. */
  eventWid?: string;
  /** Structured lines. Their PRESENCE is what selects the card rendering. */
  rows?: ReceiptRow[];
  /** People the transaction reached, rendered as chips under a fixed label. */
  approversNotified?: string[];
  /** People it did not reach; rendered with caution styling. */
  approversSkipped?: string[];
  /** Tool-authored explanation shown under the skipped list. */
  note?: string;
}

/**
 * Does this field carry an ANSWER? False only for a display table
 * (`type: 'table'` with `selectable: false`), which renders rows the user
 * cannot pick. The three places that would otherwise treat it as an input -
 * the submit envelope, validation and the review read-back - all ask here, so
 * the rule has exactly one definition and cannot drift apart.
 */
export function contributesValue(field: Field): boolean {
  return !(field.type === 'table' && field.selectable === false);
}

/**
 * Does this field DRAW anything? False only for `carryHidden`, whose value is
 * carried in the envelope and never shown (see Field.carryHidden).
 *
 * The exact counterpart of `contributesValue`, and deliberately independent of
 * it: one asks "is there an answer here", the other "is there a screen here".
 * Every place that would put a field in front of the user asks HERE - what
 * renders, what validates, what a fix can point at, what the review reads back
 * - so a carried value can never acquire a UI consequence it has no UI for.
 */
export function isRendered(field: Field): boolean {
  return field.carryHidden !== true;
}

/**
 * The cells a row contributes UNDER a declared column set: exactly one per
 * declared column, in declared order. A short row is padded with blanks on the
 * right and a long one has its extras dropped, so a missing value renders as a
 * BLANK CELL IN ITS OWN COLUMN and can never shift its neighbours left.
 *
 * With no declared columns (`columns` absent or empty) the row's own cells are
 * returned untouched - there is no column set to align to.
 */
export function rowCells(row: TableRow, columns: TableColumn[]): string[] {
  if (!columns.length) return row.cells;
  return columns.map((_, i) => row.cells[i] ?? '');
}

/** The engine's empty value for a field kind, before any authored default. */
function defaultFor(field: Field): FieldValue {
  if (field.type === 'checkbox' || field.type === 'toggle') return false;
  if (field.type === 'multiselect' || field.type === 'hierarchy' || field.type === 'file') return [];
  if (field.type === 'table' || field.type === 'combobox' || field.type === 'radio'
    || field.type === 'filedownload') return null;
  return '';
}

/**
 * The value an `authoritative` field LANDS, or undefined when it lands
 * nothing. ONE definition, because two places apply this rule: the values a
 * contract opens on (`contractDefaults`, below) and the reconcile that lands
 * an override on a form ALREADY MOUNTED (FormRenderer) - a merge arrival
 * keeps the same form id and therefore never remounts, so without the second
 * one the flag does nothing at all on the only path that matters.
 *
 * "LANDS NOTHING" IS THE WHOLE SAFETY PROPERTY: null, undefined, '' and []
 * are all refused, so the flag can only ever make a value APPEAR over a held
 * one - it can never blank what the reader typed. Clearing a field is
 * deliberately NOT expressible here; a tool that wants a field emptied must
 * say so some other way, because "the server sent nothing for this field" and
 * "the server wants this field empty" arrive looking identical and only one
 * of them may be allowed to destroy typing.
 */
export function authoritativeDefault(field: Field): FieldValue | undefined {
  if (field.authoritative !== true) return undefined;
  const dv = field.defaultValue;
  if (dv === undefined || dv === null || dv === '') return undefined;
  if (Array.isArray(dv) && dv.length === 0) return undefined;
  return dv;
}

/**
 * The values a contract opens on. THE FULL PRECEDENCE, highest first:
 *
 *   1. an AUTHORITATIVE `defaultValue` (see `authoritativeDefault` for exactly
 *      which values qualify) - the server derived it from the user's own
 *      current instruction, so it outranks what they typed earlier (see
 *      Field.authoritative, including the two requirements this imposes on the
 *      server: only fields the current message named, and announce it)
 *   2. `seed` - held values from a previous render of the same form
 *   3. the field's authored `defaultValue`
 *   4. the engine's empty value for the field's kind
 *
 * Rule 1 is a NARROW exception to rule 2 and cannot destroy anything: an
 * authoritative field with nothing to land (null, undefined, '' or []) falls
 * straight through to the seed, so the flag can only make a value land, never
 * blank one.
 *
 * ONE definition, used twice. `FormRenderer` seeds its state with it, and the
 * app shell reads a REVIEW contract's own carried constants with it - a review
 * renders only its ReviewPanel, so its sections have no rendered state and
 * their defaults are the only values they will ever have. Two definitions of
 * "what does this contract open on" is how a hidden constant goes missing from
 * a submit envelope.
 */
export function contractDefaults(contract: FormContract, seed?: FormValues): FormValues {
  const values: FormValues = {};
  for (const section of contract.sections) {
    for (const field of section.fields) {
      const landing = authoritativeDefault(field);
      values[field.id] = landing !== undefined
        ? landing
        : seed?.[field.id] ?? field.defaultValue ?? defaultFor(field);
    }
  }
  return values;
}

/**
 * Transform working form values into the submit-envelope args. Field ids are
 * the tool parameter names and every value is STRING-SHAPED (tool parameters
 * are typed str; null/None is rejected - proven live):
 * - hierarchy paths collapse to their LEAF key ('' when unset)
 * - unset scalars become ''
 * - multi-value fields (multiselect) join their keys with ', '
 * - file lists emit one entry per file, joined with ', '. An uploaded file
 *   emits 'name|url' - the URL is the ONLY way a tool can reach the bytes, and
 *   the bytes themselves never ride the envelope. A file with no url (no host
 *   upload provider, or an upload that failed) emits just 'name', exactly as
 *   before. THE DOC GUARD CONTRACT: a tool must treat any entry WITHOUT a '|'
 *   url part as NOT ATTACHED - the name alone is a label, not a document - and
 *   refuse or flag the step that needed the file.
 * - booleans become 'true'/'false', numbers become their decimal string:
 *   EVERY scalar is a string on the wire (proven live: a numeric openings: 1
 *   fails tool invocation the same way null did)
 *
 * A field hidden by a `visibleWhen` rule is OMITTED entirely - its key is not
 * in the output, so the tool is called without that parameter. A field hidden
 * by the older `behaviors.visibility` verb is still present (as ''), which is
 * what it always did. A field that carries no answer at all (see
 * contributesValue - a display table) is omitted the same way.
 *
 * A `carryHidden` field IS included, exactly like the rendered readOnly field
 * it replaces: it is invisible, not absent, and carrying its value is the only
 * reason it is in the contract. `visibleWhen` still applies to it (see
 * Field.carryHidden), so a condition that evaluates false drops it here for
 * the same reason it drops any other field.
 *
 * PACKED ENVELOPES. When the contract carries `packEnvelope`, the args above
 * are computed exactly as described and then serialized into ONE argument of
 * that name - `{ [packEnvelope]: JSON.stringify(args) }` and nothing else. The
 * selection rules are unchanged, so a hidden field is absent from the packed
 * object for the same reason it was absent from the flat one, and every value
 * inside is the same string it would have been. See FormContract.packEnvelope
 * for why a form asks for this.
 */
export function envelopeArgs(contract: FormContract, values: FormValues): FormValues {
  const out: FormValues = {};
  const hidden = hiddenFieldIds(contract, values);
  for (const section of contract.sections) {
    for (const field of section.fields) {
      if (hidden.has(field.id)) continue;
      if (!contributesValue(field)) continue;
      const v = values[field.id];
      if (field.type === 'hierarchy' && Array.isArray(v)) {
        const path = v as string[];
        out[field.id] = path.length ? path[path.length - 1] : '';
      } else if (field.type === 'file' && Array.isArray(v)) {
        out[field.id] = (v as FileValue[])
          .map((f) => (f.url ? `${f.name}|${f.url}` : f.name))
          .join(', ');
      } else if (Array.isArray(v)) {
        out[field.id] = (v as string[]).join(', ');
      } else if (typeof v === 'boolean') {
        out[field.id] = v ? 'true' : 'false';
      } else if (typeof v === 'number') {
        out[field.id] = String(v);
      } else {
        out[field.id] = v === null || v === undefined ? '' : String(v);
      }
    }
  }
  // The pack is the LAST step on purpose: everything above is the one
  // definition of what an envelope contains, and packing must never be a
  // second, subtly different answer to that question.
  const pack = contract.packEnvelope;
  return pack ? { [pack]: JSON.stringify(out) } : out;
}

export const KNOWN_FIELD_TYPES: FieldType[] = [
  'text', 'textarea', 'number', 'date', 'combobox', 'hierarchy', 'table',
  'checkbox', 'toggle', 'radio', 'multiselect', 'file', 'filedownload',
];
