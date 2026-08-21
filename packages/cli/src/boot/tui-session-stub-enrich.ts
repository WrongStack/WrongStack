/**
 * Stub-summary enrichment for the TUI /resume picker.
 *
 * A session whose process died abruptly (kill, crash, power loss) never runs
 * its close-time summary upsert, so its catalog/index summary is a
 * create-time stub: empty title, tokenTotal 0, lastActivityAt == startedAt.
 * The JSONL transcript itself is intact — only the summary is stale.
 *
 * `enrichStubSummaries` detects those stubs and repairs the picker-facing
 * fields with bounded reads:
 *  - `title`          ← first `user_input` event (head slice)
 *  - `lastUserMessage`← last `user_input` event (tail slice)
 *  - `lastActivityAt` ← transcript file mtime (the real kill time)
 *
 * Everything is best-effort: any read/parse failure returns the original
 * summary untouched, so listing can never break because of enrichment.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionSummary } from '@wrongstack/core/types';

/** Head/tail slice size for JSONL scans. Large transcripts are common; 256 KiB
 * covers thousands of lines without reading multi-hundred-MB files. */
const SLICE_BYTES = 256 * 1024;
const MAX_TITLE_CHARS = 80;

/** A summary is a stub when it has no title and no clean end — exactly the
 * shape a killed process leaves behind. */
function isStubSummary(s: SessionSummary): boolean {
  return !s.title && !s.endedAt;
}

function jsonlPath(sessionsDir: string, id: string): string {
  // Session ids are shard-relative ("2026-08-21/sess_…"); the JSONL sits at
  // <sessionsDir>/<shard>/<id>.jsonl.
  return path.join(sessionsDir, `${id}.jsonl`);
}

/** Extract displayable text from a user_input event's content. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && 'text' in block && typeof block.text === 'string'
          ? block.text
          : '',
      )
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

interface UserInputHit {
  ts: string;
  text: string;
}

/** Parse a raw JSONL chunk and return the first and last user_input events. */
function scanUserInputs(chunk: string): { first?: UserInputHit | undefined; last?: UserInputHit | undefined } {
  let first: UserInputHit | undefined;
  let last: UserInputHit | undefined;
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.includes('"user_input"')) continue;
    try {
      const event = JSON.parse(trimmed) as { type?: string; ts?: string; content?: unknown };
      if (event.type !== 'user_input' || typeof event.ts !== 'string') continue;
      const text = contentToText(event.content).trim();
      if (!text) continue;
      const hit: UserInputHit = { ts: event.ts, text };
      if (!first) first = hit;
      last = hit;
    } catch {
      // Partial/truncated line at a slice boundary — skip.
    }
  }
  return { first, last };
}

/** Read the first user_input from a bounded head slice. */
async function firstUserInput(file: string): Promise<UserInputHit | undefined> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    const length = Math.min(SLICE_BYTES, size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    // Drop the final (possibly truncated) line.
    const text = buffer.toString('utf8');
    const cutoff = text.lastIndexOf('\n');
    return scanUserInputs(cutoff > 0 ? text.slice(0, cutoff) : text).first;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Read the last user_input from a bounded tail slice. */
async function lastUserInput(file: string): Promise<UserInputHit | undefined> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - SLICE_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString('utf8');
    // Drop the leading (possibly truncated) line.
    const from = text.indexOf('\n');
    return scanUserInputs(from >= 0 ? text.slice(from + 1) : text).last;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function truncate(text: string): string {
  const oneLine = text.replaceAll(/\s+/g, ' ').trim();
  return oneLine.length > MAX_TITLE_CHARS ? `${oneLine.slice(0, MAX_TITLE_CHARS - 1)}…` : oneLine;
}

/**
 * Return picker-ready copies of `summaries`, with stub entries enriched from
 * their JSONL transcripts. Non-stub entries pass through untouched.
 */
export async function enrichStubSummaries(
  summaries: SessionSummary[],
  sessionsDir: string,
): Promise<SessionSummary[]> {
  return Promise.all(
    summaries.map(async (s) => {
      if (!isStubSummary(s)) return s;
      const file = jsonlPath(sessionsDir, s.id);
      try {
        const stat = await fs.stat(file);
        const [first, last] = await Promise.all([firstUserInput(file), lastUserInput(file)]);
        const title = truncate(first?.text ?? '');
        return {
          ...s,
          ...(title ? { title } : {}),
          ...(last ? { lastUserMessage: truncate(last.text) } : {}),
          lastActivityAt: stat.mtime.toISOString(),
        };
      } catch {
        return s;
      }
    }),
  );
}
