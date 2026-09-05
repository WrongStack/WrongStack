import {
  fileGraphService,
  incomingCallsService,
  indexService,
  outgoingCallsService,
  packageGraphService,
  searchService,
  statsService,
  symbolGraphService,
} from './index-service.js';
import type {
  ProjectIndexServerActivity,
  ProjectServerClientMessage,
  ProjectServerMessage,
} from './project-server-protocol.js';
import {
  indexRefreshInProgressError,
  type ServerQueryCaches,
  staleAwareRead,
} from './project-server-query-cache.js';
import type { ActiveFullIndex, ClientState, FullIndexSubscriber } from './project-server-types.js';
import type {
  CallRefsOpArgs,
  FileGraphOpArgs,
  IndexOpArgs,
  OpShapes,
  SearchOpArgs,
  StatsOpArgs,
  SymbolGraphOpArgs,
} from './worker-protocol.js';

export interface OperationContext {
  projectRoot: string;
  indexDir: string;
  queryCaches: ServerQueryCaches;
  getActivity: () => ProjectIndexServerActivity;
  withIndexWrite: <T>(
    job: (onProgress: (currentFile: number, totalFiles: number) => void) => Promise<T>,
    options: { preserveCaches: boolean },
  ) => Promise<T>;
  send: (state: ClientState, message: ProjectServerMessage) => void;
  getActiveFullIndex: () => ActiveFullIndex | null;
  setActiveFullIndex: (active: ActiveFullIndex | null) => void;
}

/**
 * Cache policy at write-run completion.
 *
 * A run with an explicit targeted file list (edit/watcher reindex) makes a
 * per-file surgical change, so — on success — every previous-generation entry
 * stays valid as a stale answer for the NEXT refresh. On failure the run's
 * transaction rolls back, which equally leaves the cached entries describing
 * the on-disk truth. (Precision: the rollback is per-file — a multi-file
 * targeted run commits the files that parsed and rolls back only the failed
 * one — but each file's slice is atomic, and queries never straddle slices,
 * so cached answers stay correct.) Anything else (full scan, force rebuild,
 * langs/ignore-filtered scan) can reshape the whole index, so its caches are
 * dropped on completion and on failure alike.
 */
export function preservesQueryCaches(args: IndexOpArgs): boolean {
  return !args.force && args.files !== undefined && args.files.length > 0;
}

export function isShareableFullIndex(args: IndexOpArgs): boolean {
  return (
    !args.force &&
    (!args.files || args.files.length === 0) &&
    (!args.langs || args.langs.length === 0) &&
    (!args.ignore || args.ignore.length === 0)
  );
}

function fixedArgs<T extends { projectRoot: string; indexDir?: string | undefined }>(
  ctx: OperationContext,
  args: T,
): T {
  return { ...args, projectRoot: ctx.projectRoot, indexDir: ctx.indexDir };
}

export async function runFullIndex(
  ctx: OperationContext,
  state: ClientState,
  id: number,
  args: IndexOpArgs,
): Promise<OpShapes['index']['result']> {
  const subscriber: FullIndexSubscriber = { state, id };
  let active = ctx.getActiveFullIndex();
  if (!active) {
    const controller = new AbortController();
    const subscribers = new Set<FullIndexSubscriber>([subscriber]);
    const promise = ctx.withIndexWrite(
      (reportProgress) =>
        indexService(fixedArgs(ctx, args), {
          signal: controller.signal,
          onProgress: (current, total) => {
            reportProgress(current, total);
            for (const item of subscribers) {
              if (!item.state.cancelled.has(item.id)) {
                ctx.send(item.state, { type: 'progress', id: item.id, current, total });
              }
            }
          },
        }),
      // Shareable full index: whole-index scope, caches drop on completion.
      { preserveCaches: false },
    );
    active = { promise, controller, subscribers };
    ctx.setActiveFullIndex(active);
    void promise
      .finally(() => {
        if (ctx.getActiveFullIndex() === active) ctx.setActiveFullIndex(null);
      })
      .catch(() => {});
  } else {
    active.subscribers.add(subscriber);
  }

  const selected = active;
  state.cancel.set(id, () => {
    state.cancelled.add(id);
    selected.subscribers.delete(subscriber);
    if (selected.subscribers.size === 0) {
      selected.controller.abort(new Error('Indexing cancelled'));
    }
  });
  try {
    return await selected.promise;
  } finally {
    selected.subscribers.delete(subscriber);
  }
}

