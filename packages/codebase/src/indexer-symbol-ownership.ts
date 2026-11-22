import { isFrugalPerf } from '@wrongstack/core/utils';
import { resolveWorkerPoolThreshold } from './parser-worker-pool.js';
import {
  type Symbol as IndexSymbol,
  MODULE_OWNER_NAME,
  type Ref,
  type SymbolLang,
} from './schema.js';

/**
 * Pool startup is amortized across the complete index run, not one outer
 * batch. Balanced batches are capped at 40 files, so comparing the per-batch
 * parse count with the 500-file threshold made the worker path unreachable.
 *
 * Threshold is env-configurable (audit T-04): `WRONGSTACK_INDEX_WORKER_THRESHOLD`
 * overrides the default, `0` disables the worker path entirely.
 */
export function shouldUseParserWorkerPool(
  candidateFileCount: number,
  parseBatchCount: number,
  opts: { rebuild?: boolean | undefined } = {},
): boolean {
  const threshold = resolveWorkerPoolThreshold();
  // 0 = explicit opt-out: no candidate count (not even 0 itself, which would
  // satisfy >= 0) may take the worker path.
  if (threshold === 0) return false;
  // Frugal (the project server) keeps parsing on its own thread, except for a
  // rebuild into an empty index: that is the run a user waits on, and it gets
  // a bounded pool of its own (FRUGAL_REBUILD_WORKERS).
  if (isFrugalPerf() && !opts.rebuild) return false;
  return candidateFileCount >= threshold && parseBatchCount > 1;
}

/**
 * Refs hang off symbols, so a file that declares nothing — a test file of
 * `describe`/`it` blocks, a barrel of `export … from`, an entry script — used
 * to lose every import and call it made: a tenth of this repository's files
 * were absent from the dependency graph, and re-export chains broke at every
 * pure barrel. Such a file gets one `mod` symbol at its top instead. Its text
 * is empty, so it stays out of search.
 */
export function moduleOwnerSymbol(file: string, lang: SymbolLang): IndexSymbol {
  return {
    id: 0,
    lang,
    kind: 'mod',
    name: MODULE_OWNER_NAME,
    file,
    line: 1,
    col: 0,
    signature: '',
    docComment: '',
    scope: '',
    text: '',
  };
}

/**
 * A file needs a `<module>` owner when it declares nothing, or when it has
 * imports or top-level refs before its first declaration. Without one, imports
 * were pinned on the first declaration: `import { x }` read as "interface Foo
 * calls x", and the transitive tree walked on from Foo's real callers.
 */
export function needsModuleOwner(symbols: readonly IndexSymbol[], refs: readonly Ref[]): boolean {
  if (symbols.length === 0) return true;
  const first = Math.min(...symbols.map((s) => s.line));
  return refs.some((ref) => ref.callType === 'import' || ref.line < first);
}

export { assignRefsToSymbols } from './writer-helpers.js';
