import type { DownloadAttachment, FormContract } from '../../../form-engine';

/** Sanitized registry view served by the proxy (never contains agent ids). */
export interface LiveRegistry {
  mode: 'live' | 'unconfigured';
  agents: LiveRegistryAgent[];
  /** Tool display names for thinking-copy tier 2 (name -> display). */
  tools?: Record<string, { display_name?: string | null }>;
  /** Host branding (server config). Absent or partial must still render. */
  branding?: Branding;
}

/**
 * Everything about THIS deployment's identity, served as data so the shell
 * carries no client branding of its own. Every field is optional: the shell
 * falls back to its built-in defaults for anything missing.
 */
export interface Branding {
  /** Wordmark text and document title. */
  appTitle?: string | null;
  /**
   * Logo image shown instead of the wordmark. Either an absolute URL or a
   * path served by the app: drop the file into the host app's public/
   * directory and reference it as "/logo.svg".
   */
  logoUrl?: string | null;
  colors?: BrandingColors | null;
}

/** Chrome colors, applied as CSS custom properties on :root. */
export interface BrandingColors {
  accent?: string | null;
  topbarBg?: string | null;
  topbarText?: string | null;
  sidebarBg?: string | null;
  sidebarText?: string | null;
}

export interface LiveRegistryAgent {
  key: string;
  name: string;
  tagline?: string;
  welcome?: string;
  thinking?: Record<string, string | string[]>;
  fallbackPhrases?: string[];
  comingSoon?: boolean;
  /** Per-agent system copy; brandless defaults apply when a key is absent. */
  copy?: AgentCopy;
}

/**
 * Agent-specific wording for events the shell narrates itself. Every string
 * naming a client system belongs here (registry data), never in a component.
 * `{count}` in verdictFailed is substituted with the number of flagged items.
 */
export interface AgentCopy {
  verdictOk?: string;
  verdictFailed?: string;
  toolError?: string;
  /** Line shown when the agent's envelope guard refused the turn outright. */
  envelopeRefusal?: string;
  /** Bubble text per form action; see defaultCopy for the brandless defaults. */
  envelopeEntry?: string;
  envelopeCancel?: string;
  envelopeConfirm?: string;
  /** Bubble text for the automatic submit-check envelope (timeout recovery). */
  envelopeCheck?: string;
}

export interface ThreadRow {
  thread_id: string;
  agent_key: string;
  title: string;
  created_at: number;
  updated_at: number;
}

/** Slimmed thread message from the proxy (see server/app/events.py). */
export interface SlimMessage {
  id: string;
  role: 'user' | 'assistant';
  created_on?: string;
  text: string;
  is_async: boolean;
  tools_called: string[];
  meta: Record<string, unknown> | null;
}

/** One raw stream event as relayed by the proxy. */
export interface WireEvent {
  id?: string;
  event: string;
  data?: Record<string, unknown>;
}

/** A form ready to render (always from the contract meta key). */
export interface ActiveForm {
  contract: FormContract;
  /** Tool named in the submit envelope (contract.submitTool). */
  submitTool?: string;
  /**
   * File the same meta block carried alongside this form, offered for download
   * on the review surface. It belongs to THIS form only: a later form arrives
   * with its own meta and never inherits this one.
   */
  attachment?: DownloadAttachment;
}
