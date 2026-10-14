import { createHash } from 'node:crypto';

import { MAX_DOCUMENT_BYTES } from '../contracts/parser.ts';

export function resumeExtension(mimeType: string, fileName: string): string | null {
  const extension = fileName.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (mimeType === 'application/pdf' && extension === 'pdf') return 'pdf';
  if (mimeType === 'image/jpeg' && (extension === 'jpg' || extension === 'jpeg')) return extension;
  if (mimeType === 'image/png' && extension === 'png') return 'png';
  return null;
}

export function matchesResumeSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === 'application/pdf') {
    return bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from('%PDF-'));
  }
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8))
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  return false;
}

export type ValidatedResume = Readonly<{ bytes: Uint8Array; sha256: string }>;

export async function validateStoredResume(
  blob: Blob,
  expected: Readonly<{ fileName: string; mimeType: string; sizeBytes: number }>,
): Promise<ValidatedResume | null> {
  if (!resumeExtension(expected.mimeType, expected.fileName)
    || !Number.isSafeInteger(expected.sizeBytes)
    || expected.sizeBytes < 1
    || expected.sizeBytes > MAX_DOCUMENT_BYTES
    || blob.size !== expected.sizeBytes
    || (blob.type !== '' && blob.type !== expected.mimeType)) {
    return null;
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!matchesResumeSignature(bytes, expected.mimeType)) return null;
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
