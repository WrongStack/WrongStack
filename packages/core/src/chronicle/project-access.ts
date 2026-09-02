import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWstackPaths } from '../utils/wstack-paths.js';
import { type ChronicleRuntimeLocation, resolveChronicleRuntimeLocation } from './identity.js';
import { ChronicleJournal, type ChronicleJournalStats } from './journal.js';
import { ChronicleMetricsStore } from './metrics-store.js';
import { importLegacyChronicleJournal } from './legacy-journal-import.js';
import { ChronicleSqliteJournal } from './sqlite-journal.js';
import type { ChronicleSqliteQueryEngine } from './sqlite-query.js';
import {
  type ChronicleProjectServerCallOptions,
  ChronicleProjectServerClient,
  type ChronicleProjectServerClientOptions,
  ChronicleRemoteJournal,
  isChronicleProjectServerAvailable,
  resolveChronicleDaemonAvailability,
} from './project-server-client.js';
import type {
  ChronicleProjectServerHealth,
  ChronicleServerOperationName,
  ChronicleServerOperations,
} from './project-server-protocol.js';
import { CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION } from './project-server-protocol.js';
import { ChronicleQueryEngine } from './query.js';
import type { ChronicleEventSink } from './sink.js';
import type { ChronicleEvent, ChronicleEventInput } from './types.js';

export interface ChronicleProjectAccessOptions {
  projectRoot: string;
  userHome?: string | undefined;
  retentionDays?: number | undefined;
  projectPaths?:
    | {
        globalRoot: string;
        projectId: string;
        projectDir: string;
        workspaceId: string;
      }
    | undefined;
}

export interface ChronicleProjectAccess {
  readonly mode: 'server' | 'inline';
  call<O extends ChronicleServerOperationName>(
    op: O,
    args: ChronicleServerOperations[O]['args'],
    options?: ChronicleProjectServerCallOptions,
  ): Promise<ChronicleServerOperations[O]['result']>;
  close(): Promise<void>;
}

export interface ChronicleEventJournalHandle {
  journal: ChronicleEventSink;
  identity: ChronicleRuntimeLocation;
  serverBacked: boolean;
  dispose(): Promise<void>;
}

export function resolveChronicleProjectServerOptions(
  options: ChronicleProjectAccessOptions,
): ChronicleProjectServerClientOptions {
  if (options.projectPaths) {
    return {
      projectRoot: path.resolve(options.projectRoot),
      ...options.projectPaths,
      ...(options.retentionDays !== undefined ? { retentionDays: options.retentionDays } : {}),
    };
  }
  const paths = resolveWstackPaths({
    projectRoot: options.projectRoot,
    userHome: options.userHome ?? os.homedir(),
  });
  return {
    projectRoot: path.resolve(options.projectRoot),
    globalRoot: paths.globalRoot,
    projectId: paths.projectHash,
    projectDir: paths.projectDir,
    workspaceId: paths.projectSlug,
    ...(options.retentionDays !== undefined ? { retentionDays: options.retentionDays } : {}),
  };
}

/**
 * Canonical read/process/control gateway for Chronicle consumers.
 *
 * Production builds use the per-project IPC owner. Explicit recovery mode
 * stays functional through the inline implementation; a missing daemon build
 * fails closed instead of silently creating a process-local journal.
 */
export function createChronicleProjectAccess(
  options: ChronicleProjectAccessOptions,
): ChronicleProjectAccess {
  const resolved = resolveChronicleProjectServerOptions(options);
  if (isChronicleProjectServerAvailable()) {
    const client = new ChronicleProjectServerClient(resolved);
    return {
      mode: 'server',
      call: <O extends ChronicleServerOperationName>(
        op: O,
        args: ChronicleServerOperations[O]['args'],
        callOptions?: ChronicleProjectServerCallOptions,
      ) => client.call(op, args, callOptions),
      close: () => client.close(),
    };
  }
  assertInlineWasRequested('createChronicleProjectAccess');
  return new InlineChronicleProjectAccess(resolved);
}

