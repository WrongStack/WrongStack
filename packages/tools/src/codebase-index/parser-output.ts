/**
 * Shared decoding for the out-of-process parsers (Go's `go/ast`, Python's
 * `ast`).
 *
 * Both emit `{"symbols": [...], "refs": [...]}` from a single run, so symbols
 * and cross-references cost one child process rather than two — the same
 * one-walk-yields-both shape the in-process TypeScript parser has.
 *
 * The older array-only payload (`[{name, kind, …}]`) is still accepted: parser
 * scripts are written to a temp file that can outlive the process that wrote
 * it, and a stale script must degrade to "symbols but no edges", never to a
 * hard parse failure that drops the file from the index entirely.
 */

import type { CallType, Ref, SymbolLang } from './schema.js';

interface RawParsedSymbol {
  name: string;
  kind: string;
  line: number;
  col: number;
  signature: string;
  scope: string;
}

interface ParsedParserOutput {
  symbols: RawParsedSymbol[];
  refs: Ref[];
}

const CALL_TYPES: ReadonlySet<string> = new Set<CallType>([
  'call',
  'type_ref',
  'inherit',
  'implement',
  'import',
]);

function coerceSymbols(value: unknown): RawParsedSymbol[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): RawParsedSymbol[] => {
    const candidate = entry as Partial<RawParsedSymbol>;
    if (typeof candidate.name !== 'string' || typeof candidate.kind !== 'string') return [];
    return [
      {
        name: candidate.name,
        kind: candidate.kind,
        line: typeof candidate.line === 'number' ? candidate.line : 1,
        col: typeof candidate.col === 'number' ? candidate.col : 0,
        signature: typeof candidate.signature === 'string' ? candidate.signature : '',
        scope: typeof candidate.scope === 'string' ? candidate.scope : '',
      },
    ];
  });
}

function coerceRefs(value: unknown, lang: SymbolLang): Ref[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Ref[] => {
    const candidate = entry as {
      toName?: unknown;
      callType?: unknown;
      line?: unknown;
      module?: unknown;
    };
    if (typeof candidate.toName !== 'string' || !candidate.toName) return [];
    if (typeof candidate.callType !== 'string' || !CALL_TYPES.has(candidate.callType)) return [];
    const module =
      typeof candidate.module === 'string' && candidate.module ? candidate.module : undefined;
    return [
      {
        fromId: 0,
        toName: candidate.toName,
        callType: candidate.callType as CallType,
        line: typeof candidate.line === 'number' ? candidate.line : 1,
        lang,
        module,
      },
    ];
  });
}

/** Decode a parser child process's stdout. Never throws. */
export function parseParserOutput(stdout: string, lang: SymbolLang): ParsedParserOutput {
  const trimmed = stdout.trim();
  if (!trimmed) return { symbols: [], refs: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { symbols: [], refs: [] };
  }

  // Legacy shape: a bare array of symbols, no refs.
  if (Array.isArray(parsed)) return { symbols: coerceSymbols(parsed), refs: [] };

  const record = parsed as { symbols?: unknown; refs?: unknown };
  return {
    symbols: coerceSymbols(record.symbols),
    refs: dedupeRefs(coerceRefs(record.refs, lang)),
  };
}

/**
 * Decode a BATCH parser child process's stdout (P3.8): one envelope with a
 * per-file results array. Per-file entries carry an optional `error` (the
 * file failed inside the batch; the caller falls back to the single-file
 * parser). Never throws — a malformed envelope yields [].
 */
interface BatchFileOutput {
  file: string;
  /** Set when this file failed inside the batch (e.g. syntax error). */
  error?: string | undefined;
  symbols: RawParsedSymbol[];
  refs: Ref[];
}

export function parseParserBatchOutput(stdout: string, lang: SymbolLang): BatchFileOutput[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const results = (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  return results.flatMap((entry): BatchFileOutput[] => {
    // Guard before dereference: a null/primitive entry (`{"results":[null]}`)
    // must be rejected, not thrown on — the decoder's contract is never-throw.
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const candidate = entry as {
      file?: unknown;
      error?: unknown;
      symbols?: unknown;
      refs?: unknown;
    };
    if (typeof candidate.file !== 'string' || !candidate.file) return [];
    return [
      {
        file: candidate.file,
        error: typeof candidate.error === 'string' && candidate.error ? candidate.error : undefined,
        symbols: coerceSymbols(candidate.symbols),
        refs: dedupeRefs(coerceRefs(candidate.refs, lang)),
      },
    ];
  });
}

/**
 * Collapse refs that repeat the same target on the same line. A single Go or
 * Python statement can produce several identical AST nodes (chained calls,
 * grouped imports) and each would otherwise add weight to the same graph edge.
 */
function dedupeRefs(refs: Ref[]): Ref[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.toName}:${ref.callType}:${ref.line}:${ref.module ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
