/**
 * Partition discovery, retention checkpoints and strict entry readers for
 * ChronicleJournal. Split out of journal.ts.
 */
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { atomicWrite } from '@wrongstack/core/utils';
import { GENESIS_HASH, hashValue } from './event-hash.js';
import { comparePartitionPaths } from './partition-filename.js';
import type { ChronicleEvent, ChronicleVerifyResult } from './types.js';

const RETENTION_CHECKPOINT_VERSION = 1;

export interface ChronicleRetentionCheckpoint {
  version: typeof RETENTION_CHECKPOINT_VERSION;
  sequence: number;
  hash: string;
}

export function rotatedPath(basePath: string, index: number): string {
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath);
  const base = path.basename(basePath, ext);
  return path.join(dir, `${base}.${String(index).padStart(5, '0')}${ext}`);
}

/**
 * Exported for the SQLite migration only (`legacy-journal-import.ts`).
 *
 * The importer has to walk partitions in exactly the order the writer produced
 * them and parse them with exactly the same strictness, so it reuses these
 * rather than growing a second implementation that could disagree about
 * rotation order or malformed lines. All three go away with the legacy reader
 * in phase 4 of `chronicle-sqlite-journal-v1`.
 */
export async function collectPartitions(basePath: string): Promise<string[]> {
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath);
  const base = path.basename(basePath, ext);
  const pattern = new RegExp(`^${escapeRegex(base)}(?:\\.\\d{5})?${escapeRegex(ext)}$`);
  const result: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries)
      if (entry.isFile() && pattern.test(entry.name)) result.push(path.join(dir, entry.name));
  } catch {
    /* ok */
  }
  const baseFile = path.join(dir, base + ext);
  const hasBase = result.includes(baseFile);
  const rotated = result
    .filter((file) => file !== baseFile)
    .sort((left, right) => parseIndex(left, base, ext) - parseIndex(right, base, ext));
  return hasBase ? [baseFile, ...rotated] : rotated;
}

export async function collectJournalPartitions(basePath: string): Promise<string[]> {
  const directory = path.dirname(basePath);
  const result: string[] = [];
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isFile() && isJournalPartition(file, directory, basePath)) result.push(file);
    }
  } catch {
    /* ok */
  }
  return result.sort(comparePartitionPaths);
}

export function isJournalPartition(
  filePath: string,
  directory: string,
  basePath?: string,
): boolean {
  if (path.dirname(path.resolve(filePath)) !== path.resolve(directory)) return false;
  const fileName = path.basename(filePath);
  if (!basePath) return false;
  const baseName = path.basename(basePath);
  const dailyFamily = /^\d{4}-\d{2}-\d{2}\.events(?:\.\d{5})?\.jsonl$/;
  if (/^\d{4}-\d{2}-\d{2}\.events\.jsonl$/.test(baseName)) return dailyFamily.test(fileName);
  return (
    partitionFamilyBase(path.resolve(filePath)) === partitionFamilyBase(path.resolve(basePath))
  );
}

export function groupPartitionsByFamily(files: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const family = partitionFamilyBase(file);
    const group = groups.get(family) ?? [];
    group.push(file);
    groups.set(family, group);
  }
  return groups;
}

export function partitionFamilyBase(filePath: string): string {
  return filePath.replace(/\.\d{5}(?=\.jsonl$)/, '');
}

function retentionCheckpointPath(basePath: string): string {
  return `${partitionFamilyBase(basePath)}.retention.json`;
}

export async function verifyRetainedPrefix(
  entries: AsyncIterable<ChronicleEvent>,
  checkpoint: ChronicleRetentionCheckpoint | undefined,
): Promise<ChronicleRetentionCheckpoint | undefined> {
  let sequence = checkpoint?.sequence ?? 0;
  let hash = checkpoint?.hash ?? GENESIS_HASH;
  let advanced = false;
  let sawEntry = false;
  for await (const entry of entries) {
    sawEntry = true;
    if (entry.sequence <= sequence) continue;
    if (entry.sequence !== sequence + 1 || entry.previousHash !== hash) return undefined;
    const { hash: recordedHash, ...content } = entry;
    if (hashValue(content) !== recordedHash) return undefined;
    sequence = entry.sequence;
    hash = recordedHash;
    advanced = true;
  }
  if (!sawEntry) return undefined;
  if (!advanced) return checkpoint;
  return { version: RETENTION_CHECKPOINT_VERSION, sequence, hash };
}