/**
 * Refuse to run in-process unless the operator asked for it.
 *
 * Chronicle is a per-project singleton: one daemon owns the journal so every
 * terminal appends to the same hash chain. Dropping to an in-process journal
 * because the build could not be located gives each process its own chain
 * instead — no error, just silently divergent history. A missing build is a
 * defect to fix, not a mode to enter.
 */
function assertInlineWasRequested(caller: string): void {
  if (resolveChronicleDaemonAvailability().kind !== 'missing-build') return;
  throw new Error(
    `${caller}: built Chronicle project server is unavailable. Build @wrongstack/core, ` +
      'or set WRONGSTACK_CHRONICLE_INLINE=1 to explicitly accept a process-local journal.',
  );
}

/** Canonical producer sink selection used by CLI/TUI session wiring. */
export function createChronicleEventJournal(
  options: ChronicleProjectAccessOptions,
): ChronicleEventJournalHandle {
  const resolved = resolveChronicleProjectServerOptions(options);
  const identity = resolveChronicleRuntimeLocation({
    globalRoot: resolved.globalRoot,
    projectId: resolved.projectId,
    projectDir: resolved.projectDir,
  });
  if (isChronicleProjectServerAvailable()) {
    const journal = new ChronicleRemoteJournal(resolved);
    return {
      journal,
      identity,
      serverBacked: true,
      dispose: () => journal.dispose(),
    };
  }
  assertInlineWasRequested('createChronicleEventJournal');
  if (useSqliteStore()) {
    const journal = new ChronicleSqliteEventSink(path.join(resolved.projectDir, 'chronicle'));
    return {
      journal,
      identity,
      serverBacked: false,
      dispose: () => journal.close(),
    };
  }
  const journal = new ChronicleJournal({
    filePath: legacyPartitionPath(identity),
    retentionDays: options.retentionDays,
  });
  return {
    journal,
    identity,
    serverBacked: false,
    dispose: () => journal.flush(),
  };
}

/** Compose the legacy partition path a `ChronicleJournal` writes to. */
function legacyPartitionPath(location: { chronicleDirectory: string; day: string }): string {
  return path.join(location.chronicleDirectory, `${location.day}.events.jsonl`);
}

/**
 * Storage backend for the in-process path.
 *
 * SQLite is the default; `WRONGSTACK_CHRONICLE_STORE=jsonl` restores the legacy
 * partition writer. The escape hatch exists because the cut-over is the one
 * step of `chronicle-sqlite-journal-v1` that cannot be undone by re-reading the
 * old files — once events are appended to `chronicle.sqlite` they are not
 * mirrored back.
 */
function useSqliteStore(): boolean {
  return process.env['WRONGSTACK_CHRONICLE_STORE'] !== 'jsonl';
}

/**
 * Producer sink over the SQLite journal.
 *
 * `createChronicleEventJournal` is synchronous but opening the store has to
 * import the legacy partitions first, so every append is queued behind that one
 * promise. Without the queue a session's first events could be written before
 * the import, landing *after* imported history in a chain that must stay dense.
 */
class ChronicleSqliteEventSink implements ChronicleEventSink {
  private readonly ready: Promise<ChronicleSqliteJournal>;
  private last: ChronicleJournalStats | undefined;

  constructor(directory: string) {
    this.ready = (async () => {
      await fsPromises.mkdir(directory, { recursive: true });
      const journal = new ChronicleSqliteJournal({ directory });
      try {
        await importLegacyChronicleJournal(journal, directory);
      } catch (error) {
        journal.close();
        throw error;
      }
      return journal;
    })();
  }

  async append(input: ChronicleEventInput): Promise<ChronicleEvent> {
    const journal = await this.ready;
    const event = await journal.append(input);
    this.last = journal.stats();
    return event;
  }

  async flush(): Promise<void> {
    await this.ready;
  }

  stats(): ChronicleJournalStats {
    return this.last ?? EMPTY_JOURNAL_STATS;
  }

  async close(): Promise<void> {
    (await this.ready).close();
  }
}

