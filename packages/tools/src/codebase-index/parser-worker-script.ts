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

import { parentPort, type MessagePort } from 'node:worker_threads';
import { parseFileContent } from './parser-dispatch.js';
import type { FileSymbols } from './schema.js';
import type { SymbolLang } from './schema.js';

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
  results: FileSymbols[];
  errors: ReadonlyArray<{ file: string; error: string }>;
}

export interface ParserWorkerShutdown {
  type: 'shutdown';
}

export type ParserWorkerInbound = ParserWorkerRequest | ParserWorkerShutdown;

/**
 * Parse a batch of files. Reads each file from disk, dispatches to the
 * appropriate parser, and collects results + errors.
 *
 * Errors are per-file — a single parse failure doesn't abort the batch.
 * The main thread decides what to do with errored files (fall back, skip, etc.).
 */
async function parseBatch(
  files: ReadonlyArray<{ file: string; content: string; lang: SymbolLang }>,
): Promise<{ results: FileSymbols[]; errors: { file: string; error: string }[] }> {
  const results: FileSymbols[] = [];
  const errors: { file: string; error: string }[] = [];

  for (const { file, content, lang } of files) {
    try {
      const parsed = await parseFileContent(file, content, lang);
      results.push(parsed);
    } catch (err) {
      errors.push({
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

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
      results: [],
      errors: msg.files.map((f) => ({
        file: f.file,
        error: err instanceof Error ? err.message : String(err),
      })),
    };
    port.postMessage(response);
  }
});