export async function verifyPartitionFiles(
  files: string[],
  checkpoint: ChronicleRetentionCheckpoint | undefined,
): Promise<ChronicleVerifyResult> {
  const checkpointSequence = checkpoint?.sequence ?? 0;
  let previousHash = checkpoint?.hash ?? GENESIS_HASH;
  let entries = 0;
  let lastSequence = checkpointSequence;
  let coveredPrevious: ChronicleEvent | undefined;
  for (const file of files) {
    try {
      for await (const entry of streamEntriesStrict(file)) {
        const { hash: recordedHash, ...content } = entry;
        if (entry.sequence <= checkpointSequence) {
          // A checkpoint can be durably renamed just before its source
          // partition fails to unlink. Such retained bytes are still evidence:
          // validate them rather than treating every covered sequence as absent.
          if (hashValue(content) !== recordedHash)
            return { ok: false, entries, brokenAt: entries, reason: 'entry hash mismatch' };
          if (coveredPrevious && entry.sequence !== coveredPrevious.sequence + 1) {
            return {
              ok: false,
              entries,
              brokenAt: entries,
              reason: `sequence ${entry.sequence} is not ${coveredPrevious.sequence + 1}`,
            };
          }
          if (coveredPrevious && entry.previousHash !== coveredPrevious.hash) {
            return { ok: false, entries, brokenAt: entries, reason: 'previous hash mismatch' };
          }
          if (entry.sequence === checkpointSequence && recordedHash !== checkpoint?.hash) {
            return {
              ok: false,
              entries,
              brokenAt: entries,
              reason: 'retention checkpoint hash mismatch',
            };
          }
          coveredPrevious = entry;
          continue;
        }
        const index = entries++;
        if (entry.sequence !== lastSequence + 1)
          return {
            ok: false,
            entries,
            brokenAt: index,
            reason: `sequence ${entry.sequence} is not ${lastSequence + 1}`,
          };
        if (entry.previousHash !== previousHash)
          return { ok: false, entries, brokenAt: index, reason: 'previous hash mismatch' };
        if (hashValue(content) !== recordedHash)
          return { ok: false, entries, brokenAt: index, reason: 'entry hash mismatch' };
        previousHash = recordedHash;
        lastSequence = entry.sequence;
      }
    } catch (error) {
      return { ok: false, entries, brokenAt: entries, reason: errorMessage(error) };
    }
  }
  if (
    coveredPrevious &&
    (coveredPrevious.sequence !== checkpointSequence || coveredPrevious.hash !== checkpoint?.hash)
  ) {
    return { ok: false, entries, brokenAt: entries, reason: 'retention checkpoint hash mismatch' };
  }
  return { ok: true, entries, lastSequence, lastHash: previousHash };
}

export async function readRetentionCheckpoint(basePath: string): Promise<{
  checkpoint?: ChronicleRetentionCheckpoint | undefined;
  error?: string | undefined;
}> {
  const checkpointPath = retentionCheckpointPath(basePath);
  let raw: string;
  try {
    raw = await fs.readFile(checkpointPath, 'utf8');
  } catch (error) {
    return isNotFound(error)
      ? {}
      : { error: `cannot read retention checkpoint: ${errorMessage(error)}` };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ChronicleRetentionCheckpoint>;
    if (
      parsed.version !== RETENTION_CHECKPOINT_VERSION ||
      !Number.isSafeInteger(parsed.sequence) ||
      (parsed.sequence ?? -1) < 0 ||
      !isHash(parsed.hash)
    ) {
      return { error: 'invalid Chronicle retention checkpoint' };
    }
    return { checkpoint: parsed as ChronicleRetentionCheckpoint };
  } catch {
    return { error: 'invalid Chronicle retention checkpoint JSON' };
  }
}

