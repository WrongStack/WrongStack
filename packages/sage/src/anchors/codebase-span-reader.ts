/**
 * The production {@link SymbolSpanReader}: the codebase index's symbol reader (TypeScript's
 * parser for TS/JS, tree-sitter for the other indexed languages). Loaded on the first symbol
 * anchor that needs it, so a daemon that never sees one never loads a parser.
 */
import type { SymbolSpanReader } from './symbol-span.js';

export function codebaseSymbolSpanReader(projectRoot: string): SymbolSpanReader {
  return async (absPath, symbol, signal) => {
    signal?.throwIfAborted();
    const { readSymbolInFile } = await import('@wrongstack/tools/codebase-index');
    // Throws for a missing or ambiguous symbol and for an unsupported language; the caller
    // reads that as "no span" and keeps the name check.
    const found = await readSymbolInFile(
      { file: absPath, symbol, includeDocs: false, target: 'full' },
      projectRoot,
    );
    return { startLine: found.startLine, endLine: found.endLine, text: found.rawText };
  };
}
