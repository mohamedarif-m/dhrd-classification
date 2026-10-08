/**
 * HROUploadZone — Gen Z MUI redesign with unified LibraryPicker.
 *
 * PD slot:         search data/IBM Classification Report Project  OR upload .docx/.doc/.md
 * Class Spec slot: search data/class specs                        OR upload .pdf/.md
 *
 * LibraryPicker calls:
 *   GET /api/library/folders               → folder list (pills)
 *   GET /api/library/files?folder=&q=      → file list
 *   GET /api/library/read?folder=&name=    → extracted text
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  OutlinedInput,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import ErrorRoundedIcon from '@mui/icons-material/ErrorRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import AttachFileRoundedIcon from '@mui/icons-material/AttachFileRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import FolderOpenRoundedIcon from '@mui/icons-material/FolderOpenRounded';
import UploadFileRoundedIcon from '@mui/icons-material/UploadFileRounded';
import { type LiveRegistryAgent } from 'wxo-custom-ui';

// ── types ─────────────────────────────────────────────────────────────────────

interface UploadedFile {
  name: string;
  url: string;
  extractedText: string;
  kind: 'pd' | 'classspec';
  source: 'upload' | 'library';
  error?: undefined;
}
interface FailedFile {
  name: string;
  kind: 'pd' | 'classspec';
  error: string;
}
type FileSlot = UploadedFile | FailedFile | null;

function isOk(slot: FileSlot): slot is UploadedFile {
  return slot !== null && !('error' in slot && slot.error);
}

interface LibraryFile {
  name: string;
  ext: string;
  size_kb: number;
  // set when loaded from a local folder pick (no server call needed)
  localFile?: File;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function getClientId(): string {
  const KEY = 'tko-anon-id';
  let id = localStorage.getItem(KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(KEY, id); }
  return id;
}

/**
 * Infer which slot a dragged file belongs to based on extension.
 * .docx/.doc  → always PD
 * .pdf        → always Class Spec
 * .md         → whichever slot is empty (PD first); if both filled → PD
 */
function inferSlot(
  filename: string,
  pdFilled: boolean,
  csFilled: boolean,
): 'pd' | 'classspec' | null {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  if (ext === '.docx' || ext === '.doc') return 'pd';
  if (ext === '.pdf') return 'classspec';
  if (ext === '.md') {
    if (!pdFilled) return 'pd';
    if (!csFilled) return 'classspec';
    return 'pd'; // both filled → replace PD
  }
  return null; // unsupported extension
}

// ── FileChip ──────────────────────────────────────────────────────────────────

