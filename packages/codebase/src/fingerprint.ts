/**
 * Structural fingerprinting for indexed files.
 *
 * Separates byte-level edits (`files.content_hash`) from structural/contract
 * edits (`signature_hash`) so cosmetic edits (comments, formatting, log text,
 * whitespace) do not invalidate expensive LLM-generated `file_concepts`
 * summaries or trigger unnecessary downstream re-summarisation.
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { posixIndexPath } from './writer-helpers.js';

type Statement = ReturnType<DatabaseSync['prepare']>;
type PrepareStatement = (sql: string) => Statement;

export type StructuralChangeKind = 'NONE' | 'COSMETIC' | 'STRUCTURAL';

export type IncrementalUpdateStrategy =
  | 'SKIP_COSMETIC'
  | 'PARTIAL_UPDATE'
  | 'ARCHITECTURE_UPDATE'
  | 'FULL_UPDATE';

/**
 * Classify the incremental enrichment strategy from the number of structurally
 * modified files:
 * - `0` structural files -> `'SKIP_COSMETIC'`
 * - `1..10` structural files -> `'PARTIAL_UPDATE'`
 * - `11..30` structural files -> `'ARCHITECTURE_UPDATE'`
 * - `>30` structural files -> `'FULL_UPDATE'`
 */
export function classifyIncrementalUpdateStrategy(
  structuralChangedCount: number,
): IncrementalUpdateStrategy {
  if (structuralChangedCount <= 0) return 'SKIP_COSMETIC';
  if (structuralChangedCount <= 10) return 'PARTIAL_UPDATE';
  if (structuralChangedCount <= 30) return 'ARCHITECTURE_UPDATE';
  return 'FULL_UPDATE';
}

export interface StructuralSymbolInput {
  name: string;
  kind: string;
  scope?: string | undefined;
  signature?: string | undefined;
  line?: number | undefined;
  endLine?: number | undefined;
  isExported?: boolean | undefined;
}

export interface StructuralRefInput {
  callType: string;
  toName: string;
  module?: string | null | undefined;
}

