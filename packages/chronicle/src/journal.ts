import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { restrictFilePermissions, SECRET_FILE_MODE } from '@wrongstack/core/security';
import { withFileLock } from '@wrongstack/core/utils';
import { GENESIS_HASH, hashValue } from './event-hash.js';
import {
  collectJournalPartitions,
  collectPartitions,
  errorMessage,
  groupPartitionsByFamily,
  isJournalPartition,
  isNotFound,
  partitionFamilyBase,
  partitionIndex,
  readEntriesStrict,
  readLastEntryState,
  readRetentionCheckpoint,
  rotatedPath,
  streamEntriesStrict,
  verifyPartitionFiles,
  verifyRetainedPrefix,
  writeRetentionCheckpoint,
} from './journal-partitions.js';
import {
  CHRONICLE_SCHEMA_VERSION,
  type ChronicleEvent,
  type ChronicleEventInput,
  type ChronicleVerifyResult,
} from './types.js';

export {
  collectPartitions,
  readRetentionCheckpoint,
  streamEntriesStrict,
} from './journal-partitions.js';

const DEFAULT_MAX_PARTITION_BYTES = 100 * 1024 * 1024;
const DEFAULT_ROTATION_WINDOW_MS = 60 * 60 * 1000;
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
  /** Partition paths already owner-only hardened (once per partition). */
  private readonly hardenedPartitions = new Set<string>();

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
        // F21 (WS-045 class, F20 sibling): on Windows `mode: 0o600` is a no-op,
        // so this append-only event journal — which carries tool inputs/outputs
        // — stayed readable by other local accounts wherever inheritance was not
        // already owner-only. Harden once per partition (first batch), best-effort
        // (warned, never thrown); rotation produces a new path that is hardened on
        // its first batch. No per-batch icacls spawn on the hot append path.
        if (!this.hardenedPartitions.has(cp)) {
          this.hardenedPartitions.add(cp);
          await restrictFilePermissions(cp, { label: 'chronicle-journal' });
        }
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

export { GENESIS_HASH };
