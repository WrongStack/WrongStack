import { createReadStream } from 'node:fs';
import { createInterface, type Interface } from 'node:readline';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { isColdSessionTranscriptFileName } from '../../utils/session-scoped-path.js';

export function isGzipTranscriptPath(file: string): boolean {
  return isColdSessionTranscriptFileName(file);
}

/**
 * Strip a leading byte-order mark from one transcript line.
 *
 * Journals are UTF-8 JSONL, but editors and shell redirects (`Set-Content
 * -Encoding utf8BOM`, Notepad "UTF-8 with BOM") may prefix the file with U+FEFF.
 * Every other persisted-JSON reader in core strips it before `JSON.parse`
 * (`config-json`, `goal-store`, `task-store`, `plan-store`, `annotations-store`,
 * …). Without the same rule here the marker makes the first line unparseable and
 * silently drops `session_start` — the session then reports 1970 / unknown model
 * and loses its start-of-session metadata. Only the first line of a file can
 * carry it, and a JSON object cannot legitimately begin with U+FEFF.
 */
export function stripTranscriptBom(line: string): string {
  return line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
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
