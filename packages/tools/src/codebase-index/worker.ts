/**
 * Index worker entry point.
 *
 * Hosts ALL SQLite access and source parsing off the main thread. The
 * synchronous `node:sqlite` calls and the TypeScript compiler can block this
 * thread freely — the terminal UI never notices. If this thread truly wedges
 * (pathological parse, cross-process lock storm), the host's watchdog calls
 * `worker.terminate()` and respawns lazily; the index is derived data, so the
 * worst case is a re-run, never a frozen terminal.
 *
 * Protocol: see worker-protocol.ts. Requests are processed concurrently
 * (operations open their own store; host-side mutex already serializes
 * writes), each carrying an AbortController for cooperative cancellation.
 */

import { parentPort } from 'node:worker_threads';
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
  CallRefsOpArgs,
  FileGraphOpArgs,
  HostToWorker,
  IndexOpArgs,
  SearchOpArgs,
  StatsOpArgs,
  SymbolGraphOpArgs,
  WorkerToHost,
} from './worker-protocol.js';

if (!parentPort) throw new Error('codebase-index worker must be started as a worker thread');
// Narrowed alias — `parentPort` itself is typed nullable inside closures.
const port = parentPort as NonNullable<typeof parentPort>;

const inFlight = new Map<number, AbortController>();
let activeIndexes = 0;

function post(msg: WorkerToHost): void {
  port.postMessage(msg);
}

async function dispatch(msg: Extract<HostToWorker, { type: 'request' }>): Promise<unknown> {
  if (msg.op !== 'index' && activeIndexes > 0) {
    const error = new Error(
      'Codebase index refresh in progress; retry after the completed generation is published.',
    );
    error.name = 'IndexRefreshInProgressError';
    throw error;
  }
  switch (msg.op) {
    case 'index': {
      const ac = new AbortController();
      inFlight.set(msg.id, ac);
      activeIndexes++;
      try {
        return await indexService(msg.args as IndexOpArgs, {
          signal: ac.signal,
          onProgress: (current, total) => post({ type: 'progress', id: msg.id, current, total }),
        });
      } finally {
        activeIndexes--;
        inFlight.delete(msg.id);
      }
    }
    case 'search':
      return searchService(msg.args as SearchOpArgs);
    case 'stats':
      return statsService(msg.args as StatsOpArgs);
    case 'packageGraph':
      return packageGraphService(msg.args as StatsOpArgs);
    case 'fileGraph':
      return fileGraphService(msg.args as FileGraphOpArgs);
    case 'symbolGraph':
      return symbolGraphService(msg.args as SymbolGraphOpArgs);
    case 'incomingCalls':
      return incomingCallsService(msg.args as CallRefsOpArgs);
    case 'outgoingCalls':
      return outgoingCallsService(msg.args as CallRefsOpArgs);
    default:
      throw new Error(`unknown index op: ${(msg as { op: string }).op}`);
  }
}

port.on('message', (msg: HostToWorker) => {
  if (msg.type === 'cancel') {
    inFlight.get(msg.id)?.abort(new Error('Indexing cancelled'));
    return;
  }
  void dispatch(msg).then(
    (result) => post({ type: 'response', id: msg.id, ok: true, result }),
    (err: unknown) => {
      try {
        post({
          type: 'response',
          id: msg.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          errorName: err instanceof Error ? err.name : undefined,
        });
      } catch {
        // postMessage to a closed port — nothing we can do; drop the response.
      }
    },
  );
});