const EMPTY_JOURNAL_STATS: ChronicleJournalStats = {
  acceptedEvents: 0,
  persistedEvents: 0,
  rejectedEvents: 0,
  failedEvents: 0,
  batches: 0,
  pendingEvents: 0,
  maxObservedPending: 0,
  largestBatch: 0,
  partitionRolls: 0,
};

/**
 * Days of journal to keep open. Yesterday stays available because events can
 * still arrive for it right after midnight; anything older can only accumulate.
 */
const MAX_OPEN_JOURNAL_DAYS = 2;

class InlineChronicleProjectAccess implements ChronicleProjectAccess {
  readonly mode = 'inline' as const;
  private readonly journals = new Map<string, ChronicleJournal>();
  private sqlite: Promise<ChronicleSqliteJournal> | undefined;

  constructor(private readonly options: ChronicleProjectServerClientOptions) {}

  /**
   * Open the SQLite journal, importing the legacy partitions the first time.
   *
   * The import is part of opening rather than a separate migration step so no
   * caller can read a half-migrated store: until it finishes, this promise has
   * not resolved and every operation is still queued behind it.
   */
  private store(): Promise<ChronicleSqliteJournal> {
    this.sqlite ??= (async () => {
      await fsPromises.mkdir(this.chronicleDirectory, { recursive: true });
      const journal = new ChronicleSqliteJournal({ directory: this.chronicleDirectory });
      try {
        await importLegacyChronicleJournal(journal, this.chronicleDirectory);
      } catch (error) {
        // Mirrors the daemon: a cached rejection would make every later call
        // fail identically while the handle holds the WAL open.
        this.sqlite = undefined;
        journal.close();
        throw error;
      }
      return journal;
    })();
    return this.sqlite;
  }

  async call<O extends ChronicleServerOperationName>(
    op: O,
    rawArgs: ChronicleServerOperations[O]['args'],
    _callOptions?: ChronicleProjectServerCallOptions,
  ): Promise<ChronicleServerOperations[O]['result']> {
    switch (op) {
      case 'ping':
        return this.health() as ChronicleServerOperations[O]['result'];
      case 'append': {
        const args = rawArgs as ChronicleServerOperations['append']['args'];
        if (useSqliteStore()) {
          const store = await this.store();
          return (await store.appendBatch(args.inputs)) as ChronicleServerOperations[O]['result'];
        }
        return (await Promise.all(
          args.inputs.map((input) => this.journalForToday().append(input)),
        )) as ChronicleServerOperations[O]['result'];
      }
      case 'flush':
        await this.flush();
        return undefined as ChronicleServerOperations[O]['result'];
      case 'purge': {
        const args = rawArgs as ChronicleServerOperations['purge']['args'];
        if (useSqliteStore()) {
          const store = await this.store();
          return (await store.purge(args)) as ChronicleServerOperations[O]['result'];
        }
        return (await this.journalForToday().purge(args)) as ChronicleServerOperations[O]['result'];
      }
      case 'query': {
        const args = rawArgs as ChronicleServerOperations['query']['args'];
        return (await (
          await this.queryEngine()
        ).query(args.query)) as ChronicleServerOperations[O]['result'];
      }
      case 'facet': {
        const args = rawArgs as ChronicleServerOperations['facet']['args'];
        const engine = await this.queryEngine();
        return {
          values: await engine.facet(args.field, args.query, args.limit),
          diagnostics: engine.diagnostics,
        } as ChronicleServerOperations[O]['result'];
      }
      case 'facets': {
        const args = rawArgs as ChronicleServerOperations['facets']['args'];
        const engine = await this.queryEngine();
        return {
          values: await engine.facets(args.fields, args.query, args.limit),
          diagnostics: engine.diagnostics,
        } as ChronicleServerOperations[O]['result'];
      }
      case 'graph': {
        const args = rawArgs as ChronicleServerOperations['graph']['args'];
        return (await (
          await this.queryEngine()
        ).graph(args.seed, args.hops, args.maxNodes)) as ChronicleServerOperations[O]['result'];
      }
      case 'metrics': {
        const args = rawArgs as ChronicleServerOperations['metrics']['args'];
        const store = ChronicleMetricsStore.open(this.chronicleDirectory);
        try {
          const refreshed =
            args.refresh === false
              ? { ingestedEvents: 0, ingestedBytes: 0, sourceFiles: 0, invalidLines: 0 }
              : await store.refresh();
          const data =
            args.view === 'providers'
              ? store.providerDaily(args.providers)
              : args.view === 'tasks'
                ? store.taskOutcomes(args.tasks)
                : args.view === 'files'
                  ? store.fileLineage(args.files)
                  : store.summary();
          return { refreshed, data } as ChronicleServerOperations[O]['result'];
        } finally {
          store.close();
        }
      }
    }
  }

