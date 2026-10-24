/**
 * Redo for `/rewind`. A rewind cuts the journal after a checkpoint; the cut
 * bytes used to be gone. They are now stashed next to the journal
 * (`<session>.jsonl.redo/`) together with the size and hash of the part that
 * was kept, so the most recent rewinds can be undone again, newest first.
 *
 * A redo is only valid while the kept part is exactly what the rewind left:
 * the stash stores its SHA-256 and a redo checks it. Writing a new
 * checkpoint (the next prompt) or clearing the session drops the stack, as a
 * new edit drops an editor's redo history.
 *
 * Subagent transcripts that belonged only to the rewound turns are moved into
 * the stash instead of deleted, and moved back by a redo.
 *
 * @module storage/session-writer-redo
 */
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionEvent } from '@wrongstack/contracts/types/session';

interface RedoEntry {
  /** Journal bytes the rewind kept. */
  keptBytes: number;
  /** SHA-256 of those bytes. */
  keptSha: string;
  /** Writer's prompt index before the rewind. */
  activePromptIndex: number | null;
  /** Checkpoint the rewind went back to. */
  toPromptIndex: number;
  /** File (inside the stash dir) holding the cut bytes. */
  tailFile: string;
  /** Transcripts moved into the stash: original path → stashed path. */
  transcripts: Array<{ from: string; to: string }>;
}

const CHUNK = 65_536;

function redoStashDir(journalPath: string): string {
  return `${journalPath}.redo`;
}

async function readStack(dir: string): Promise<RedoEntry[]> {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(dir, 'stack.json'), 'utf8'));
    return Array.isArray(parsed) ? (parsed as RedoEntry[]) : [];
  } catch {
    return [];
  }
}

async function writeStack(dir: string, stack: RedoEntry[]): Promise<void> {
  if (stack.length === 0) {
    await fsp.rm(dir, { recursive: true, force: true });
    return;
  }
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, 'stack.json.tmp');
  await fsp.writeFile(tmp, JSON.stringify(stack), { mode: 0o600 });
  await fsp.rename(tmp, path.join(dir, 'stack.json'));
}

/** Drop every stashed rewind (a new prompt or `/clear` invalidates them). */
export async function clearRedoStash(journalPath: string): Promise<void> {
  await fsp.rm(redoStashDir(journalPath), { recursive: true, force: true });
}

async function hashPrefix(file: fsp.FileHandle, bytes: number): Promise<string> {
  const hash = createHash('sha256');
  const buf = Buffer.alloc(CHUNK);
  for (let offset = 0; offset < bytes; ) {
    const { bytesRead } = await file.read(buf, 0, Math.min(CHUNK, bytes - offset), offset);
    if (bytesRead === 0) break;
    hash.update(buf.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest('hex');
}

/**
 * Byte length the rewind keeps: up to and including the end of the checkpoint
 * line at `checkpointByteOffset` (see `rewriteSessionToCheckpoint`).
 */
export async function keptBytesForCheckpoint(
  journalPath: string,
  checkpointByteOffset: number,
): Promise<number> {
  const handle = await fsp.open(journalPath, 'r');
  try {
    const { size } = await handle.stat();
    for (let offset = checkpointByteOffset; offset < size; offset += CHUNK) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - offset));
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      const nl = buf.subarray(0, bytesRead).indexOf('\n');
      if (nl !== -1) return offset + nl + 1;
      if (bytesRead === 0) break;
    }
    return size;
  } finally {
    await handle.close();
  }
}

/**
 * Before a rewind rewrites the journal: copy the bytes it is about to cut into
 * the stash and move the transcripts it would delete. Returns the transcripts
 * that were moved (the caller deletes only the rest).
 */
