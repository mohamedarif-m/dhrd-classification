/**
 * theme.hawaii.ts — Hawaii DHRD HRO brand tokens.
 *
 * Shell chrome is driven by --app-* CSS vars applied via applyBranding()
 * (see registry.json branding.colors). These tokens theme the form engine's
 * work surfaces to match the Hawaii palette.
 *
 * Palette:
 *   Ocean blue  #003f6b  — top bar, primary action
 *   Sky blue    #0066cc  — accent, links, focus ring
 *   Seafoam     #e8f4f8  — sidebar background
 *   White       #ffffff  — card surfaces
 *   Slate text  #1a2b3c  — body copy
 */
import type { ThemeOverride } from 'wxo-custom-ui';

export const hawaii = {
  oceanDeep:  '#003f6b',
  ocean:      '#005591',
  skyBlue:    '#0066cc',
  skyBright:  '#1a80e0',
  seafoam:    '#e8f4f8',
  sidebarBg:  '#f0f6fa',
  white:      '#ffffff',
  slate:      '#1a2b3c',
  muted:      '#5a7080',
  border:     '#ccdde8',
  fieldBg:    '#f5f9fc',
  error:      '#c8102e',
  errorBg:    '#fdf0f2',
};

export const hawaiiFormTokens: ThemeOverride = {
  colors: {
    accent:      hawaii.ocean,
    accentText:  hawaii.white,
    surface:     hawaii.seafoam,
    card:        hawaii.white,
    text:        hawaii.slate,
    textMuted:   hawaii.muted,
    border:      hawaii.border,
    fieldBg:     hawaii.fieldBg,
    fieldBorder: '#8da8bc',
    focus:       hawaii.skyBlue,
    error:       hawaii.error,
    errorBg:     hawaii.errorBg,
  },
  radii: { field: '4px', card: '8px' },
  fonts: {
    body: "'IBM Plex Sans', system-ui, sans-serif",
    mono: "'IBM Plex Mono', ui-monospace, monospace",
  },
};

/**
 * Form-engine tokens for a configured brand accent.
 * The branding.colors.accent from registry.json flows in here at runtime.
 */
export function hawaiiFormTokensFor(accent?: string | null): ThemeOverride {
  const value = accent?.trim();
  if (!value) return hawaiiFormTokens;
  return {
    ...hawaiiFormTokens,
    colors: { ...hawaiiFormTokens.colors, accent: value, focus: value },
  };
}
