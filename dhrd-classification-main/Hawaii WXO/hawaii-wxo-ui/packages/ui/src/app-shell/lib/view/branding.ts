/**
 * Branding is server config (registry.json -> /registry -> here). The shell
 * hardcodes nothing: colors land on :root as CSS custom properties that
 * shell.css reads with the built-in values as var() fallbacks, so a missing or
 * partial branding block always leaves the default look intact.
 */

import { DEFAULT_WORDMARK } from '../chat/defaults';
import type { Branding } from '../chat/liveTypes';

/** CSS custom property per branding color key. */
const COLOR_VARS: Record<string, string> = {
  accent: '--app-accent',
  topbarBg: '--app-topbar-bg',
  topbarText: '--app-topbar-text',
  sidebarBg: '--app-sidebar-bg',
  sidebarText: '--app-sidebar-text',
};

/**
 * Host wordmark used until the registry names one. A package must not read a
 * host's build env, so this is explicit config: the host calls it once at boot.
 */
let wordmark = DEFAULT_WORDMARK;

export function configureBranding(config: { wordmark: string }): void {
  const value = config.wordmark.trim();
  if (value) wordmark = value;
}

/** Wordmark/document title, falling back to the configured default. */
export function appTitle(branding?: Branding): string {
  return branding?.appTitle?.trim() || wordmark;
}

/**
 * Paint branding onto the document: CSS variables for every color supplied,
 * plus the document title. Unset keys are left alone so the CSS fallbacks win.
 */
export function applyBranding(branding?: Branding): void {
  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(COLOR_VARS)) {
    const value = branding?.colors?.[key as keyof NonNullable<Branding['colors']>];
    if (typeof value === 'string' && value.trim()) root.style.setProperty(cssVar, value.trim());
  }
  document.title = appTitle(branding);
}
