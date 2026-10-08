/**
 * Theming contract. The engine ships neutral defaults; a consumer passes a
 * partial override to re-theme everything from one place. No brand values here.
 */

export interface ThemeTokens {
  colors: {
    accent: string;
    accentText: string;
    surface: string;
    card: string;
    text: string;
    textMuted: string;
    border: string;
    fieldBg: string;
    fieldBorder: string;
    focus: string;
    error: string;
    errorBg: string;
    success: string;
  };
  radii: {
    field: string;
    card: string;
  };
  fonts: {
    body: string;
    mono: string;
  };
  spacing: {
    /** Base unit in px; all engine spacing derives from it. */
    unit: number;
  };
  /** Single motion policy: transform/opacity only, one duration + easing. */
  motion: {
    /** Standard transition/entrance duration, e.g. '200ms' (150-250ms). */
    duration: string;
    /** Hover/focus micro-interactions, e.g. '100ms'. */
    durationFast: string;
    easing: string;
  };
  density: 'comfortable' | 'compact';
}

export const defaultTokens: ThemeTokens = {
  colors: {
    accent: '#3b5bdb',
    accentText: '#ffffff',
    surface: '#f4f5f7',
    card: '#ffffff',
    text: '#1a1a1a',
    textMuted: '#6b7076',
    border: '#e1e3e6',
    fieldBg: '#f4f4f4',
    fieldBorder: '#8d8d8d',
    focus: '#3b5bdb',
    error: '#c8102e',
    errorBg: '#fdf0f2',
    success: '#1f7a3d',
  },
  radii: { field: '4px', card: '8px' },
  fonts: {
    body: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    mono: "ui-monospace, 'SF Mono', Menlo, monospace",
  },
  spacing: { unit: 8 },
  motion: {
    duration: '200ms',
    durationFast: '100ms',
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
  },
  density: 'comfortable',
};

export type ThemeOverride = {
  [K in keyof ThemeTokens]?: Partial<ThemeTokens[K]>;
} & { density?: ThemeTokens['density'] };

export function mergeTokens(override: ThemeOverride = {}): ThemeTokens {
  return {
    colors: { ...defaultTokens.colors, ...override.colors },
    radii: { ...defaultTokens.radii, ...override.radii },
    fonts: { ...defaultTokens.fonts, ...override.fonts },
    spacing: { ...defaultTokens.spacing, ...override.spacing },
    motion: { ...defaultTokens.motion, ...override.motion },
    density: override.density ?? defaultTokens.density,
  };
}

/** CSS custom properties consumed by engine.css. Apply on any wrapper element. */
export function themeVars(tokens: ThemeTokens): Record<string, string> {
  const c = tokens.colors;
  const pad = tokens.density === 'compact' ? 0.75 : 1;
  return {
    '--fe-accent': c.accent,
    '--fe-accent-text': c.accentText,
    '--fe-surface': c.surface,
    '--fe-card': c.card,
    '--fe-text': c.text,
    '--fe-text-muted': c.textMuted,
    '--fe-border': c.border,
    '--fe-field-bg': c.fieldBg,
    '--fe-field-border': c.fieldBorder,
    '--fe-focus': c.focus,
    '--fe-error': c.error,
    '--fe-error-bg': c.errorBg,
    '--fe-success': c.success,
    '--fe-radius-field': tokens.radii.field,
    '--fe-radius-card': tokens.radii.card,
    '--fe-font-body': tokens.fonts.body,
    '--fe-font-mono': tokens.fonts.mono,
    '--fe-unit': `${tokens.spacing.unit * pad}px`,
    '--fe-motion-duration': tokens.motion.duration,
    '--fe-motion-fast': tokens.motion.durationFast,
    '--fe-motion-easing': tokens.motion.easing,
  };
}
