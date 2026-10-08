/**
 * Package-level fallback copy. Brandless by definition: anything naming a
 * client system or a deployment's identity must come from registry data or
 * from the host's own config, never from these defaults.
 *
 * The live app takes its wording from the registry's `branding` block and each
 * agent's `copy` block; these values only apply before the registry loads or
 * when a key is not configured.
 */

/** Wordmark shown in the top bar until a host or the registry names one. */
export const DEFAULT_WORDMARK = 'Agent Workspace';

/**
 * Copy the workspace falls back to when neither the registry agent nor the
 * host overrides it.
 */
export const defaultCopy = {
  verdictOk: 'Everything checks out.',
  verdictFailed: (n: number) => `${n} item(s) need attention - see the form.`,
  toolError: 'Something went wrong checking your entries - your values are kept, try again.',
  /**
   * Shown when the agent's envelope guard refused the turn (see
   * looksLikeEnvelopeRefusal). The guard fires BEFORE any tool runs, so the
   * one fact that matters is that nothing happened - say it plainly and offer
   * the same action again.
   */
  envelopeRefusal:
    'The agent did not accept that form action, so nothing was sent - your '
    + 'entries are kept.',
  /** Bubble text for a submit envelope, by the action that produced it.
   * Chosen at send time; a registry agent can override each one. */
  envelopeEntry: 'Submitting entries...',
  envelopeCancel: 'Going back to edit...',
  envelopeConfirm: 'Submitting...',
  /** Bubble text for the automatic check envelope sent when a submit turn
   * ends pending (see ReviewModel.checkTool). */
  envelopeCheck: 'Checking what happened...',
};
