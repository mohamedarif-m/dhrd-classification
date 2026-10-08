import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { Field, FileValue } from '../lib/contract';
import { DEFAULT_ACCEPT, DEFAULT_MAX_FILES, DEFAULT_MAX_FILE_MB } from '../lib/uploadLimits';
import { isUploadFailure, useUploadProvider, type UploadProvider } from '../lib/uploadProvider';

interface Props {
  field: Field;
  value: FileValue[];
  invalid: boolean;
  onChange: (value: FileValue[]) => void;
  onBlur: () => void;
}

/** Empty for an unknown size: a chip seeded from defaultValue carries no bytes. */
export function formatFileSize(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toUpperCase() : 'FILE';
}

/** Mutable handle on the chip one upload owns, across every status swap. */
interface Track { current: FileValue }

const GENERIC_FAILURE = 'Upload failed. Try again.';

/**
 * Upload field: drag-drop zone + native chooser, chips with remove/replace,
 * single or multi (maxFiles), type/size checked inline BEFORE any network call.
 *
 * Transfer is the host's, via an UploadProvider from context. With one, every
 * accepted file uploads immediately and its chip walks uploading -> uploaded /
 * failed (failed offers Retry). Without one, nothing is ever sent and the field
 * behaves exactly as it did: name, size and type only.
 */
