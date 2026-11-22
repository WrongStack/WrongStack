import { IndexTimeoutError } from './circuit-breaker.js';
import {
  contextService as contextServiceInline,
  fileGraphService as fileGraphServiceInline,
  incomingCallsService as incomingCallsServiceInline,
  indexService,
  outgoingCallsService as outgoingCallsServiceInline,
  packageGraphService as packageGraphServiceInline,
  searchService,
  statsService,
  symbolGraphService as symbolGraphServiceInline,
  vectorSearchService as vectorSearchServiceInline,
} from './index-service.js';
import type {
  CallRefsOpArgs,
  ContextOpArgs,
  FileGraphOpArgs,
  IndexOpArgs,
  OpName,
  OpShapes,
  SearchOpArgs,
  StatsOpArgs,
  SymbolGraphOpArgs,
  VectorSearchOpArgs,
} from './worker-protocol.js';

export interface CallOpts {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  onProgress?: ((current: number, total: number) => void) | undefined;
}

/** Inline fallback: same service code, raced against the same watchdog. */
export async function callInline<O extends OpName>(
  op: O,
  args: OpShapes[O]['args'],
  opts: CallOpts,
  indexing: boolean,
): Promise<OpShapes[O]['result']> {
  if (op !== 'index' && indexing) {
    const error = new Error(
      'Codebase index refresh in progress; retry after the completed generation is published.',
    );
    error.name = 'IndexRefreshInProgressError';
    throw error;
  }
  const ac = new AbortController();
  const onOuterAbort = () => ac.abort(opts.signal?.reason ?? new Error('Indexing cancelled'));
  if (opts.signal?.aborted) onOuterAbort();
  else opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new IndexTimeoutError(
        `Index ${op} exceeded its ${opts.timeoutMs}ms watchdog timeout`,
      );
      ac.abort(err);
      reject(err);
    }, opts.timeoutMs);
    timer.unref?.();
  });

  const job = async (): Promise<OpShapes[O]['result']> => {
    switch (op) {
      case 'index':
        return (await indexService(args as IndexOpArgs, {
          signal: ac.signal,
          onProgress: opts.onProgress,
        })) as OpShapes[O]['result'];
      case 'search':
        return searchService(args as SearchOpArgs) as OpShapes[O]['result'];
      // `context` and `vectorSearch` were served by the worker and the project
      // server but missing here, so inline mode (WRONGSTACK_INDEX_INLINE=1, or
      // no worker build) failed every codebase-context call with
      // "unknown index op".
      case 'context':
        return contextServiceInline(args as ContextOpArgs) as OpShapes[O]['result'];
      case 'vectorSearch':
        return vectorSearchServiceInline(args as VectorSearchOpArgs) as OpShapes[O]['result'];
      case 'stats':
        return statsService(args as StatsOpArgs) as OpShapes[O]['result'];
      case 'packageGraph':
        return packageGraphServiceInline(args as StatsOpArgs) as OpShapes[O]['result'];
      case 'fileGraph':
        return fileGraphServiceInline(args as FileGraphOpArgs) as OpShapes[O]['result'];
      case 'symbolGraph':
        return symbolGraphServiceInline(args as SymbolGraphOpArgs) as OpShapes[O]['result'];
      case 'incomingCalls':
        return incomingCallsServiceInline(args as CallRefsOpArgs) as OpShapes[O]['result'];
      case 'outgoingCalls':
        return outgoingCallsServiceInline(args as CallRefsOpArgs) as OpShapes[O]['result'];
      default:
        throw new Error(`unknown index op: ${String(op)}`);
    }
  };

  try {
    return await Promise.race([job(), watchdog]);
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}