export async function dispatchOperation(
  ctx: OperationContext,
  state: ClientState,
  message: Extract<ProjectServerClientMessage, { type: 'request' }>,
): Promise<unknown> {
  const { id, op } = message;
  const indexActivity = ctx.getActivity();
  switch (op) {
    case 'index': {
      const args = message.args as IndexOpArgs;
      if (isShareableFullIndex(args)) return runFullIndex(ctx, state, id, args);
      const controller = new AbortController();
      state.cancel.set(id, () => {
        state.cancelled.add(id);
        controller.abort(new Error('Indexing cancelled'));
      });
      return ctx.withIndexWrite(
        (reportProgress) =>
          indexService(fixedArgs(ctx, args), {
            signal: controller.signal,
            onProgress: (current, total) => {
              reportProgress(current, total);
              if (!state.cancelled.has(id)) {
                ctx.send(state, { type: 'progress', id, current, total });
              }
            },
          }),
        { preserveCaches: preservesQueryCaches(args) },
      );
    }
    case 'search': {
      const { value, stale } = staleAwareRead(
        ctx.queryCaches.searchCache,
        JSON.stringify(message.args),
        indexActivity,
        () => searchService(fixedArgs(ctx, message.args as SearchOpArgs)),
      );
      return stale ? { ...value, stale: true } : value;
    }
    case 'stats':
      // Stats is the refresh progress poll: serving a cached pre-run answer
      // would read as "finished" with stale numbers, so it keeps refusing
      // for the whole refresh even on a cache hit.
      if (indexActivity.indexing) {
        throw indexRefreshInProgressError(indexActivity.currentFile, indexActivity.totalFiles);
      }
      return staleAwareRead(ctx.queryCaches.statsCache, 'stats', indexActivity, () =>
        statsService(fixedArgs(ctx, message.args as StatsOpArgs)),
      ).value;
    case 'packageGraph': {
      const { value, stale } = staleAwareRead(
        ctx.queryCaches.packageGraphCache,
        'package',
        indexActivity,
        () => packageGraphService(fixedArgs(ctx, message.args as StatsOpArgs)),
      );
      return stale ? { ...value, stale: true } : value;
    }
    case 'fileGraph': {
      const key = (message.args as FileGraphOpArgs).packageFilter;
      const { value, stale } = staleAwareRead(
        ctx.queryCaches.fileGraphCache,
        key,
        indexActivity,
        () => fileGraphService(fixedArgs(ctx, message.args as FileGraphOpArgs)),
      );
      return stale ? { ...value, stale: true } : value;
    }
    case 'symbolGraph': {
      const key = (message.args as SymbolGraphOpArgs).fileFilter;
      const { value, stale } = staleAwareRead(
        ctx.queryCaches.symbolGraphCache,
        key,
        indexActivity,
        () => symbolGraphService(fixedArgs(ctx, message.args as SymbolGraphOpArgs)),
      );
      return stale ? { ...value, stale: true } : value;
    }
    case 'incomingCalls': {
      const callArgs = fixedArgs(ctx, message.args as CallRefsOpArgs);
      const cacheKey = JSON.stringify([
        callArgs.symbol,
        callArgs.file ?? '',
        callArgs.limit ?? 100,
        callArgs.transitive ?? false,
      ]);
      const { value, stale } = staleAwareRead(
        ctx.queryCaches.incomingCallsCache,
        cacheKey,
        indexActivity,
        () => incomingCallsService(callArgs),
      );
      return stale ? { ...value, stale: true } : value;
    }
    case 'outgoingCalls': {
      const callArgs = fixedArgs(ctx, message.args as CallRefsOpArgs);
      const cacheKey = JSON.stringify([
        callArgs.symbol,
        callArgs.file ?? '',
        callArgs.limit ?? 100,
        callArgs.transitive ?? false,
      ]);
      const { value, stale } = staleAwareRead(
        ctx.queryCaches.outgoingCallsCache,
        cacheKey,
        indexActivity,
        () => outgoingCallsService(callArgs),
      );
      return stale ? { ...value, stale: true } : value;
    }
    default:
      throw new Error(`unknown index operation: ${String(op satisfies never)}`);
  }
}
