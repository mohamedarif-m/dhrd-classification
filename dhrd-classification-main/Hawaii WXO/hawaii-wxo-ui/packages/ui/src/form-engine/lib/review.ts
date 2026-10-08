import type {
  ConfirmTokens, Field, FormContract, FormValues, ReviewModel, ReviewRow,
} from './contract';
import { contributesValue, isRendered, rowCells } from './contract';
import {
  isFieldVisible, isSectionVisible, resolveOptions, resolveValueMode,
} from './behaviors';
import { hierarchyPathLabels } from './hierarchy';
import { effectiveValues, isCheckedValue } from './visibleWhen';

function displayValue(field: Field, values: FormValues): string {
  const value = values[field.id];
  if (value === null || value === undefined || value === '') return '-';
  switch (field.type) {
    case 'combobox': {
      const opt = resolveOptions(field, values).find((o) => o.key === value);
      return opt?.label ?? String(value);
    }
    case 'multiselect': {
      if (!Array.isArray(value) || value.length === 0) return '-';
      const options = resolveOptions(field, values);
      return value
        .filter((k): k is string => typeof k === 'string')
        .map((k) => options.find((o) => o.key === k)?.label ?? k)
        .join(', ');
    }
    case 'hierarchy': {
      // A side-channel hierarchy carries no tree, so there are no labels to
      // resolve; the value itself is the server's canonical option string,
      // which is what the read-back then shows. Same for a leaf key held on
      // its own (a prefill nobody re-picked).
      const keys = Array.isArray(value)
        ? value.filter((k): k is string => typeof k === 'string')
        : [String(value)];
      if (!keys.length) return '-';
      const labels = hierarchyPathLabels(field, keys);
      return labels.length ? labels.join(' > ') : keys[keys.length - 1];
    }
    case 'table': {
      const row = field.rows?.find((r) => r.key === value);
      if (!row) return String(value);
      // Read back the same cells the table drew (aligned to the declared
      // columns), minus the blanks - padding is for holding a column open on
      // screen, and a read-back line has no columns to hold open.
      return rowCells(row, field.columns ?? []).filter(Boolean).join(' · ');
    }
    case 'checkbox':
    case 'toggle':
      // Same coercion the box itself renders with, so a value that came back
      // from a round trip as "true" cannot read back as "No" under a ticked box.
      return isCheckedValue(value) ? 'Yes' : 'No';
    case 'radio': {
      const opt = resolveOptions(field, values).find((o) => o.key === value);
      return opt?.label ?? String(value);
    }
    case 'file':
      return Array.isArray(value) && value.length
        ? value.map((f) => (typeof f === 'object' ? f.name : String(f))).join(', ')
        : '-';
    case 'filedownload':
      return (field.files ?? []).map((f) => f.name).join(', ') || '-';
    case 'number': {
      const mode = resolveValueMode(field, values);
      return mode?.suffix ? `${value} ${mode.suffix}` : String(value);
    }
    default:
      return String(value);
  }
}

/**
 * Build a review model from a filled form; the label reflects any active value
 * mode. Fields hidden by `visibleWhen` are absent from the read-back, and so
 * are the values they would have contributed: rows are built from the
 * EFFECTIVE values, the same set the submit envelope carries. A field that
 * carries no answer (a display table - see contributesValue) contributes no
 * row: there is nothing to read back. A field that draws nothing (carryHidden
 * - see isRendered) contributes no row either: it is not on screen anywhere,
 * and this is a screen.
 */
export function buildReviewModel(
  contract: FormContract, values: FormValues, confirmTokens: ConfirmTokens, title?: string,
): ReviewModel {
  const rows: ReviewRow[] = [];
  const shown = effectiveValues(contract, values);
  for (const section of contract.sections) {
    if (!isSectionVisible(section, shown)) continue;
    for (const field of section.fields) {
      if (!isFieldVisible(field, shown)) continue;
      if (!contributesValue(field)) continue;
      // carryHidden is carried, not shown - and the review surface is a
      // screen. It has no row here for the same reason it has no field on the
      // form; its value still rides the envelope the user is confirming.
      if (!isRendered(field)) continue;
      const mode = resolveValueMode(field, shown);
      rows.push({
        label: mode?.label ?? field.label,
        value: displayValue(field, shown),
        sectionId: section.id,
        sectionTitle: section.title,
      });
    }
  }
  return { rows, confirmTokens, title };
}