function FileChip({ slot, onRemove }: { slot: FileSlot; onRemove: () => void }) {
  if (!slot) return null;
  const hasError = 'error' in slot && slot.error;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, width: '100%', minWidth: 0 }}>
      {hasError
        ? <ErrorRoundedIcon sx={{ fontSize: 14, color: 'var(--hro-accent-3)', flexShrink: 0 }} />
        : <CheckCircleRoundedIcon sx={{ fontSize: 14, color: 'var(--hro-accent-2)', flexShrink: 0 }} />}
      <Typography
        sx={{
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontSize: '0.78rem', fontWeight: 600,
          color: hasError ? 'var(--hro-accent-3)' : 'var(--hro-text)',
        }}
      >
        {slot.name}
      </Typography>
      {hasError && (
        <Typography sx={{ fontSize: '0.68rem', color: 'var(--hro-accent-3)', flex: 1 }}>
          {(slot as FailedFile).error}
        </Typography>
      )}
      <Tooltip title="Remove" placement="top" arrow>
        <IconButton
          size="small"
          onClick={onRemove}
          sx={{
            p: 0.3, flexShrink: 0,
            color: 'var(--hro-accent-3)',
            background: 'rgba(255,107,107,0.1)',
            border: '1px solid rgba(255,107,107,0.2)',
            borderRadius: '50%',
            '&:hover': { background: 'rgba(255,107,107,0.22)' },
          }}
        >
          <CloseRoundedIcon sx={{ fontSize: 11 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
}

// ── LibraryPicker (unified) ───────────────────────────────────────────────────

function LibraryPicker({
  label,
  uploadAccept,
  uploadLabel,
  uploadHint,
  defaultFolder,
  accentColor,
  accentRgb,
  slot,
  busy,
  onFileUpload,
  onFileFromLibrary,
  onRemove,
}: {
  label: string;
  uploadAccept: string;
  uploadLabel: string;
  uploadHint: string;
  /** Pre-selected folder shown when the picker first opens */
  defaultFolder: string;
  accentColor: string;
  accentRgb: string;
  slot: FileSlot;
  busy: boolean;
  onFileUpload: (f: File) => void;
  onFileFromLibrary: (name: string, text: string) => void;
  onRemove: () => void;
}) {
  const [mode, setMode] = useState<'search' | 'upload'>('search');
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  // localFolder: files loaded from a native OS folder pick (webkitdirectory)
  const [localFolderName, setLocalFolderName] = useState<string>('');
  const [localFolderFiles, setLocalFolderFiles] = useState<LibraryFile[]>([]);
  // serverFolder: files fetched from the server /api/library endpoint
  const [serverFolderName] = useState<string>(defaultFolder);
  const [serverFolderFiles, setServerFolderFiles] = useState<LibraryFile[]>([]);
  const [serverLoading, setServerLoading] = useState(false);
  // active source: 'local' after folder pick, 'server' initially
  const [source, setSource] = useState<'server' | 'local'>('server');
  const [query, setQuery] = useState('');
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const folderPickRef = useRef<HTMLInputElement>(null);
  const filled = isOk(slot);

  // Accepted extensions derived from uploadAccept prop  e.g. ".docx,.doc,.md" → [".docx",".doc",".md"]
  const acceptedExts = uploadAccept.split(',').map((s) => s.trim().toLowerCase());

  // On mount: pre-load server default folder so list shows immediately
  useEffect(() => {
    setServerLoading(true);
    fetch(`/api/library/files?folder=${encodeURIComponent(defaultFolder)}&q=`)
      .then((r) => r.ok ? r.json() : { files: [] })
      .then((data: { files: LibraryFile[] }) => setServerFolderFiles(data.files))
      .catch(() => {})
      .finally(() => setServerLoading(false));
  }, [defaultFolder]);

  // When source===server: re-fetch on query change
  useEffect(() => {
    if (mode !== 'search' || source !== 'server') return;
    const timer = setTimeout(async () => {
      setServerLoading(true);
      try {
        const url = `/api/library/files?folder=${encodeURIComponent(serverFolderName)}&q=${encodeURIComponent(query)}`;
        const resp = await fetch(url);
        if (resp.ok) {
          const data = await resp.json() as { files: LibraryFile[] };
          setServerFolderFiles(data.files);
        }
      } finally {
        setServerLoading(false);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [query, serverFolderName, source, mode]);

  // Handle native folder pick via webkitdirectory input
  const handleFolderPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    // Derive folder name from the first file's webkitRelativePath
    const firstPath = files[0].webkitRelativePath || files[0].name;
    const folderName = firstPath.includes('/') ? firstPath.split('/')[0] : 'Local Folder';
    // Filter to accepted extensions only
    const filtered: LibraryFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
      if (!acceptedExts.includes(ext)) continue;
      filtered.push({
        name: f.name,
        ext: ext.replace('.', ''),
        size_kb: Math.round(f.size / 1024 * 10) / 10,
        localFile: f,
      });
    }
    setLocalFolderName(folderName);
    setLocalFolderFiles(filtered);
    setSource('local');
    setQuery('');
    setMode('search');
    e.target.value = '';
  };

  // Compute displayed file list (filtered by query)
  const displayFiles: LibraryFile[] = (() => {
    const base = source === 'local' ? localFolderFiles : serverFolderFiles;
    if (!query.trim()) return base;
    const q = query.toLowerCase();
    return base.filter((f) => f.name.toLowerCase().includes(q));
  })();

  const loading = source === 'server' ? serverLoading : false;
  const activeFolderLabel = source === 'local' ? localFolderName : serverFolderName;

  // Select a file from the list
  const handleLibrarySelect = async (file: LibraryFile) => {
    setLoadingFile(file.name);
    try {
      if (file.localFile) {
        // Local file: read directly in the browser
        const text = await file.localFile.text();
        onFileFromLibrary(file.name, text);
      } else {
        // Server file: fetch extracted text via API
        const url = `/api/library/read?folder=${encodeURIComponent(serverFolderName)}&name=${encodeURIComponent(file.name)}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json() as { name: string; extracted_text: string };
        onFileFromLibrary(data.name, data.extracted_text);
      }
    } catch (e) {
      console.error(`Failed to load ${label}:`, e);
    } finally {
      setLoadingFile(null);
    }
  };

  // Ext badge colours
  const extColor = (ext: string) =>
    ext === 'md' ? '#06d6a0'
    : ext === 'pdf' ? '#ff6b6b'
    : '#a78bfa';
  const extBg = (ext: string) =>
    ext === 'md' ? 'rgba(6,214,160,0.18)'
    : ext === 'pdf' ? 'rgba(255,107,107,0.15)'
    : 'rgba(124,92,246,0.18)';

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>

      {/* Hidden folder picker input (webkitdirectory) */}
      <input
        ref={folderPickRef}
        type="file"
        // @ts-expect-error webkitdirectory is non-standard but widely supported
        webkitdirectory=""
        multiple
        style={{ display: 'none' }}
        onChange={handleFolderPick}
      />

      {/* Label row */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography sx={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--hro-text)' }}>
          {label}
        </Typography>
        <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
          {/* Active folder badge */}
          {mode === 'search' && activeFolderLabel && (
            <Tooltip title={activeFolderLabel} arrow>
              <Typography sx={{
                fontSize: '0.65rem', fontWeight: 600, color: accentColor,
                background: `rgba(${accentRgb},0.12)`, border: `1px solid rgba(${accentRgb},0.3)`,
                borderRadius: '20px', px: 0.9, py: 0.15, lineHeight: 1.5,
                maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                cursor: 'default',
              }}>
                {activeFolderLabel}
              </Typography>
            </Tooltip>
          )}
          {/* Folder icon → opens native OS folder picker */}
          <Tooltip title="Open folder…" arrow>
            <IconButton
              size="small"
              onClick={() => folderPickRef.current?.click()}
              sx={{
                p: 0.4, borderRadius: '8px',
                color: mode === 'search' ? 'var(--hro-accent-1)' : 'var(--hro-muted)',
                background: mode === 'search' ? 'rgba(124,92,246,0.15)' : 'transparent',
                '&:hover': { background: 'rgba(124,92,246,0.15)' },
              }}>
              <FolderOpenRoundedIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
          {/* Upload icon → single file picker */}
          <Tooltip title="Upload single file" arrow>
            <IconButton size="small" onClick={() => setMode('upload')}
              sx={{
                p: 0.4, borderRadius: '8px',
                color: mode === 'upload' ? accentColor : 'var(--hro-muted)',
                background: mode === 'upload' ? `rgba(${accentRgb},0.15)` : 'transparent',
                '&:hover': { background: `rgba(${accentRgb},0.15)` },
              }}>
              <UploadFileRoundedIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* ── Filled state ── */}
      {filled ? (
        <Box sx={{
          border: `1.5px solid ${accentColor}`, borderRadius: '12px',
          p: '10px 12px', display: 'flex', alignItems: 'center', gap: 1,
          background: `rgba(${accentRgb},0.08)`,
          boxShadow: `0 0 0 2px rgba(${accentRgb},0.2)`,
        }}>
          <CheckCircleRoundedIcon sx={{ fontSize: 16, color: accentColor, flexShrink: 0 }} />
          <FileChip slot={slot} onRemove={onRemove} />
        </Box>

      ) : mode === 'search' ? (
        /* ── Search mode ── */
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>

          {/* Search input */}
          <OutlinedInput
            size="small"
            placeholder={`Search in ${activeFolderLabel || 'folder'}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            startAdornment={
              <InputAdornment position="start">
                <SearchRoundedIcon sx={{ fontSize: 16, color: 'var(--hro-muted)' }} />
              </InputAdornment>
            }
            endAdornment={loading ? (
              <InputAdornment position="end">
                <CircularProgress size={12} sx={{ color: 'var(--hro-accent-1)' }} />
              </InputAdornment>
            ) : null}
            sx={{
              fontSize: '0.8rem', color: 'var(--hro-text)', borderRadius: '10px',
              background: 'rgba(124,92,246,0.06)',
              '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(124,92,246,0.35)' },
              '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--hro-accent-1)' },
              '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--hro-accent-1)', borderWidth: '1.5px' },
              input: { color: 'var(--hro-text)', py: '7px' },
            }}
          />

          {/* Results list */}
          {displayFiles.length > 0 && (
            <Box sx={{
              border: '1px solid rgba(124,92,246,0.25)', borderRadius: '10px',
              background: 'rgba(11,15,26,0.92)', backdropFilter: 'blur(12px)',
              maxHeight: 180, overflowY: 'auto',
              '&::-webkit-scrollbar': { width: 4 },
              '&::-webkit-scrollbar-thumb': { background: 'rgba(124,92,246,0.3)', borderRadius: 2 },
            }}>
              <List dense disablePadding>
                {displayFiles.map((f, i) => (
                  <Box key={f.name}>
                    {i > 0 && <Divider sx={{ borderColor: 'rgba(255,255,255,0.05)' }} />}
                    <ListItemButton
                      disabled={loadingFile === f.name}
                      onClick={() => handleLibrarySelect(f)}
                      sx={{
                        py: 0.6, px: 1.25, gap: 1, color: '#e8e8ff',
                        '&:hover': { background: 'rgba(124,92,246,0.15)', color: '#fff' },
                        '&.Mui-disabled': { opacity: 0.5 },
                      }}
                    >
                      <Typography component="span" sx={{
                        fontSize: '0.62rem', fontWeight: 700, fontFamily: 'monospace',
                        px: 0.5, py: 0.2, borderRadius: '4px', flexShrink: 0,
                        textTransform: 'uppercase',
                        background: extBg(f.ext), color: extColor(f.ext),
                      }}>
                        {f.ext}
                      </Typography>
                      <ListItemText
                        primary={f.name.replace(/\.(docx|doc|pdf|md)$/i, '')}
                        secondary={`${f.size_kb} KB`}
                        slotProps={{
                          primary: { style: { fontSize: '0.8rem', color: '#e8e8ff', fontWeight: 600, lineHeight: 1.3 } },
                          secondary: { style: { fontSize: '0.65rem', color: 'rgba(200,200,240,0.55)' } },
                        }}
                      />
                      {loadingFile === f.name && (
                        <CircularProgress size={12} sx={{ color: '#a78bfa', flexShrink: 0 }} />
                      )}
                    </ListItemButton>
                  </Box>
                ))}
              </List>
            </Box>
          )}

          {!loading && displayFiles.length === 0 && query.length > 0 && (
            <Typography sx={{ fontSize: '0.72rem', color: 'var(--hro-muted)', px: 0.5 }}>
              No files found.
            </Typography>
          )}
          {query.length === 0 && displayFiles.length === 0 && !loading && (
            <Typography sx={{ fontSize: '0.72rem', color: 'var(--hro-muted)', px: 0.5 }}>
              {source === 'local'
                ? `No supported files in ${activeFolderLabel}.`
                : <>Click <FolderOpenRoundedIcon sx={{ fontSize: 13, verticalAlign: 'middle', mx: 0.3 }} /> to open a folder…</>}
            </Typography>
          )}
        </Box>

      ) : (
        /* ── Upload mode ── */
        <Box
          onClick={() => !busy && uploadRef.current?.click()}
          role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') uploadRef.current?.click(); }}
          onDragOver={(e) => { e.preventDefault(); if (!busy) setIsDraggingOver(true); }}
          onDragLeave={() => setIsDraggingOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDraggingOver(false);
            if (busy) return;
            const f = e.dataTransfer.files?.[0];
            if (f) onFileUpload(f);
          }}
          sx={{
            border: isDraggingOver
              ? `1.5px solid ${accentColor}`
              : `1.5px dashed rgba(${accentRgb},0.4)`,
            borderRadius: '12px',
            p: '10px 12px', display: 'flex', alignItems: 'center', gap: 1,
            cursor: 'pointer', background: isDraggingOver ? `rgba(${accentRgb},0.14)` : `rgba(${accentRgb},0.05)`,
            transition: 'all 0.2s', outline: 'none',
            boxShadow: isDraggingOver ? `0 0 0 3px rgba(${accentRgb},0.25)` : 'none',
            '&:hover': {
              borderColor: accentColor, background: `rgba(${accentRgb},0.1)`,
              boxShadow: `0 0 0 3px rgba(${accentRgb},0.15)`,
            },
          }}
        >
          <input ref={uploadRef} type="file" accept={uploadAccept}
            style={{ display: 'none' }} disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFileUpload(f); e.target.value = ''; }}
          />
          <UploadFileRoundedIcon sx={{ fontSize: 20, color: isDraggingOver ? accentColor : `rgba(${accentRgb},0.7)`, flexShrink: 0 }} />
          <Box>
            <Typography sx={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--hro-text)', lineHeight: 1.3 }}>
              {isDraggingOver ? 'Drop to upload' : uploadLabel}
            </Typography>
            <Typography sx={{ fontSize: '0.68rem', color: 'var(--hro-muted)', fontFamily: 'monospace' }}>
              {uploadHint}
            </Typography>
          </Box>
        </Box>
      )}
    </Box>
  );
}