  async close(): Promise<void> {
    await this.flush();
    // Releasing the SQLite handle is part of closing, not an optimization: the
    // connection holds `-wal` and `-shm` sidecars open, so leaving it dangling
    // leaks a file handle per access object and blocks directory removal.
    if (this.sqlite) {
      const store = await this.sqlite;
      this.sqlite = undefined;
      store.close();
    }
    for (const journal of this.journals.values()) {
      await journal.flush().catch(() => {});
    }
    this.journals.clear();
  }

  private get chronicleDirectory(): string {
    return path.join(this.options.projectDir, 'chronicle');
  }

  /**
   * Drop journals for days we will not write to again.
   *
   * Mirrors the daemon's `pruneJournals` in `project-server.ts`: without a cap
   * an inline access object that lives across midnight kept one open
   * `ChronicleJournal` (with its write buffer and file handle) per day, forever.
   */
  private pruneJournals(currentDay: string): void {
    if (this.journals.size <= MAX_OPEN_JOURNAL_DAYS) return;
    const keep = new Set(
      [...this.journals.keys()].sort().reverse().slice(0, MAX_OPEN_JOURNAL_DAYS),
    );
    keep.add(currentDay);
    for (const [day, journal] of this.journals) {
      if (keep.has(day)) continue;
      this.journals.delete(day);
      // Flush what is still buffered before letting it go. Detached, so a slow
      // disk cannot stall an append — but never unhandled.
      void journal.flush().catch(() => {
        /* best-effort: this day is being dropped either way */
      });
    }
  }

  private journalForToday(): ChronicleJournal {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    let journal = this.journals.get(day);
    if (!journal) {
      const identity = resolveChronicleRuntimeLocation({
        globalRoot: this.options.globalRoot,
        projectId: this.options.projectId,
        projectDir: this.options.projectDir,
        now,
      });
      journal = new ChronicleJournal({
        filePath: legacyPartitionPath(identity),
        retentionDays: this.options.retentionDays,
      });
      this.journals.set(day, journal);
      this.pruneJournals(day);
    }
    return journal;
  }

  /**
   * Both engines expose the same read surface, so every `call()` branch is
   * backend-agnostic. The SQLite one shares the journal's connection, which is
   * also what makes the legacy import a precondition of reading.
   */
  private async queryEngine(): Promise<ChronicleQueryEngine | ChronicleSqliteQueryEngine> {
    if (useSqliteStore()) return (await this.store()).queryEngine();
    return ChronicleQueryEngine.fromDirectory(this.chronicleDirectory);
  }

  private async flush(): Promise<void> {
    if (useSqliteStore()) {
      // Writes are transactional, so this only has to wait for an in-flight
      // open (and its legacy import) rather than drain a buffer.
      if (this.sqlite) await this.sqlite;
      return;
    }
    await Promise.all([...this.journals.values()].map((journal) => journal.flush()));
  }

  private health(): ChronicleProjectServerHealth {
    const memory = process.memoryUsage();
    return {
      protocolVersion: CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION,
      pid: process.pid,
      projectRoot: this.options.projectRoot,
      projectDir: this.options.projectDir,
      chronicleDirectory: this.chronicleDirectory,
      endpoint: 'inline',
      startedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
      checkedAt: Date.now(),
      uptimeMs: Math.round(process.uptime() * 1_000),
      clients: 1,
      activeRequests: 0,
      journal: this.journalForToday().stats(),
      watcher: { active: false, watchedFiles: 0 },
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
      },
    };
  }
}
