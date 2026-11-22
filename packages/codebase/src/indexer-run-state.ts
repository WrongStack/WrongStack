/**
 * Mutable bookkeeping of one index run, shared by the indexer's batch phases
 * (indexer-batch-read.ts, indexer-batch-commit.ts) and its finalization
 * (indexer-finalize.ts).
 */

import type { SymbolSnapshotItem } from './ecosystem-bridge.js';
import type { FileMeta } from './schema.js';

/**
 * Metadata key that changes whenever an index run changed rows or edges —
 * the content stamp for caches derived from the graph.
 */
export const GRAPH_STAMP_KEY = 'graph_stamp';

/**
 * Bump to re-parse every file once so its refs get the current owners.
 * 1: symbol-less files own their refs. 2: imports are owned by `<module>`,
 * not by the file's first declaration.
 */
export const MODULE_OWNER_VERSION = '2';
export const MODULE_OWNER_VERSION_KEY = 'module_owner_version';

/**
 * Detect AbortError (DOMException with name 'AbortError') thrown by signal-aware
 * fs.promises calls (stat, readFile). We must re-throw these so the cancellation
 * propagates — catching them as ordinary errors would keep the loop running.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export interface IndexRunState {
  /** Rebuilding into a cleared index (secondary indexes deferred, nothing to replace). */
  clearedAll: boolean;
  errors: string[];
  langStats: Record<string, number>;
  // P5.15: filesIndexed counts ONLY files parsed and committed with symbols
  // (mirrors filesParsed). Skips/empties live in fileOutcomes. Invariant:
  // exactly one counter (filesIndexed/filesParsed, filesSkipped, filesEmpty,
  // filesFailed) bumps per file outcome — filesIndexed is the parsed branch.
  filesIndexed: number;
  filesParsed: number;
  filesSkipped: number;
  filesEmpty: number;
  filesFailed: number;
  symbolsIndexed: number;
  /** Previous file rows (content stamps cleared for stale module owners). */
  existingMeta: Map<string, FileMeta>;
  // What this run changes, for the relation and rank passes: a run that
  // changed nothing must not redo repository-wide work.
  rewritten: Set<string>;
  added: Set<string>;
  deleted: Set<string>;
  /** Content hash each rewritten file's new rows were built from. */
  rewrittenHashes: Map<string, string>;
  /** Files whose read/parse/commit failed; their rows are the last good copy. */
  failed: Set<string>;
  // Ref names awaiting resolution, resolved once after the batch loop — or
  // not at all when the run ends with a whole-table resolution anyway.
  deferredRefNames: Set<string>;
  /** Populated on incremental runs when `.wrongstack/memories` exists to heal SAGE anchors. */
  prevSymbolsForHeal?: SymbolSnapshotItem[] | undefined;
  nextSymbolsForHeal?: SymbolSnapshotItem[] | undefined;
}

export function noteRewritten(run: IndexRunState, file: string, contentHash: string): void {
  run.rewritten.add(file);
  run.rewrittenHashes.set(file, contentHash);
  if (run.clearedAll || !run.existingMeta.has(file)) run.added.add(file);
}