export async function stashRewoundTail(opts: {
  journalPath: string;
  keptBytes: number;
  activePromptIndex: number | null;
  toPromptIndex: number;
  transcriptPaths: readonly string[];
}): Promise<string[]> {
  const dir = redoStashDir(opts.journalPath);
  const stack = await readStack(dir);
  const id = `${Date.now()}-${stack.length}`;
  await fsp.mkdir(dir, { recursive: true });
  const tailFile = `${id}.jsonl`;
  const source = await fsp.open(opts.journalPath, 'r');
  let keptSha: string;
  try {
    keptSha = await hashPrefix(source, opts.keptBytes);
    const { size } = await source.stat();
    const out = await fsp.open(path.join(dir, tailFile), 'w', 0o600);
    try {
      const buf = Buffer.alloc(CHUNK);
      for (let offset = opts.keptBytes; offset < size; ) {
        const { bytesRead } = await source.read(buf, 0, Math.min(CHUNK, size - offset), offset);
        if (bytesRead === 0) break;
        await out.write(buf, 0, bytesRead);
        offset += bytesRead;
      }
    } finally {
      await out.close();
    }
  } finally {
    await source.close();
  }

  const transcripts: RedoEntry['transcripts'] = [];
  for (const [i, from] of opts.transcriptPaths.entries()) {
    const to = path.join(dir, `${id}.t${i}-${path.basename(from)}`);
    try {
      await fsp.rename(from, to);
      transcripts.push({ from, to });
    } catch {
      // Not movable (missing, other volume): the rewind deletes it as before.
    }
  }
  stack.push({
    keptBytes: opts.keptBytes,
    keptSha,
    activePromptIndex: opts.activePromptIndex,
    toPromptIndex: opts.toPromptIndex,
    tailFile,
    transcripts,
  });
  await writeStack(dir, stack);
  return transcripts.map((t) => t.from);
}

/**
 * Take back the stash `stashRewoundTail` just pushed, for a rewind whose
 * journal rewrite then failed: the journal still links the moved transcripts,
 * so they go back to where it points, and the entry is dropped so no redo is
 * offered for a rewind that never happened.
 */
export async function unstashRewoundTail(journalPath: string): Promise<void> {
  const dir = redoStashDir(journalPath);
  const stack = await readStack(dir);
  const top = stack.pop();
  if (!top) return;
  for (const { from, to } of top.transcripts) {
    await fsp.rename(to, from).catch(() => undefined);
  }
  await fsp.rm(path.join(dir, top.tailFile), { force: true });
  await writeStack(dir, stack);
}

/** The newest stash, if the journal still starts with exactly what it kept. */
async function validTop(journalPath: string): Promise<RedoEntry | undefined> {
  const dir = redoStashDir(journalPath);
  const stack = await readStack(dir);
  const top = stack.at(-1);
  if (!top) return undefined;
  const handle = await fsp.open(journalPath, 'r');
  try {
    const { size } = await handle.stat();
    if (size >= top.keptBytes && (await hashPrefix(handle, top.keptBytes)) === top.keptSha) {
      return top;
    }
  } finally {
    await handle.close();
  }
  // The kept part changed underneath the stash: nothing in it applies.
  await clearRedoStash(journalPath);
  return undefined;
}

/** Parse the newest stash's events without changing anything. */
export async function peekRedoStash(
  journalPath: string,
): Promise<{ toPromptIndex: number; events: SessionEvent[] } | null> {
  const top = await validTop(journalPath);
  if (!top) return null;
  const raw = await fsp.readFile(path.join(redoStashDir(journalPath), top.tailFile), 'utf8');
  const events: SessionEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as SessionEvent);
    } catch {
      // Malformed lines are restored byte for byte; they just are not planned.
    }
  }
  return { toPromptIndex: top.toPromptIndex, events };
}

/**
 * Rewrite the journal to the kept bytes plus the newest stash and pop it. The
 * caller has flushed and closed its append handle. Returns what was restored,
 * or null when there is nothing valid to redo.
 */
