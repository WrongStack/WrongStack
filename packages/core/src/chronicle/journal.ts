import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { SECRET_FILE_MODE } from '../security/file-permissions.js';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import { GENESIS_HASH, hashValue } from './event-hash.js';
import { comparePartitionPaths } from './partition-filename.js';
import {
  CHRONICLE_SCHEMA_VERSION,
  type ChronicleEvent,
  type ChronicleEventInput,
  type ChronicleVerifyResult,
} from './types.js';

const DEFAULT_MAX_PARTITION_BYTES = 100 * 1024 * 1024;
const DEFAULT_ROTATION_WINDOW_MS = 60 * 60 * 1000;
const RETENTION_CHECKPOINT_VERSION = 1;

export interface ChronicleRetentionCheckpoint {
  version: typeof RETENTION_CHECKPOINT_VERSION;
  sequence: number;
  hash: string;
}

export interface ChronicleJournalOptions {
  filePath: string;
  now?: (() => Date) | undefined;
  monotonicNow?: (() => bigint) | undefined;
  idFactory?: (() => string) | undefined;
  maxPending?: number | undefined;
  batchWindowMs?: number | undefined;
  maxPartitionSizeBytes?: number | undefined;
  rotationWindowMs?: number | undefined;
  retentionDays?: number | undefined;
  autoPurgeIntervalMs?: number | undefined;
}
export interface ChronicleJournalStats {
  acceptedEvents: number;
  persistedEvents: number;
  rejectedEvents: number;
  failedEvents: number;
  batches: number;
  pendingEvents: number;
  maxObservedPending: number;
  largestBatch: number;
  lastBatchDurationMs?: number | undefined;
  partitionRolls: number;
}
export interface ChroniclePurgeOptions {
  retentionDays: number;
  dryRun?: boolean | undefined;
  files?: string[] | undefined;
}
export interface ChroniclePurgeResult {
  deletedCount: number;
  deletedBytes: number;
  skippedCount: number;
  errors: Array<{ file: string; reason: string }>;
  candidates?: string[] | undefined;
}

export class ChronicleJournal {
  private readonly basePath: string;
  private readonly now: () => Date;
  private readonly monotonicNow: () => bigint;
  private readonly idFactory: () => string;
  private readonly maxPending: number;
  private readonly batchWindowMs: number;
  private readonly maxPartitionSizeBytes: number;
  private readonly rotationWindowMs: number;
  private readonly retentionDays: number;
  private readonly autoPurgeIntervalMs: number;
  private pending: Array<{
    input: ChronicleEventInput;
    resolve: (event: ChronicleEvent) => void;
    reject: (error: unknown) => void;
  }> = [];
  private drainPromise: Promise<void> | undefined;
  private drainScheduled = false;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly counters = {
    acceptedEvents: 0,
    persistedEvents: 0,
    rejectedEvents: 0,
    failedEvents: 0,
    batches: 0,
    maxObservedPending: 0,
    largestBatch: 0,
    partitionRolls: 0,
  };
  private lastBatchDurationMs: number | undefined;
  private partitionIndex = 0;
  private partitionStartedAt: number;
  private partitionSizeBytes = 0;
  private stateInitialized = false;
  private lastSequence = 0;
  private lastHash: string = GENESIS_HASH;
  private lastAutoPurgeAt = 0;

