/**
 * Default upload constraints when the contract does not set its own.
 * Values mirror the wxO platform's own uploadSettings (10 MB single-file cap,
 * document formats CSV/DOC/DOCX/JPEG/PDF/PNG/WAV/XLS/XLSX/XLSM/PPT/PPTX) -
 * see docs/adk-chat-dossier.md, "uploadSettings". Contracts override per field.
 */
export const DEFAULT_MAX_FILE_MB = 10;
export const DEFAULT_ACCEPT =
  '.csv,.doc,.docx,.jpeg,.jpg,.pdf,.png,.wav,.xls,.xlsx,.xlsm,.ppt,.pptx';
export const DEFAULT_MAX_FILES = 1;
