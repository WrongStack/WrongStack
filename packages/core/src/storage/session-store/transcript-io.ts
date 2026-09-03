import { createReadStream } from 'node:fs';
import { createInterface, type Interface } from 'node:readline';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { isColdSessionTranscriptFileName } from '../../utils/session-scoped-path.js';

export function isGzipTranscriptPath(file: string): boolean {
  return isColdSessionTranscriptFileName(file);
}

/**
 * Byte stream of transcript *lines* (uncompressed JSONL). Gzip archives are
 * inflated here so every reader stays encoding-agnostic.
 */
export function openTranscriptByteStream(file: string): {
  input: Readable;
  source: Readable;
  compressed: boolean;
} {
  const source = createReadStream(file);
  if (!isGzipTranscriptPath(file)) {
    return { input: source, source, compressed: false };
  }
  const input = createGunzip();
  // Forward errors both ways. `.pipe` does not, and an unhandled gunzip
  // error leaves the file handle open — Windows then EPERM on the later
  // archive/rehydrate unlink.
  source.on('error', (error) => {
    input.destroy(error);
  });
  input.on('error', (error) => {
    source.destroy(error);
  });
  source.pipe(input);
  return { input, source, compressed: true };
}

export function createTranscriptLineReader(file: string): {
  lines: Interface;
  source: Readable;
  compressed: boolean;
  close: () => void;
} {
  const opened = openTranscriptByteStream(file);
  const lines = createInterface({ input: opened.input, crlfDelay: Infinity });
  return {
    lines,
    source: opened.source,
    compressed: opened.compressed,
    close() {
      lines.close();
      opened.input.destroy();
      if (opened.source !== opened.input) opened.source.destroy();
    },
  };
}
