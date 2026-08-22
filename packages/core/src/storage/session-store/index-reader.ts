import * as fsp from 'node:fs/promises';
import type { SessionSummary } from '../../types/session.js';

type SessionIndexEntry = {
  action?: string | undefined;
  id?: string | undefined;
} & SessionSummary;

export function applySessionIndexLines(
  raw: string,
  byId: Map<string, SessionSummary>,
  deleted: Set<string>,
): void {
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as SessionIndexEntry;
      if (entry.action === 'delete' && entry.id) {
        deleted.add(entry.id);
        byId.delete(entry.id);
        continue;
      }
      if (entry.action === 'create' && entry.id) {
        // Tombstone-control record only: it un-deletes the id but must NOT
        // enter byId as a SessionSummary — it carries no title/tokens, and a
        // malformed row would crash scrubbing and blank list(). The real
        // summary arrives via the writer's first checkpoint or close.
        deleted.delete(entry.id);
        byId.delete(entry.id);
        continue;
      }
      if (entry.id && !deleted.has(entry.id)) {
        // Ordinary rows NEVER override tombstones: a metadata checkpoint or
        // close racing a delete() must not re-publish the deleted session.
        byId.set(entry.id, entry as SessionSummary);
      }
    } catch {
      // Skip corrupt lines. A later valid line remains usable.
    }
  }
}

export async function readFileRange(
  file: string,
  start: number,
  end: number,
): Promise<{ raw: string; end: number } | null> {
  const length = end - start;
  if (length <= 0) return { raw: '', end: start };
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(file, 'r');
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead === 0) return null;
      offset += bytesRead;
    }
    let completeLength = buffer.length;
    if (buffer.at(-1) !== 0x0a) {
      const lastNewline = buffer.lastIndexOf(0x0a);
      const trailing = buffer
        .subarray(lastNewline + 1)
        .toString('utf8')
        .trim();
      try {
        if (trailing) JSON.parse(trailing);
        else completeLength = lastNewline + 1;
      } catch {
        // A reader can observe an append between the kernel writes that make
        // up a large line. Keep the incomplete suffix unread so the next
        // stat/growth check retries it from the last complete newline.
        completeLength = lastNewline + 1;
      }
    }
    return {
      raw: buffer.subarray(0, completeLength).toString('utf8'),
      end: start + completeLength,
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
