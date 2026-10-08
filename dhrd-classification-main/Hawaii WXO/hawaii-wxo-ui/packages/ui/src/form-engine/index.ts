/**
 * Public surface of the form-engine layer.
 *
 * The folder is arranged by kind, and this file is the only place the two
 * kinds meet:
 *   lib/         contract types and pure logic (no React, no DOM)
 *   components/  the React surfaces a host mounts
 *   fields/      the per-field-type renderers components/FieldResolver picks
 *
 * The export list below is the compatibility contract: names are grouped by
 * where they now live, but nothing about what is exported depends on that.
 */

// ---- lib: contract, pure logic, providers ----
export * from './lib/contract';
export * from './lib/theme';
export * from './lib/config';
export * from './lib/validation';
export * from './lib/money';
export * from './lib/behaviors';
export * from './lib/visibleWhen';
export * from './lib/review';
export * from './lib/hierarchy';
export * from './lib/optionsProvider';
export * from './lib/rowIntegrity';
export * from './lib/useRemoteRows';
export * from './lib/uploadProvider';
export * from './lib/thinkingCopy';
export * from './lib/time';
export * from './lib/uploadLimits';
// Named, not `export *`: `prefersReducedMotion` stays internal here because
// app-shell's autoScroll owns a function of that name, and this file's
// no-collision rule (see src/index.ts) is worth more than the symmetry.
export {
  errorSummaryText, focusTargetFor, scrollAndFocusField,
} from './lib/errorNavigation';

// ---- components ----
export { FieldResolver, type FieldResolverProps } from './components/FieldResolver';
export { FormRenderer, type FormRendererProps } from './components/FormRenderer';
export {
  FormAnnotations, notesNotAlreadySaid, type FormAnnotationsProps,
} from './components/FormAnnotations';
export { ReviewPanel, type ReviewPanelProps } from './components/ReviewPanel';
export { ReceiptCard, type ReceiptCardProps } from './components/ReceiptCard';
export {
  ThinkingState,
  type ThinkingStateProps,
  type ThinkingStage,
} from './components/ThinkingState';
export {
  ChatMessage,
  ChatStream,
  type ChatMessageProps,
  type ChatRole,
} from './components/Chat';
export { ErrorCard, type ErrorCardProps } from './components/ErrorCard';
export { FormEngineTheme } from './components/FormEngineTheme';