export async function writeRetentionCheckpoint(
  basePath: string,
  checkpoint: ChronicleRetentionCheckpoint,
): Promise<void> {
  await atomicWrite(retentionCheckpointPath(basePath), `${JSON.stringify(checkpoint)}\n`, {
    mode: 0o600,
  });
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function parseIndex(filePath: string, base: string, ext: string): number {
  const suffix = path.basename(filePath).slice(base.length + 1, -ext.length);
  return suffix ? parseInt(suffix, 10) : 0;
}

export function partitionIndex(filePath: string, basePath: string): number {
  const ext = path.extname(basePath);
  return parseIndex(filePath, path.basename(basePath, ext), ext);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function readLastEntryState(filePath: string): Promise<{
  entry?: ChronicleEvent | undefined;
  size: number;
  birthtimeMs?: number | undefined;
}> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (error) {
    if (isNotFound(error)) return { size: 0 };
    throw error;
  }
  try {
    const stat = await handle.stat();
    const size = stat.size;
    let position = size,
      suffix = '';
    const probe = Buffer.alloc(1);
    while (position > 0) {
      const length = Math.min(65536, position);
      const windowStart = position - length;
      // A window that begins mid-codepoint decodes the split character as
      // U+FFFD, permanently corrupting the line straddling the boundary; its
      // JSON.parse then fails and this backward scan walks on to an EARLIER
      // entry, which refreshStateFromDisk would adopt as the append chain
      // anchor. Back the window up over the (at most three) UTF-8 continuation
      // bytes so the decode starts on a code point boundary — the preceding
      // window then also ends on one, so both sides of every boundary decode
      // cleanly. The backed-up bytes head lines[0], which stays a partial-line
      // fragment carried in `suffix` exactly as before.
      let back = 0;
      if (windowStart > 0) {
        await handle.read(probe, 0, 1, windowStart);
        if ((probe[0]! & 0xc0) === 0x80) {
          // The window opens mid-codepoint: include its lead byte and any
          // continuation bytes ahead of it.
          while (back < 3 && windowStart - back - 1 >= 0) {
            await handle.read(probe, 0, 1, windowStart - back - 1);
            back++;
            if ((probe[0]! & 0xc0) !== 0x80) break; // lead byte included
          }
        }
      }
      const buf = Buffer.allocUnsafe(back + length);
      await handle.read(buf, 0, buf.length, windowStart - back);
      // The NEXT window (earlier bytes) must end at the aligned boundary, not
      // at the raw windowStart — otherwise the two windows overlap by `back`
      // bytes and the split code point is decoded twice (once corrupted in
      // the head window's tail, once correctly in this one), reintroducing
      // the corruption through the reassembled line.
      position = windowStart - back;
      suffix = buf.toString('utf8') + suffix;
      const lines = suffix.split('\n');
      const start = position === 0 ? 0 : 1;
      for (let i = lines.length - 1; i >= start; i--) {
        const trimmed = lines[i]!.trim();
        if (!trimmed) continue;
        try {
          return {
            entry: JSON.parse(trimmed) as ChronicleEvent,
            size,
            birthtimeMs: stat.birthtimeMs,
          };
        } catch {
          /* scan earlier */
        }
      }
      suffix = lines[0] ?? '';
    }
    return { size, birthtimeMs: stat.birthtimeMs };
  } finally {
    await handle.close();
  }
}

/** Stream entries line by line. Reading a whole partition into one string
 *  breaks past V8's max string length (~512MB) — purge and verify must work
 *  on partitions of any size, so only individual lines are materialized. */
export async function* streamEntriesStrict(filePath: string): AsyncGenerator<ChronicleEvent> {
  let lineNumber = 0;
  let input: ReturnType<typeof createReadStream> | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  try {
    input = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 256 * 1024 });
    lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      lineNumber++;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: ChronicleEvent;
      try {
        entry = JSON.parse(trimmed) as ChronicleEvent;
      } catch {
        throw new Error(`invalid JSON at line ${lineNumber} in ${path.basename(filePath)}`);
      }
      yield entry;
    }
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  } finally {
    lines?.close();
    input?.destroy();
  }
}

export async function readEntriesStrict(filePath: string): Promise<ChronicleEvent[]> {
  const entries: ChronicleEvent[] = [];
  for await (const entry of streamEntriesStrict(filePath)) entries.push(entry);
  return entries;
}

export function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
