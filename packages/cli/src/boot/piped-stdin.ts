/**
 * Piped-stdin context for single-shot runs: `git diff | wstack "review this"`.
 *
 * The prompt still comes from argv; whatever was piped in is appended to it as
 * context. Only single-shot mode reads it — the REPL and TUI own stdin.
 *
 * A parent process can hand us an open pipe it never writes to (a harness
 * spawning `wstack` with default stdio), which would block forever waiting for
 * EOF. So the read gives up if no first byte arrives within
 * `firstByteTimeoutMs`; once data starts flowing it reads to EOF, capped at
 * `maxBytes` so a runaway producer cannot blow the context window.
 */

import type { Readable } from 'node:stream';

/** `process.stdin` in production; any readable in tests. */
export type PipedStdinSource = Readable & {
  readonly isTTY?: boolean | undefined;
  unref?: (() => unknown) | undefined;
};

export interface PipedStdinResult {
  /** Piped text, trimmed of trailing whitespace. Empty when nothing arrived. */
  text: string;
  /** True when the input exceeded `maxBytes` and was cut. */
  truncated: boolean;
  /** True when no first byte arrived in time and the read was abandoned. */
  timedOut: boolean;
}

export interface ReadPipedStdinOptions {
  firstByteTimeoutMs?: number | undefined;
  maxBytes?: number | undefined;
}

const PIPED_STDIN_FIRST_BYTE_TIMEOUT_MS = 3_000;
const PIPED_STDIN_MAX_BYTES = 2 * 1024 * 1024;

const EMPTY: PipedStdinResult = { text: '', truncated: false, timedOut: false };

/**
 * Read piped stdin. Resolves `EMPTY` immediately for a TTY — an interactive
 * terminal is never "piped input".
 */
export function readPipedStdin(
  source: PipedStdinSource,
  opts: ReadPipedStdinOptions = {},
): Promise<PipedStdinResult> {
  if (source.isTTY) return Promise.resolve(EMPTY);
  const firstByteTimeoutMs = opts.firstByteTimeoutMs ?? PIPED_STDIN_FIRST_BYTE_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? PIPED_STDIN_MAX_BYTES;

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let settled = false;

    const finish = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      source.removeListener('data', onData);
      source.removeListener('end', onEnd);
      source.removeListener('close', onEnd);
      source.removeListener('error', onError);
      source.pause();
      // An abandoned or cut-off pipe must not keep the process alive after the
      // run finishes.
      if (timedOut || truncated) source.unref?.();
      const text = timedOut ? '' : Buffer.concat(chunks).toString('utf8').trimEnd();
      resolve({ text, truncated, timedOut });
    };

    const onData = (chunk: Buffer | string): void => {
      clearTimeout(timer);
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      const room = maxBytes - size;
      // Strictly `>`: a chunk that exactly fills the cap exceeded nothing and
      // cut nothing, so `truncated` must stay false (the run then ends at EOF).
      // Any later chunk finds room 0 and lands here with length > 0, which is
      // a real cut and finishes immediately with `truncated: true`.
      if (buf.length > room) {
        chunks.push(buf.subarray(0, Math.max(0, room)));
        size = maxBytes;
        truncated = true;
        finish(false);
        return;
      }
      chunks.push(buf);
      size += buf.length;
    };
    const onEnd = (): void => finish(false);
    const onError = (): void => finish(false);

    const timer = setTimeout(() => {
      if (size === 0) finish(true);
    }, firstByteTimeoutMs);

    source.on('data', onData);
    source.on('end', onEnd);
    source.on('close', onEnd);
    source.on('error', onError);
    source.resume();
  });
}

/** Join the argv prompt with piped context. The prompt stays first: it is the instruction. */
export function appendPipedStdin(query: string, piped: string): string {
  if (!piped) return query;
  if (!query.trim()) return piped;
  return `${query}\n\n<stdin>\n${piped}\n</stdin>`;
}