  constructor(options: ChronicleJournalOptions) {
    this.basePath = path.resolve(options.filePath);
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => process.hrtime.bigint());
    this.idFactory = options.idFactory ?? randomUUID;
    this.maxPending = Math.max(1, options.maxPending ?? 100_000);
    this.batchWindowMs = Math.max(0, options.batchWindowMs ?? 5);
    this.maxPartitionSizeBytes = options.maxPartitionSizeBytes ?? DEFAULT_MAX_PARTITION_BYTES;
    this.rotationWindowMs = options.rotationWindowMs ?? DEFAULT_ROTATION_WINDOW_MS;
    this.retentionDays =
      options.retentionDays && Number.isFinite(options.retentionDays) && options.retentionDays > 0
        ? options.retentionDays
        : 0;
    this.autoPurgeIntervalMs = Math.max(0, options.autoPurgeIntervalMs ?? 3_600_000);
    this.partitionStartedAt = Date.now();
  }

  get path(): string {
    return this.partitionIndex === 0
      ? this.basePath
      : rotatedPath(this.basePath, this.partitionIndex);
  }

  stats(): ChronicleJournalStats {
    return {
      ...this.counters,
      pendingEvents: this.pending.length,
      ...(this.lastBatchDurationMs !== undefined
        ? { lastBatchDurationMs: this.lastBatchDurationMs }
        : {}),
    };
  }

  append(input: ChronicleEventInput): Promise<ChronicleEvent> {
    if (this.pending.length >= this.maxPending) {
      this.counters.rejectedEvents++;
      return Promise.reject(
        new Error(`Chronicle backpressure limit reached (${this.maxPending} pending events)`),
      );
    }
    const promise = new Promise<ChronicleEvent>((resolve, reject) => {
      this.pending.push({ input, resolve, reject });
    });
    this.counters.acceptedEvents++;
    this.counters.maxObservedPending = Math.max(
      this.counters.maxObservedPending,
      this.pending.length,
    );
    this.scheduleDrain();
    return promise;
  }

  async readAll(): Promise<ChronicleEvent[]> {
    await this.flush();
    const files = await collectPartitions(this.basePath);
    const entries: ChronicleEvent[] = [];
    for (const file of files) entries.push(...(await readEntriesStrict(file)));
    return entries;
  }

  async flush(): Promise<void> {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
      this.drainScheduled = false;
    }
    while (this.pending.length > 0 || this.drainPromise) {
      if (this.pending.length > 0 && !this.drainPromise) this.startDrain();
      await this.drainPromise;
    }
  }

  async verify(): Promise<ChronicleVerifyResult> {
    await this.flush();
    const files = await collectPartitions(this.basePath);
    const checkpointResult = await readRetentionCheckpoint(this.basePath);
    if (checkpointResult.error)
      return { ok: false, entries: 0, brokenAt: 0, reason: checkpointResult.error };
    return verifyPartitionFiles(files, checkpointResult.checkpoint);
  }

  async purge(options: ChroniclePurgeOptions): Promise<ChroniclePurgeResult> {
    await this.flush();
    if (!Number.isFinite(options.retentionDays) || options.retentionDays <= 0) {
      throw new TypeError('Chronicle retentionDays must be a positive finite number');
    }
    await this.refreshStateFromDisk();
    const cutoff = Date.now() - options.retentionDays * 86400000;
    const activePath = path.resolve(this.path);
    const errors: ChroniclePurgeResult['errors'] = [];
    let dc = 0,
      db = 0,
      sc = 0;
    const suppliedFiles =
      options.files === undefined
        ? await collectJournalPartitions(this.basePath)
        : [...options.files];
    const eligible = new Set<string>();
    for (const suppliedPath of new Set(suppliedFiles)) {
      const file = path.resolve(suppliedPath);
      if (!isJournalPartition(file, path.dirname(this.basePath), this.basePath)) {
        errors.push({
          file: suppliedPath,
          reason: 'not a Chronicle journal partition in this journal directory',
        });
        sc++;
        continue;
      }
      if (file === activePath) {
        sc++;
        continue;
      }
      let mtimeMs: number;
      try {
        const fileStat = await fs.lstat(file);
        if (!fileStat.isFile()) {
          sc++;
          continue;
        }
        mtimeMs = fileStat.mtimeMs;
      } catch (error) {
        if (isNotFound(error)) continue;
        errors.push({ file, reason: errorMessage(error) });
        sc++;
        continue;
      }
      if (mtimeMs > cutoff) {
        sc++;
        continue;
      }
      eligible.add(file);
    }

    const candidates: string[] = [];
    const allPartitions = await collectJournalPartitions(this.basePath);
    for (const family of groupPartitionsByFamily(allPartitions).values()) {
      for (const file of family) {
        if (file === activePath || !eligible.has(file)) break;
        candidates.push(file);
        eligible.delete(file);
      }
    }
    sc += eligible.size;

    if (!options.dryRun) {
      for (const file of candidates) {
        try {
          const familyBase = partitionFamilyBase(file);
          let deletedBytes: number | undefined;
          await withFileLock(familyBase, async () => {
            const fileStat = await fs.lstat(file);
            if (!fileStat.isFile() || fileStat.mtimeMs > cutoff) return;
            const checkpointResult = await readRetentionCheckpoint(familyBase);
            if (checkpointResult.error) throw new Error(checkpointResult.error);
            const checkpoint = checkpointResult.checkpoint;
            const nextCheckpoint = await verifyRetainedPrefix(
              streamEntriesStrict(file),
              checkpoint,
            );
            if (!nextCheckpoint)
              throw new Error('partition does not extend the trusted Chronicle chain');
            if (nextCheckpoint.sequence > (checkpoint?.sequence ?? 0)) {
              await writeRetentionCheckpoint(familyBase, nextCheckpoint);
            }
            deletedBytes = fileStat.size;
            await fs.unlink(file);
          });
          if (deletedBytes === undefined) {
            sc++;
            break;
          }
          db += deletedBytes;
          dc++;
        } catch (error) {
          errors.push({ file, reason: errorMessage(error) });
          sc++;
          // Candidates form an oldest-first prefix. Do not advance the
          // checkpoint beyond a partition that could not be removed: if its
          // checkpoint-covered bytes remain on disk, verify() must still be
          // able to anchor and validate them against that checkpoint.
          break;
        }
      }
    }
    return {
      deletedCount: dc,
      deletedBytes: db,
      skippedCount: sc,
      errors,
      ...(options.dryRun ? { candidates } : {}),
    };
  }

  private async maybeAutoPurge(): Promise<void> {
    if (this.retentionDays <= 0) return;
    const n = Date.now();
    if (n - this.lastAutoPurgeAt < this.autoPurgeIntervalMs) return;
    this.lastAutoPurgeAt = n;
    try {
      await this.purge({ retentionDays: this.retentionDays });
    } catch {
      /* best-effort */
    }
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.drainPromise) return;
    this.drainScheduled = true;
    if (this.batchWindowMs === 0) {
      queueMicrotask(() => {
        this.drainScheduled = false;
        this.startDrain();
      });
      return;
    }
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      this.drainScheduled = false;
      this.startDrain();
    }, this.batchWindowMs);
  }

  private startDrain(): void {
    if (this.drainPromise || this.pending.length === 0) return;
    const batch = this.pending.splice(0);
    const drain = this.persistBatch(batch);
    this.drainPromise = drain.finally(() => {
      this.drainPromise = undefined;
      if (this.pending.length > 0) this.scheduleDrain();
    });
  }

  private async refreshStateFromDisk(): Promise<void> {
    const files = await collectPartitions(this.basePath);
    const latest = files[files.length - 1] ?? this.basePath;
    this.partitionIndex = partitionIndex(latest, this.basePath);
    const state = await readLastEntryState(latest);
    const entry = state.entry;
    // A non-empty active partition already carries the latest sequence and
    // hash-chain anchor. The retention checkpoint is only needed when no
    // retained event exists, so avoid opening (or probing for) the sidecar on
    // every normal append batch.
    const checkpointResult = entry ? {} : await readRetentionCheckpoint(this.basePath);
    if (checkpointResult.error) throw new Error(checkpointResult.error);
    const checkpoint = checkpointResult.checkpoint;
    this.lastSequence = entry?.sequence ?? checkpoint?.sequence ?? 0;
    this.lastHash = entry?.hash ?? checkpoint?.hash ?? GENESIS_HASH;
    this.partitionSizeBytes = state.size;
    this.partitionStartedAt = state.birthtimeMs ?? Date.now();
    this.stateInitialized = true;
  }

  private async canReuseDiskState(): Promise<boolean> {
    if (!this.stateInitialized) return false;
    const nextPartition = rotatedPath(this.basePath, this.partitionIndex + 1);
    const [currentStat, nextExists] = await Promise.all([
      fs.stat(this.path).catch((error: unknown) => {
        if (isNotFound(error)) return undefined;
        throw error;
      }),
      fs.access(nextPartition).then(
        () => true,
        (error: unknown) => {
          if (isNotFound(error)) return false;
          throw error;
        },
      ),
    ]);
    // Appends change the active partition size; rotations create the next
    // numbered partition. If neither happened since our last successful
    // batch, the cached sequence/hash anchor is still current and there is no
    // need to rescan the directory or read the JSONL tail again.
    return (
      currentStat?.isFile() === true && currentStat.size === this.partitionSizeBytes && !nextExists
    );
  }

  private async checkRotation(): Promise<void> {
    if (this.partitionIndex === 0 && this.lastSequence === 0) return;
    if (
      Number.isFinite(this.rotationWindowMs) &&
      Date.now() - this.partitionStartedAt >= this.rotationWindowMs
    ) {
      this.rotate();
      return;
    }
    if (
      Number.isFinite(this.maxPartitionSizeBytes) &&
      this.partitionSizeBytes >= this.maxPartitionSizeBytes
    )
      this.rotate();
  }

  private rotate(): void {
    this.partitionIndex++;
    this.partitionStartedAt = Date.now();
    this.partitionSizeBytes = 0;
    this.counters.partitionRolls++;
  }

  private async persistBatch(batch: typeof this.pending): Promise<void> {
    const started = performance.now();
    this.counters.batches++;
    this.counters.largestBatch = Math.max(this.counters.largestBatch, batch.length);
    try {
      let recorded: ChronicleEvent[] = [];
      await withFileLock(this.basePath, async () => {
        if (!(await this.canReuseDiskState())) await this.refreshStateFromDisk();
        await this.checkRotation();
        const cp = this.path;
        let prev: { sequence: number; hash: string } | undefined =
          this.lastSequence > 0 ? { sequence: this.lastSequence, hash: this.lastHash } : undefined;
        recorded = batch.map(({ input }) => {
          const instant = this.now().toISOString();
          const uh = {
            ...input,
            occurredAt: input.occurredAt ?? instant,
            monotonicNs: input.monotonicNs ?? this.monotonicNow().toString(),
            schemaVersion: CHRONICLE_SCHEMA_VERSION,
            eventId: this.idFactory(),
            observedAt: instant,
            persistedAt: instant,
            sequence: (prev?.sequence ?? 0) + 1,
            previousHash: prev?.hash ?? GENESIS_HASH,
          };
          const event: ChronicleEvent = { ...uh, hash: hashValue(uh) };
          prev = event;
          return event;
        });
        const serialized = recorded.map((e) => JSON.stringify(e)).join('\n') + '\n';
        await fs.appendFile(cp, serialized, { encoding: 'utf8', mode: SECRET_FILE_MODE });
        this.partitionSizeBytes += Buffer.byteLength(serialized);
      });
      const last = recorded[recorded.length - 1]!;
      this.lastSequence = last.sequence;
      this.lastHash = last.hash;
      batch.forEach((item, i) => {
        item.resolve(recorded[i]!);
      });
      this.counters.persistedEvents += batch.length;
      void this.maybeAutoPurge();
    } catch (error) {
      // appendFile can fail after a partial write. Force the next batch to
      // rebuild its chain anchor from disk instead of trusting local counters.
      this.stateInitialized = false;
      this.counters.failedEvents += batch.length;
      batch.forEach((item) => {
        item.reject(error);
      });
    } finally {
      this.lastBatchDurationMs = performance.now() - started;
    }
  }
}

