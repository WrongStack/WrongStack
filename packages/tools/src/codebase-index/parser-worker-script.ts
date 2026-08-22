/**
 * Parser worker entry point for P5's multi-threaded parser pool.
 *
 * Each worker in the pool runs this script. It receives batches of files,
 * reads them from disk, parses them via the existing `parseFileContent`
 * dispatch (which routes to tree-sitter, the TS compiler, etc.), and returns
 * the parsed `FileSymbols[]` back to the main thread.
 *
 * Workers never touch SQLite — the main thread owns all DB writes via
 * `commitBatch`. This keeps the WAL writer single-threaded and avoids
 * cross-thread `node:sqlite` issues.
 *
 * The worker terminates cleanly when it receives a `{ type: 'shutdown' }`
 * message. If the parent port closes unexpectedly, the worker exits.
 */

import { type MessagePort, parentPort, threadId } from 'node:worker_threads';
import { parseFilesContent } from './parser-dispatch.js';
import type { FileSymbols, SymbolLang } from './schema.js';

if (!parentPort) {
  throw new Error('parser-worker-script must be started as a worker thread');
}
// Narrowed alias — `parentPort` itself is typed nullable inside closures.
const port: MessagePort = parentPort;

export interface ParserWorkerRequest {
  type: 'parse';
  id: number;
  /** Content is pre-read by the main thread for the hash check; passed here
   *  to avoid a second disk read in the worker. */
  files: ReadonlyArray<{ file: string; content: string; lang: SymbolLang }>;
}

export interface ParserWorkerResponse {
  type: 'result';
  id: number;
  /** Identity of the responding worker (`threadId`) — lets the pool free
   *  exactly the worker that answered, and detect which chunk is orphaned
   *  when a worker dies mid-batch. */
  workerId: number;
  results: FileSymbols[];
  errors: ReadonlyArray<{ file: string; error: string }>;
}

export interface ParserWorkerShutdown {
  type: 'shutdown';
}

export type ParserWorkerInbound = ParserWorkerRequest | ParserWorkerShutdown;

/**
 * Parse a batch of files. P3.8: routes through `parseFilesContent`, which
 * hands Go/Python files to one toolchain child process per chunk and every
 * other language to the per-file dispatch. A file absent from the results
 * failed everywhere (batch + per-file fallback) and is reported as an error
 * so the main thread's commit loop records it instead of silently indexing
 * an empty file.
 */
async function parseBatch(
  files: ReadonlyArray<{ file: string; content: string; lang: SymbolLang }>,
): Promise<{ results: FileSymbols[]; errors: { file: string; error: string }[] }> {
  const slots = await parseFilesContent(files);
  const results: FileSymbols[] = [];
  const errors: { file: string; error: string }[] = [];
  slots.forEach((slot, i) => {
    if (slot.result) results.push(slot.result);
    else errors.push({ file: files[i]!.file, error: slot.error ?? 'parse produced no result' });
  });
  return { results, errors };
}

port.on('message', async (msg: ParserWorkerInbound) => {
  if (msg.type === 'shutdown') {
    port.close();
    return;
  }

  try {
    const { results, errors } = await parseBatch(msg.files);
    const response: ParserWorkerResponse = {
      type: 'result',
      id: msg.id,
      workerId: threadId,
      results,
      errors,
    };
    port.postMessage(response);
  } catch (err) {
    // Catastrophic failure — return empty results so the main thread
    // can fall back to inline parsing for this batch.
    const response: ParserWorkerResponse = {
      type: 'result',
      id: msg.id,
      workerId: threadId,
      results: [],
      errors: msg.files.map((f) => ({
        file: f.file,
        error: err instanceof Error ? err.message : String(err),
      })),
    };
    port.postMessage(response);
  }
});
