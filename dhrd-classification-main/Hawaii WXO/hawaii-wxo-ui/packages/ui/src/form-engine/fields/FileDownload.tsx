import type { Field } from '../lib/contract';
import { fileExt, formatFileSize } from './FileField';

/** Read-only list of files the agent offers back (receipts, templates, letters). */
export function FileDownload({ field }: { field: Field }) {
  const files = field.files ?? [];
  return (
    <div className="fe-file">
      {files.map((f, i) => (
        <div key={`${f.name}-${i}`} className="fe-file-chip fe-file-chip--download">
          <span className="fe-file-ext">{fileExt(f.name)}</span>
          <span className="fe-file-name">{f.name}</span>
          <span className="fe-file-size">{formatFileSize(f.size)}</span>
          <a
            className="fe-file-action"
            href={f.url ?? '#'}
            download={f.name}
            onClick={f.url ? undefined : (e) => e.preventDefault()}
          >
            Download
          </a>
        </div>
      ))}
    </div>
  );
}