async function restoreRedoStash(
  journalPath: string,
): Promise<{ activePromptIndex: number | null; toPromptIndex: number; lines: number } | null> {
  const top = await validTop(journalPath);
  if (!top) return null;
  const dir = redoStashDir(journalPath);
  const tail = await fsp.readFile(path.join(dir, top.tailFile));
  const tmp = `${journalPath}.redo.tmp`;
  const source = await fsp.open(journalPath, 'r');
  try {
    const out = await fsp.open(tmp, 'w', 0o600);
    try {
      const buf = Buffer.alloc(CHUNK);
      for (let offset = 0; offset < top.keptBytes; ) {
        const { bytesRead } = await source.read(
          buf,
          0,
          Math.min(CHUNK, top.keptBytes - offset),
          offset,
        );
        if (bytesRead === 0) break;
        await out.write(buf, 0, bytesRead);
        offset += bytesRead;
      }
      await out.write(tail);
      await out.sync();
    } finally {
      await out.close();
    }
  } finally {
    await source.close();
  }
  await fsp.rename(tmp, journalPath);

  for (const { from, to } of top.transcripts) {
    await fsp.mkdir(path.dirname(from), { recursive: true }).catch(() => undefined);
    await fsp.rename(to, from).catch(() => undefined);
  }
  await fsp.rm(path.join(dir, top.tailFile), { force: true });
  const stack = await readStack(dir);
  stack.pop();
  await writeStack(dir, stack);
  const lines = tail
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim()).length;
  return { activePromptIndex: top.activePromptIndex, toPromptIndex: top.toPromptIndex, lines };
}

/** What a live writer hands the redo restore (mirrors the truncate context). */
export interface SessionRedoContext {
  sessionId: string;
  filePath: string;
  closed: boolean;
  buffer: {
    cancelTimer(): void;
    flushBuffer(closed: boolean, opts: { datasync: boolean }): Promise<unknown>;
    drainWriteChain(): Promise<unknown>;
  };
  handle: fsp.FileHandle;
  setHandle: (handle: fsp.FileHandle) => void;
  events?: { emit(event: string, payload?: unknown): void } | undefined;
  summaryTracker: { recomputeFromDisk(filePath: string): Promise<void> };
  cancelMetadataTimer: () => void;
  metadataCheckpointInFlight?: Promise<void> | null | undefined;
  scheduleMetadataCheckpoint: () => void;
  setActivePromptIndex: (index: number | null) => void;
}

/**
 * Undo the newest rewind in the journal: flush, close the append handle (the
 * rename must not race it, and Windows refuses to replace an open file),
 * restore, reopen, and recompute the summary. Returns the number of restored
 * events, or null when there is nothing valid to redo.
 */
export async function executeSessionRedo(ctx: SessionRedoContext): Promise<number | null> {
  if (!ctx.filePath) return null;
  ctx.buffer.cancelTimer();
  await ctx.buffer.flushBuffer(ctx.closed, { datasync: true });
  await ctx.buffer.drainWriteChain();
  ctx.cancelMetadataTimer();
  await ctx.metadataCheckpointInFlight?.catch(() => undefined);
  try {
    await ctx.handle.close();
  } catch {
    // already closed
  }
  let restored: Awaited<ReturnType<typeof restoreRedoStash>>;
  try {
    restored = await restoreRedoStash(ctx.filePath);
  } finally {
    ctx.setHandle(await fsp.open(ctx.filePath, 'a', 0o600));
  }
  if (!restored) {
    ctx.scheduleMetadataCheckpoint();
    return null;
  }
  await ctx.summaryTracker.recomputeFromDisk(ctx.filePath);
  ctx.setActivePromptIndex(restored.activePromptIndex);
  ctx.scheduleMetadataCheckpoint();
  ctx.events?.emit('session.redone', {
    sessionId: ctx.sessionId,
    toPromptIndex: restored.toPromptIndex,
    restoredEvents: restored.lines,
  });
  return restored.lines;
}
