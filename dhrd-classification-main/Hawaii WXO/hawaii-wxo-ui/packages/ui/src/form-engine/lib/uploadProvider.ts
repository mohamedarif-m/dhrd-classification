/**
 * Out-of-band file transfer.
 *
 * A `file` field captures a File the moment the user picks it, but sending the
 * bytes anywhere is the HOST's job - the engine never knows an endpoint, a
 * credential or a multipart shape; it only calls the provider it was handed
 * and renders the outcome. No provider means no upload and no behavior change
 * at all (the field stays metadata-only, exactly as it was).
 *
 * The provider resolves - it does not reject - so a failure is data the chip
 * can render. On success it returns the platform file URL, which is the only
 * thing that reaches a tool: bytes never ride the submit envelope.
 */

import { createContext, useContext } from 'react';

export interface UploadedFile {
  /** Name to show and to put in the envelope; normally the file's own name. */
  name: string;
  /** Platform file URL, fetchable from inside a wxO tool. */
  url: string;
  /** Host-side id for the stored file, when the endpoint returns one. */
  id?: string;
}

export interface UploadFailure {
  /** User-facing failure text; rendered verbatim on the chip. */
  error: string;
}

export type UploadResult = UploadedFile | UploadFailure;

/** Transfers one accepted file and resolves either its URL or an error. */
export type UploadProvider = (file: File) => Promise<UploadResult>;

export const UploadProviderContext = createContext<UploadProvider | null>(null);

export function useUploadProvider(): UploadProvider | null {
  return useContext(UploadProviderContext);
}

/** Narrows an UploadResult to the success shape. */
export function isUploadFailure(result: UploadResult): result is UploadFailure {
  return typeof (result as UploadFailure).error === 'string';
}