// ── main export ───────────────────────────────────────────────────────────────

export interface HROFiles {
  pdName: string; pdUrl: string; pdText: string;
  csName: string; csUrl: string; csText: string;
}

export function HROUploadZone({
  agent,
  onSubmit,
}: {
  agent: LiveRegistryAgent;
  onSubmit: (message: string, files: HROFiles) => Promise<void>;
}) {
  const [pdSlot, setPdSlot] = useState<FileSlot>(null);
  const [csSlot, setCsSlot] = useState<FileSlot>(null);
  const [uploading, setUploading] = useState<Set<'pd' | 'classspec'>>(new Set());
  const [dismissed, setDismissed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Panel-level drag state
  const [panelDragTarget, setPanelDragTarget] = useState<'pd' | 'classspec' | null>(null);
  const dragCounterRef = useRef(0); // track nested dragenter/dragleave

  const uploadFile = useCallback(async (file: File, kind: 'pd' | 'classspec'): Promise<void> => {
    if (uploading.has(kind) || submitting) return;
    setSubmitError(null);
    setUploading((s) => new Set([...s, kind]));
    let slot: UploadedFile | FailedFile;
    try {
      const form = new FormData();
      form.append('file', file);
      const resp = await fetch('/api/uploads', {
        method: 'POST',
        headers: { 'X-TKO-Client': getClientId() },
        body: form,
      });
      if (!resp.ok) {
        slot = { name: file.name, kind, error: `Upload failed (HTTP ${resp.status})` };
      } else {
        const body = await resp.json() as {
          files?: Array<{ url?: string; fileName?: string }>;
          extracted_text?: string;
        };
        const row = body.files?.[0];
        if (row?.url) {
          slot = { name: row.fileName || file.name, url: row.url, extractedText: body.extracted_text ?? '', kind, source: 'upload' };
        } else {
          slot = { name: file.name, kind, error: 'Upload failed. Try again.' };
        }
      }
    } catch {
      slot = { name: file.name, kind, error: 'Upload failed. Try again.' };
    }
    setUploading((s) => { const n = new Set(s); n.delete(kind); return n; });
    kind === 'pd' ? setPdSlot(slot) : setCsSlot(slot);
  }, [uploading, submitting]);

  const handlePDLibrarySelect = useCallback((name: string, text: string) => {
    setPdSlot({ name, url: '', extractedText: text, kind: 'pd', source: 'library' });
  }, []);

  const handleCSLibrarySelect = useCallback((name: string, text: string) => {
    setCsSlot({ name, url: '', extractedText: text, kind: 'classspec', source: 'library' });
  }, []);

  const bothReady = isOk(pdSlot) && isOk(csSlot);
  const busy = uploading.size > 0 || submitting;

  // Panel-level drag handlers — use a counter to survive child dragenter/leave.
  // During dragenter, file names are security-restricted; infer slot from MIME type instead.
  const handlePanelDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) {
      const mime = e.dataTransfer.items?.[0]?.type ?? '';
      // Map MIME → synthetic filename for inferSlot
      const synthetic =
        mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ? 'f.docx'
        : mime === 'application/msword' ? 'f.doc'
        : mime === 'application/pdf' ? 'f.pdf'
        : mime === 'text/markdown' || mime === 'text/plain' ? 'f.md'
        : '';
      const target = synthetic ? inferSlot(synthetic, isOk(pdSlot), isOk(csSlot)) : 'pd';
      setPanelDragTarget(target);
    }
  }, [pdSlot, csSlot]);

  const handlePanelDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault(); // required to allow drop
  }, []);

  const handlePanelDragLeave = useCallback(() => {
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) setPanelDragTarget(null);
  }, []);

  const handlePanelDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    const file = e.dataTransfer.files?.[0];
    if (!file) { setPanelDragTarget(null); return; }
    // On drop the actual filename is available — use it for precise routing
    const target = inferSlot(file.name, isOk(pdSlot), isOk(csSlot));
    setPanelDragTarget(null);
    if (target) uploadFile(file, target);
    // If extension is unsupported, silently ignore (no error shown for random drops)
  }, [pdSlot, csSlot, uploadFile]);

  if (agent.key !== 'hro-classifier') return null;

  if (dismissed) {
    return (
      <Button
        startIcon={<AttachFileRoundedIcon sx={{ fontSize: 15 }} />}
        onClick={() => setDismissed(false)}
        aria-label="Open file upload panel"
        sx={{
          position: 'absolute', bottom: '4.25rem', left: '50%',
          transform: 'translateX(-50%)', zIndex: 10,
          background: 'rgba(124,92,246,0.15)', border: '1px solid rgba(124,92,246,0.4)',
          borderRadius: '999px', px: 2, py: 0.6, fontSize: '0.82rem', fontWeight: 600,
          color: '#c4b5fd', whiteSpace: 'nowrap', backdropFilter: 'blur(12px)',
          textTransform: 'none', boxShadow: '0 4px 18px rgba(124,92,246,0.2)',
          '&:hover': {
            background: 'rgba(124,92,246,0.28)', color: '#ddd6fe',
            transform: 'translateX(-50%) translateY(-1px)',
          },
        }}
      >
        Upload files to classify
      </Button>
    );
  }

  // Overlay label and colors based on drag target
  const overlayAccentRgb = panelDragTarget === 'pd' ? '124,92,246' : '6,214,160';
  const overlayAccentColor = panelDragTarget === 'pd' ? '#7c5cf6' : '#06d6a0';
  const overlayLabel = panelDragTarget === 'pd' ? 'Drop as Position Description' : 'Drop as Class Spec';
  const overlayHint = panelDragTarget === 'pd' ? '.docx · .doc · .md' : '.pdf · .md';

  return (
    <div
      className="hro-upload-zone"
      aria-label="Upload files to classify"
      onDragEnter={handlePanelDragEnter}
      onDragOver={handlePanelDragOver}
      onDragLeave={handlePanelDragLeave}
      onDrop={handlePanelDrop}
      style={{ position: 'relative' }}
    >
      {/* ── Full-panel drag overlay ── */}
      {panelDragTarget && (
        <Box sx={{
          position: 'absolute', inset: 0, zIndex: 20,
          borderRadius: '16px',
          border: `2px solid ${overlayAccentColor}`,
          background: `rgba(${overlayAccentRgb},0.13)`,
          backdropFilter: 'blur(6px)',
          boxShadow: `0 0 0 4px rgba(${overlayAccentRgb},0.2)`,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 1.5,
          pointerEvents: 'none',
        }}>
          <UploadFileRoundedIcon sx={{ fontSize: 40, color: overlayAccentColor }} />
          <Typography sx={{
            fontSize: '1rem', fontWeight: 700, color: overlayAccentColor,
            textAlign: 'center', lineHeight: 1.3,
          }}>
            {overlayLabel}
          </Typography>
          <Typography sx={{
            fontSize: '0.72rem', fontFamily: 'monospace',
            color: `rgba(${overlayAccentRgb},0.75)`,
          }}>
            {overlayHint}
          </Typography>
        </Box>
      )}
      <div className="hro-upload-zone-inner">

        {/* ── Header ── */}
        <div className="hro-upload-header">
          <div className="hro-upload-header-row">
            <h3 className="hro-upload-title">Upload Documents</h3>
            <Tooltip title="Dismiss panel" placement="top" arrow>
              <IconButton size="small" className="hro-upload-close"
                aria-label="Dismiss" onClick={() => setDismissed(true)} sx={{ p: 0.4 }}>
                <CloseRoundedIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          </div>
          <p className="hro-upload-subtitle">
            Pick a PD, then pick or upload a Class Spec to{' '}
            <strong style={{ color: '#a78bfa' }}>Classify</strong>.
          </p>
        </div>

        {/* ── Position Description ── */}
        {uploading.has('pd') ? (
          <Box sx={{
            display: 'flex', alignItems: 'center', gap: 1, p: '10px 12px',
            border: '1.5px dashed rgba(124,92,246,0.3)', borderRadius: '12px',
            background: 'rgba(124,92,246,0.06)',
          }}>
            <span className="hro-uploading-dot" />
            <Typography sx={{ fontSize: '0.75rem', color: 'var(--hro-muted)' }}>Uploading PD…</Typography>
            <CircularProgress size={14} sx={{ color: 'var(--hro-accent-1)', ml: 'auto' }} />
          </Box>
        ) : (
          <LibraryPicker
            label="Position Description"
            uploadAccept=".docx,.doc,.md"
            uploadLabel="Upload Position Description"
            uploadHint=".docx · .doc · .md"
            defaultFolder="IBM Classification Report Project"
            accentColor="var(--hro-accent-1)"
            accentRgb="124,92,246"
            slot={pdSlot}
            busy={busy}
            onFileUpload={(f) => uploadFile(f, 'pd')}
            onFileFromLibrary={handlePDLibrarySelect}
            onRemove={() => setPdSlot(null)}
          />
        )}

        <Divider sx={{ borderColor: 'rgba(255,255,255,0.07)' }} />

        {/* ── Class Specification ── */}
        {uploading.has('classspec') ? (
          <Box sx={{
            display: 'flex', alignItems: 'center', gap: 1, p: '10px 12px',
            border: '1.5px dashed rgba(6,214,160,0.3)', borderRadius: '12px',
            background: 'rgba(6,214,160,0.05)',
          }}>
            <span className="hro-uploading-dot" />
            <Typography sx={{ fontSize: '0.75rem', color: 'var(--hro-muted)' }}>Uploading Spec…</Typography>
            <CircularProgress size={14} sx={{ color: 'var(--hro-accent-2)', ml: 'auto' }} />
          </Box>
        ) : (
          <LibraryPicker
            label="Class Specification"
            uploadAccept=".pdf,.md"
            uploadLabel="Upload Class Spec"
            uploadHint=".pdf · .md"
            defaultFolder="class specs"
            accentColor="var(--hro-accent-2)"
            accentRgb="6,214,160"
            slot={csSlot}
            busy={busy}
            onFileUpload={(f) => uploadFile(f, 'classspec')}
            onFileFromLibrary={handleCSLibrarySelect}
            onRemove={() => setCsSlot(null)}
          />
        )}

        {/* ── Status chips ── */}
        {(isOk(pdSlot) || isOk(csSlot)) && (
          <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>
            {isOk(pdSlot) && (
              <Chip
                icon={<CheckCircleRoundedIcon />}
                label={(pdSlot as UploadedFile).source === 'library' ? 'PD from library' : 'PD ready'}
                size="small"
                sx={{
                  background: 'rgba(6,214,160,0.12)', border: '1px solid rgba(6,214,160,0.3)',
                  color: 'var(--hro-accent-2)', fontWeight: 700, fontSize: '0.7rem',
                  '& .MuiChip-icon': { color: 'var(--hro-accent-2)', fontSize: 14 },
                }}
              />
            )}
            {isOk(csSlot) && (
              <Chip
                icon={<CheckCircleRoundedIcon />}
                label={(csSlot as UploadedFile).source === 'library' ? 'Spec from library' : 'Spec ready'}
                size="small"
                sx={{
                  background: 'rgba(6,214,160,0.12)', border: '1px solid rgba(6,214,160,0.3)',
                  color: 'var(--hro-accent-2)', fontWeight: 700, fontSize: '0.7rem',
                  '& .MuiChip-icon': { color: 'var(--hro-accent-2)', fontSize: 14 },
                }}
              />
            )}
          </Stack>
        )}

        {/* ── Error ── */}
        {submitError && <p role="alert" className="hro-upload-error">{submitError}</p>}

        {/* ── Classify button ── */}
        <div className="hro-upload-footer">
          <button
            type="button"
            className={`hro-classify-btn${bothReady && !busy ? ' hro-classify-btn--ready' : ''}`}
            disabled={!bothReady || busy}
            onClick={async () => {
              if (!bothReady) return;
              setSubmitting(true);
              setSubmitError(null);
              try {
                await onSubmit('Classify PD', {
                  pdName: (pdSlot as UploadedFile).name,
                  pdUrl:  (pdSlot as UploadedFile).url,
                  pdText: (pdSlot as UploadedFile).extractedText,
                  csName: (csSlot as UploadedFile).name,
                  csUrl:  (csSlot as UploadedFile).url,
                  csText: (csSlot as UploadedFile).extractedText,
                });
              } catch (error) {
                setSubmitError(error instanceof Error ? error.message : 'Could not start classification.');
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting
              ? <><CircularProgress size={13} sx={{ color: 'rgba(255,255,255,0.85)', mr: 0.75, verticalAlign: 'middle' }} /> Starting…</>
              : uploading.size > 0 ? 'Uploading…'
              : '✦ Classify'}
          </button>
        </div>

      </div>
    </div>
  );
}