function rotatedPath(basePath: string, index: number): string {
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

async function collectJournalPartitions(basePath: string): Promise<string[]> {
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

function isJournalPartition(filePath: string, directory: string, basePath?: string): boolean {
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

function groupPartitionsByFamily(files: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const family = partitionFamilyBase(file);
    const group = groups.get(family) ?? [];
    group.push(file);
    groups.set(family, group);
  }
  return groups;
}

function partitionFamilyBase(filePath: string): string {
  return filePath.replace(/\.\d{5}(?=\.jsonl$)/, '');
}

function retentionCheckpointPath(basePath: string): string {
  return `${partitionFamilyBase(basePath)}.retention.json`;
}

async function verifyRetainedPrefix(
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

async function verifyPartitionFiles(
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

async function writeRetentionCheckpoint(
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

function partitionIndex(filePath: string, basePath: string): number {
  const ext = path.extname(basePath);
  return parseIndex(filePath, path.basename(basePath, ext), ext);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readLastEntryState(filePath: string): Promise<{
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
    while (position > 0) {
      const length = Math.min(65536, position);
      position -= length;
      const buf = Buffer.allocUnsafe(length);
      await handle.read(buf, 0, length, position);
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

async function readEntriesStrict(filePath: string): Promise<ChronicleEvent[]> {
  const entries: ChronicleEvent[] = [];
  for await (const entry of streamEntriesStrict(filePath)) entries.push(entry);
  return entries;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { GENESIS_HASH };