function normalizeSignature(sig: string | undefined): string {
  if (!sig) return '';
  return sig.replace(/\s+/g, ' ').trim();
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compute a deterministic SHA-256 structural fingerprint from a file's
 * declarations and outgoing references.
 *
 * Returns `''` when both `symbols` and `refs` are empty so symbol-less files
 * fall back to byte-hash comparison rather than looking permanently unchanged.
 */
export function computeStructuralFingerprint(
  symbols: readonly StructuralSymbolInput[],
  refs: readonly StructuralRefInput[] = [],
): string {
  if (symbols.length === 0 && refs.length === 0) return '';

  const canonicalSymbols = symbols
    .map(
      (s) =>
        `${s.kind}\u0000${s.scope ?? ''}\u0000${s.name}\u0000${normalizeSignature(s.signature)}`,
    )
    .sort(compareText);

  const canonicalRefs = refs
    .map((r) => `${r.callType}\u0000${r.toName}\u0000${r.module ?? ''}`)
    .sort(compareText);

  const hash = createHash('sha256');
  hash.update('symbols:\n');
  for (const line of canonicalSymbols) {
    hash.update(line);
    hash.update('\n');
  }
  hash.update('refs:\n');
  for (const line of canonicalRefs) {
    hash.update(line);
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Compute a file's structural fingerprint directly from SQLite statements.
 */
export function computeFileStructuralFingerprintWithStatement(
  stmt: PrepareStatement,
  file: string,
): string {
  const queryFor = (target: string) => {
    const symbols = stmt(
      `SELECT name, kind, scope, signature
       FROM symbols
       WHERE file = ?`,
    ).all(target) as Array<{
      name: string;
      kind: string;
      scope: string;
      signature: string;
    }>;

    const refs = stmt(
      `SELECT r.call_type AS callType, r.to_name AS toName, COALESCE(r.module, '') AS module
       FROM refs r
       JOIN symbols s ON s.id = r.from_id
       WHERE s.file = ?`,
    ).all(target) as Array<{
      callType: string;
      toName: string;
      module: string;
    }>;
    return { symbols, refs };
  };

  let { symbols, refs } = queryFor(file);
  if (symbols.length === 0 && refs.length === 0) {
    const posix = posixIndexPath(file);
    if (posix !== file) {
      ({ symbols, refs } = queryFor(posix));
    }
  }

  return computeStructuralFingerprint(symbols, refs);
}

/**
 * Compute a file's structural fingerprint from an index store. Typed by the
 * one method it reads: importing `IndexStore` from writer.ts closed a module
 * cycle (writer → writer-store-derived → fingerprint → writer).
 */
export function computeFileStructuralFingerprint(
  store: { getFileStructuralFingerprint(file: string): string },
  file: string,
): string {
  return store.getFileStructuralFingerprint(file);
}

/**
 * Detect whether any symbol's line-span length changed by more than 50%
 * (`|newSpan - oldSpan| / max(1, oldSpan) > 0.5`), indicating a substantive
 * body rewrite even when its signature header remained identical.
 */
export function classifySymbolBodyDrift(
  prevSymbols: readonly StructuralSymbolInput[],
  nextSymbols: readonly StructuralSymbolInput[],
): { hasMajorDrift: boolean; driftedSymbols: string[] } {
  const prevSpanByKey = new Map<string, number>();
  for (const sym of prevSymbols) {
    if (
      typeof sym.line === 'number' &&
      typeof sym.endLine === 'number' &&
      sym.endLine >= sym.line
    ) {
      const span = Math.max(1, sym.endLine - sym.line + 1);
      prevSpanByKey.set(`${sym.kind}\u0000${sym.scope ?? ''}\u0000${sym.name}`, span);
    }
  }

  const driftedSymbols: string[] = [];
  for (const sym of nextSymbols) {
    if (typeof sym.line !== 'number' || typeof sym.endLine !== 'number' || sym.endLine < sym.line) {
      continue;
    }
    const key = `${sym.kind}\u0000${sym.scope ?? ''}\u0000${sym.name}`;
    const prevSpan = prevSpanByKey.get(key);
    if (prevSpan === undefined || prevSpan < 4) continue;
    const nextSpan = Math.max(1, sym.endLine - sym.line + 1);
    const ratio = Math.abs(nextSpan - prevSpan) / Math.max(1, prevSpan);
    if (ratio > 0.5) {
      driftedSymbols.push(sym.scope ? `${sym.scope}.${sym.name}` : sym.name);
    }
  }

  return {
    hasMajorDrift: driftedSymbols.length > 0,
    driftedSymbols,
  };
}

/**
 * Classify how a file changed between two index snapshots:
 * - `'NONE'`: identical `contentHash`
 * - `'COSMETIC'`: `contentHash` changed, but non-empty `signatureHash` is unchanged
 *   (and no symbol body span drifted by >50% when symbol lists are provided)
 * - `'STRUCTURAL'`: `signatureHash` changed (or was not recorded, or body span drifted >50%)
 */
export function classifyFileChange(
  prev: { contentHash: string; signatureHash?: string | undefined },
  next: { contentHash: string; signatureHash: string },
  symbolSpans?: {
    prevSymbols: readonly StructuralSymbolInput[];
    nextSymbols: readonly StructuralSymbolInput[];
  },
): StructuralChangeKind {
  if (prev.contentHash !== '' && prev.contentHash === next.contentHash) {
    return 'NONE';
  }
  if (
    prev.signatureHash !== undefined &&
    prev.signatureHash !== '' &&
    next.signatureHash !== '' &&
    prev.signatureHash === next.signatureHash
  ) {
    if (
      symbolSpans &&
      classifySymbolBodyDrift(symbolSpans.prevSymbols, symbolSpans.nextSymbols).hasMajorDrift
    ) {
      return 'STRUCTURAL';
    }
    return 'COSMETIC';
  }
  return 'STRUCTURAL';
}

// ─── Incremental Symbol Loss & Dynamic Injection Gate ────────────────────────

const DYNAMIC_INJECTION_PATTERNS: readonly RegExp[] = [
  /\bObject\.definePropert(?:y|ies)\s*\(/,
  /\bReflect\.defineProperty\s*\(/,
  /\bnew\s+Proxy\s*\(/,
  /\bsetattr\s*\(/,
  /\b__getattr__\b/,
  /\bdefine_method\b/,
];

/**
 * Detect whether a source file uses runtime dynamic property/method injection
 * (`Object.defineProperty`, `Reflect.defineProperty`, `new Proxy`, Python
 * `setattr`/`__getattr__`, Ruby `define_method`) where static AST symbol
 * inventories may be incomplete.
 */
export function hasDynamicSymbolInjection(source: string): boolean {
  if (!source) return false;
  return DYNAMIC_INJECTION_PATTERNS.some((re) => re.test(source));
}

export interface SymbolLossValidationResult {
  status: 'ok' | 'symbol-loss-detected' | 'dynamic-injection-uncertain';
  missingSymbols: string[];
  addedSymbols: string[];
  hasDynamicInjection: boolean;
}

/**
 * Compare previous and updated symbol inventories for a file to detect
 * unintended symbol loss or uncertain dynamic runtime symbol injection.
 */
export function validateIncrementalSymbolLoss(
  prevSymbols: readonly StructuralSymbolInput[],
  nextSymbols: readonly StructuralSymbolInput[],
  nextSource?: string | undefined,
): SymbolLossValidationResult {
  const nextNames = new Set(nextSymbols.map((s) => `${s.kind}:${s.scope ?? ''}:${s.name}`));
  const prevNames = new Set(prevSymbols.map((s) => `${s.kind}:${s.scope ?? ''}:${s.name}`));

  const missingSymbols: string[] = [];
  for (const s of prevSymbols) {
    const key = `${s.kind}:${s.scope ?? ''}:${s.name}`;
    if (!nextNames.has(key)) {
      missingSymbols.push(s.scope ? `${s.scope}.${s.name}` : s.name);
    }
  }

  const addedSymbols: string[] = [];
  for (const s of nextSymbols) {
    const key = `${s.kind}:${s.scope ?? ''}:${s.name}`;
    if (!prevNames.has(key)) {
      addedSymbols.push(s.scope ? `${s.scope}.${s.name}` : s.name);
    }
  }

  const dynamic = nextSource ? hasDynamicSymbolInjection(nextSource) : false;
  if (missingSymbols.length === 0) {
    return {
      status: 'ok',
      missingSymbols: [],
      addedSymbols,
      hasDynamicInjection: dynamic,
    };
  }

  return {
    status: dynamic ? 'dynamic-injection-uncertain' : 'symbol-loss-detected',
    missingSymbols,
    addedSymbols,
    hasDynamicInjection: dynamic,
  };
}
