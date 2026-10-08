/**
 * The app-shell layer of wxo-custom-ui: the generic agent workspace UI.
 * A host supplies config (api base, wordmark), fetches the registry, and
 * mounts <AgentWorkspace />. Nothing here is brand- or agent-specific.
 */

// Whole-app surface
export { AgentWorkspace, LiveApp } from './components/AgentWorkspace';
export { AgentSurface } from './components/AgentSurface';

// Pieces, for a host that lays out its own chrome
export { TopBar } from './components/TopBar';
export { ThreadList, ThreadRenameEditor, commitTitle, TITLE_MAX_LENGTH } from './components/ThreadList';
export { ChatInput, autoGrowTextarea, sendsOnKey, CHAT_INPUT_MAX_ROWS } from './components/ChatInput';
export { InlineFormBlock, type FormView } from './components/InlineFormBlock';
export { NewChatIcon, SendIcon } from './components/icons';

// Boot config: the host reads its own env and passes values in
export { configureApi, apiBase } from './lib/chat/api';
export { configureBranding, applyBranding, appTitle } from './lib/view/branding';
export { DEFAULT_WORDMARK, defaultCopy } from './lib/chat/defaults';
// Deep links: ?agent=<key>&focus=1 seed the initial view (read by the shell)
export { parseDeepLink, currentSearch, type DeepLink } from './lib/view/deepLink';
// Sidebar naming: the platform titles almost every thread "start", so the shell
// derives something readable. Pure, and exported so a host can match the rule.
export {
  isStubThreadTitle, threadDisplayTitle, derivedThreadTitle, TITLE_CAP,
} from './lib/view/threadTitle';

// Proxy client
export {
  anonId,
  getRegistry,
  listThreads,
  getMessages,
  renameThread,
  fetchOptions,
  optionsRetryDelayMs,
  parseRetryAfter,
  OPTIONS_POLL_MS,
  OPTIONS_TIMEOUT_MS,
  uploadFile,
  mapUploadResponse,
  streamChat,
  type UploadedFileRow,
} from './lib/chat/api';

// Chat state machine and its pure helpers
export {
  useAgentChat,
  displayText,
  envelopeLabels,
  formAnchorIndex,
  isContextLengthError,
  isCreatedReceipt,
  looksLikeToolError,
  looksLikeEnvelopeRefusal,
  failureCopyFor,
  nextFormRound,
  restoredForm,
  reopenEntryForm,
  formArrivalFor,
  showsThinking,
  seedSurvives,
  restoredSeed,
  pendingSubmitFrom,
  receiptMessage,
  checkEnvelopeFor,
  dispatchPendingCheck,
  autoContinueEnvelope,
  AUTO_CONTINUE_DEFAULT_MS,
  ENVELOPE_SENTINEL,
  ENVELOPE_LABEL,
  type AgentChatState,
  type DisplayMessage,
  type PendingSubmit,
  type DirtyForm,
  type FormArrival,
} from './lib/chat/useAgentChat';

// Stream handling and the tool meta keys
export {
  createSseParser,
  normalizeEvent,
  thinkingCopyFor,
  type NormalizedEvent,
} from './lib/stream/streamNormalizer';
export {
  extractMeta,
  extractSignals,
  extractAttachment,
  extractAutoContinue,
  CONTRACT_META_KEY,
  VERDICT_META_KEY,
  RECEIPT_META_KEY,
  DOWNLOAD_META_KEY,
  AUTO_CONTINUE_META_KEY,
  type AutoContinue,
} from './lib/stream/toolMeta';

// Types
export type {
  ActiveForm,
  AgentCopy,
  Branding,
  BrandingColors,
  LiveRegistry,
  LiveRegistryAgent,
  SlimMessage,
  ThreadRow,
  WireEvent,
} from './lib/chat/liveTypes';
