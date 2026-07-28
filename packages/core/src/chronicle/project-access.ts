import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWstackPaths } from '../utils/wstack-paths.js';
import { type ChronicleRuntimeLocation, resolveChronicleRuntimeLocation } from './identity.js';
import { ChronicleJournal } from './journal.js';
import { ChronicleMetricsStore } from './metrics-store.js';
import {
  type ChronicleProjectServerCallOptions,
  ChronicleProjectServerClient,
  type ChronicleProjectServerClientOptions,
  ChronicleRemoteJournal,
  isChronicleProjectServerAvailable,
} from './project-server-client.js';
import type {
  ChronicleProjectServerHealth,
  ChronicleServerOperationName,
  ChronicleServerOperations,
} from './project-server-protocol.js';
import { CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION } from './project-server-protocol.js';
import { ChronicleQueryEngine } from './query.js';
import type { ChronicleEventSink } from './sink.js';

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
 * Production builds use the per-project IPC owner. Source-only development
 * and explicit recovery mode stay functional through the inline
 * implementation, while callers never open journal partitions or metrics.db.
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
  return new InlineChronicleProjectAccess(resolved);
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
  const journal = new ChronicleJournal({
    filePath: identity.journalPath,
    retentionDays: options.retentionDays,
  });
  return {
    journal,
    identity,
    serverBacked: false,
    dispose: () => journal.flush(),
  };
}

class InlineChronicleProjectAccess implements ChronicleProjectAccess {
  readonly mode = 'inline' as const;
  private readonly journals = new Map<string, ChronicleJournal>();

  constructor(private readonly options: ChronicleProjectServerClientOptions) {}

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
        return (await Promise.all(
          args.inputs.map((input) => this.journalForToday().append(input)),
        )) as ChronicleServerOperations[O]['result'];
      }
      case 'flush':
        await this.flush();
        return undefined as ChronicleServerOperations[O]['result'];
      case 'purge': {
        const args = rawArgs as ChronicleServerOperations['purge']['args'];
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
          const refreshed = args.refresh === false
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
  }

  private get chronicleDirectory(): string {
    return path.join(this.options.projectDir, 'chronicle');
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
        filePath: identity.journalPath,
        retentionDays: this.options.retentionDays,
      });
      this.journals.set(day, journal);
    }
    return journal;
  }

  private queryEngine(): Promise<ChronicleQueryEngine> {
    return ChronicleQueryEngine.fromDirectory(this.chronicleDirectory);
  }

  private async flush(): Promise<void> {
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