export function FileField({ field, value, invalid, onChange, onBlur }: Props) {
  const accept = field.accept ?? DEFAULT_ACCEPT;
  const maxSizeMb = field.maxSizeMb ?? DEFAULT_MAX_FILE_MB;
  const maxFiles = field.maxFiles ?? DEFAULT_MAX_FILES;
  const upload = useUploadProvider();

  const inputRef = useRef<HTMLInputElement>(null);
  // null = append; a number = replace the chip at that index.
  const replaceIndex = useRef<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // An upload resolves long after the click that started it, so the async path
  // never reads the render-time `value`: it reads this mirror, and it locates
  // its own chip by OBJECT IDENTITY. A chip removed or replaced in the meantime
  // is simply not there, and the late result is dropped.
  const valueRef = useRef(value);
  valueRef.current = value;
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => { liveRef.current = false; };
  }, []);
  // Chip -> the File behind it, so Retry can re-send the original bytes.
  const sources = useRef(new Map<FileValue, { file: File; track: Track }>());

  const checkFile = (f: File): string | null => {
    const allowed = accept.split(',').map((a) => a.trim().toLowerCase());
    const ext = `.${fileExt(f.name).toLowerCase()}`;
    if (!allowed.includes(ext)) return `${f.name}: type not accepted (${accept}).`;
    if (f.size > maxSizeMb * 1024 * 1024) {
      return `${f.name}: larger than the ${maxSizeMb} MB limit.`;
    }
    return null;
  };

  /** Swap one chip in place. Returns false when its chip is gone (stale result). */
  const updateChip = (track: Track, next: FileValue): boolean => {
    const current = valueRef.current;
    const idx = current.indexOf(track.current);
    if (idx < 0) return false;
    const arr = [...current];
    arr[idx] = next;
    const source = sources.current.get(track.current);
    sources.current.delete(track.current);
    if (source) sources.current.set(next, source);
    track.current = next;
    valueRef.current = arr;
    onChange(arr);
    return true;
  };

  const runUpload = (provider: UploadProvider, file: File, track: Track) => {
    const { name, size, type } = track.current;
    provider(file).then(
      (result) => {
        if (!liveRef.current) return;
        if (isUploadFailure(result)) {
          updateChip(track, { name, size, type, status: 'failed', error: result.error });
        } else {
          updateChip(track, {
            name: result.name || name,
            size,
            type,
            url: result.url,
            uploadId: result.id,
            status: 'uploaded',
          });
        }
      },
      () => {
        if (!liveRef.current) return;
        updateChip(track, { name, size, type, status: 'failed', error: GENERIC_FAILURE });
      },
    );
  };

  /** Commit accepted files, then start their uploads against the committed array. */
  const commit = (next: FileValue[], started: { file: File; meta: FileValue }[]) => {
    valueRef.current = next;
    onChange(next);
    if (!upload) return;
    for (const { file, meta } of started) {
      const track: Track = { current: meta };
      sources.current.set(meta, { file, track });
      runUpload(upload, file, track);
    }
  };

  const addFiles = (incoming: File[]) => {
    const target = replaceIndex.current;
    replaceIndex.current = null;
    setLocalError(null);

    for (const f of incoming) {
      const problem = checkFile(f);
      if (problem) {
        setLocalError(problem);
        return;
      }
    }

    const metas: FileValue[] = incoming.map((f) => ({
      name: f.name,
      size: f.size,
      type: f.type,
      ...(upload ? { status: 'uploading' as const } : {}),
    }));
    const started = incoming.map((file, i) => ({ file, meta: metas[i] }));

    // A single-file field REPLACES on every pick: choosing (or dropping) a
    // file when one is already there means "use this one instead", never a
    // silent no-op. Multi-file fields keep the room check below.
    const singleReplace = target === null && maxFiles === 1
      && metas.length === 1 && valueRef.current.length > 0;
    const at = singleReplace ? 0 : target;

    if (at !== null && at < valueRef.current.length && metas.length > 0) {
      const next = [...valueRef.current];
      sources.current.delete(next[at]);
      next[at] = metas[0];
      commit(next, started.slice(0, 1));
      return;
    }
    const room = maxFiles - valueRef.current.length;
    if (metas.length > room) {
      setLocalError(`Up to ${maxFiles} file${maxFiles > 1 ? 's' : ''} allowed.`);
      return;
    }
    commit([...valueRef.current, ...metas], started);
  };

  const retry = (chip: FileValue) => {
    const source = sources.current.get(chip);
    if (!upload || !source) return;
    const { name, size, type } = chip;
    if (!updateChip(source.track, { name, size, type, status: 'uploading' })) return;
    runUpload(upload, source.file, source.track);
  };

  const remove = (index: number) => {
    setLocalError(null);
    // An in-flight upload is left to finish; its result finds no chip and is
    // dropped by updateChip's identity check.
    sources.current.delete(valueRef.current[index]);
    const next = valueRef.current.filter((_, j) => j !== index);
    valueRef.current = next;
    onChange(next);
  };

  const openPicker = (forIndex: number | null) => {
    replaceIndex.current = forIndex;
    inputRef.current?.click();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    addFiles([...e.dataTransfer.files]);
  };

  // The drop zone hides once a multi-file field is full - there is nothing a
  // pick could do. A single-file field keeps it: the next pick replaces.
  const full = maxFiles > 1 && value.length >= maxFiles;
  const replacing = maxFiles === 1 && value.length > 0;

  return (
    <div className="fe-file">
      <input
        ref={inputRef}
        id={field.id}
        type="file"
        accept={accept}
        multiple={maxFiles > 1}
        hidden
        onBlur={onBlur}
        onChange={(e) => {
          addFiles([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />

      {!full && (
        <div
          className={`fe-file-drop${dragOver ? ' fe-file-drop--over' : ''}${invalid ? ' fe-file-drop--invalid' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <button type="button" className="fe-file-cta" onClick={() => openPicker(null)}>
            {replacing ? 'Choose a different file' : 'Choose a file'}
          </button>
          <span className="fe-file-hint">
            {replacing ? 'or drag one here, it replaces the file below' : 'or drag it here'}
            {' · '}{accept} · up to {maxSizeMb} MB
            {maxFiles > 1 ? ` · max ${maxFiles} files` : ''}
          </span>
        </div>
      )}

      {localError && <p className="fe-error" role="alert">{localError}</p>}

      {value.map((f, i) => (
        <div
          key={`${f.name}-${i}`}
          className={`fe-file-chip${f.status === 'failed' ? ' fe-file-chip--failed' : ''}`}
        >
          <span className="fe-file-ext">{fileExt(f.name)}</span>
          <span className="fe-file-name">{f.name}</span>
          {/* A chip seeded from defaultValue has no bytes to report. */}
          {formatFileSize(f.size) && (
            <span className="fe-file-size">{formatFileSize(f.size)}</span>
          )}
          {f.status === 'uploading' && (
            <span className="fe-file-status">
              <span className="fe-file-spinner" aria-hidden="true" />
              Uploading...
            </span>
          )}
          {f.status === 'failed' && (
            <span className="fe-file-status fe-file-status--failed" role="alert">
              {f.error || GENERIC_FAILURE}
            </span>
          )}
          <span className="fe-file-actions">
            {/* Retry needs the original bytes; a chip with no source behind it
              * (seeded from defaultValue) offers Replace instead. */}
            {f.status === 'failed' && sources.current.has(f) && (
              <button type="button" className="fe-file-action" onClick={() => retry(f)}>
                Retry
              </button>
            )}
            <button type="button" className="fe-file-action" onClick={() => openPicker(i)}>
              Replace
            </button>
            <button
              type="button"
              className="fe-file-action fe-file-action--remove"
              onClick={() => remove(i)}
            >
              Remove
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
