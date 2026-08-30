import * as fsp from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import type { SecretScrubber } from '../../types/secret-scrubber.js';
import type { SessionEvent } from '../../types/session.js';
import { scrubPersistedSessionEvent } from '../session-read-scrubber.js';

export async function searchSessionEvents(args: {
  file: string;
  secretScrubber: SecretScrubber;
  predicate: (event: SessionEvent, eventIndex: number, ts: string) => boolean;
  limit?: number | undefined;
  signal?: AbortSignal | undefined;
}): Promise<Array<{ event: SessionEvent; eventIndex: number; ts: string }>> {
  const { file, secretScrubber, predicate, limit, signal } = args;
  const out: Array<{ event: SessionEvent; eventIndex: number; ts: string }> = [];

  let stat: import('node:fs').Stats;
  try {
    stat = await fsp.stat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  if (stat.size === 0) return [];

  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(file, 'r');
    const CHUNK = 64 * 1024;
    const buf = Buffer.alloc(CHUNK);
    const decoder = new StringDecoder('utf8');
    let leftover = '';
    let eventIndex = 0;
    for (let position = 0; ; position += buf.byteLength) {
      if (signal?.aborted) {
        const reason = signal.reason ?? new DOMException('Aborted', 'AbortError');
        throw reason;
      }
      const { bytesRead } = await fh.read(buf, 0, CHUNK, position);
      if (bytesRead === 0) break;
      const text = leftover + decoder.write(buf.subarray(0, bytesRead));
      const parts = text.split('\n');
      leftover = parts.pop() ?? '';
      for (const line of parts) {
        if (!line) continue;
        const ev = parseSessionEventLine(line, secretScrubber);
        if (!ev) continue;
        if (predicate(ev, eventIndex, ev.ts)) {
          out.push({ event: ev, eventIndex, ts: ev.ts });
          if (limit !== undefined && out.length >= limit) return out;
        }
        eventIndex++;
      }
    }
    leftover += decoder.end();
    const trailing = parseSessionEventLine(leftover.trim() ? leftover : '', secretScrubber);
    if (trailing && predicate(trailing, eventIndex, trailing.ts)) {
      out.push({ event: trailing, eventIndex, ts: trailing.ts });
    }
    return out;
  } finally {
    if (fh) await fh.close().catch(() => undefined);
  }
}

function parseSessionEventLine(line: string, secretScrubber: SecretScrubber): SessionEvent | null {
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof (parsed as { type?: unknown }).type !== 'string' ||
      typeof (parsed as { ts?: unknown }).ts !== 'string'
    ) {
      return null;
    }
    return scrubPersistedSessionEvent(parsed as SessionEvent, secretScrubber);
  } catch {
    return null;
  }
}
