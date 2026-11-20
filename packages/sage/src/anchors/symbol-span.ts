/**
 * Symbol-span baselines for `symbol` anchors (#418).
 *
 * A symbol anchor's file can change for reasons that have nothing to do with the memory, so a
 * whole-file hash would mark every memory on that file stale after any edit. Instead a symbol
 * anchor records a hash of the symbol's own span when the memory is written, and verification
 * compares that span again. The span comes from a {@link SymbolSpanReader} the host provides
 * (the codebase index in production); without one, nothing here changes behavior.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { MemoryAnchor } from '../memory-model.js';

/** A symbol's source span; `text` is the declaration as written (1-based inclusive lines). */
export interface SymbolSpan {
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * Finds one symbol's span in a file. Returns null when the language is unsupported, the
 * symbol is missing, or the name is ambiguous: callers never guess which match was meant.
 */
export type SymbolSpanReader = (
  absPath: string,
  symbol: string,
  signal?: AbortSignal,
) => Promise<SymbolSpan | null>;

/**
 * Versioned so a later change to how spans are cut or normalized can retire old baselines
 * without reading every one of them as a change: an unknown version falls back to the name
 * check, never to stale.
 */
const SPAN_HASH_PREFIX = 'span:v1:sha256:';

/** A baseline this build can compare. */
export function isCurrentSpanHash(hash: string | undefined): boolean {
  return hash?.startsWith(SPAN_HASH_PREFIX) === true;
}

/**
 * The hash of a span's code. Line endings, trailing whitespace and blank lines around the
 * span do not count, so reformatting the file around it is not a change to the symbol.
 */
export function spanHash(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''));
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return `${SPAN_HASH_PREFIX}${createHash('sha256').update(lines.join('\n')).digest('hex')}`;
}

/** A reader call that never throws: any failure reads as "no span". */
export async function readSpan(
  reader: SymbolSpanReader,
  absPath: string,
  symbol: string,
  signal?: AbortSignal,
): Promise<SymbolSpan | null> {
  try {
    const span = await reader(absPath, symbol, signal);
    return span && typeof span.text === 'string' ? span : null;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

/** Identity of a symbol anchor, independent of the baseline it carries. */
export function symbolAnchorKey(anchor: MemoryAnchor): string | undefined {
  return anchor.type === 'symbol' && anchor.path && anchor.symbol
    ? `${anchor.path}#${anchor.symbol}`
    : undefined;
}

export type SpanBaseline = Pick<MemoryAnchor, 'spanHash' | 'lineStart' | 'lineEnd'>;

/**
 * Baselines for the symbol anchors among `anchors` (normalized, project-relative paths),
 * keyed by {@link symbolAnchorKey}. Anchors whose span cannot be read get none.
 */
export async function readSpanBaselines(
  projectRoot: string,
  anchors: readonly MemoryAnchor[],
  reader: SymbolSpanReader | undefined,
): Promise<ReadonlyMap<string, SpanBaseline>> {
  const baselines = new Map<string, SpanBaseline>();
  if (!reader) return baselines;
  for (const anchor of anchors) {
    const key = symbolAnchorKey(anchor);
    if (!key || baselines.has(key)) continue;
    const span = await readSpan(reader, path.resolve(projectRoot, anchor.path!), anchor.symbol!);
    if (!span) continue;
    baselines.set(key, {
      spanHash: spanHash(span.text),
      lineStart: span.startLine,
      lineEnd: span.endLine,
    });
  }
  return baselines;
}

/**
 * `anchors` with each symbol anchor's baseline replaced by the one read now. A symbol anchor
 * with no readable span keeps what it had.
 */
export function applySpanBaselines(
  anchors: readonly MemoryAnchor[],
  baselines: ReadonlyMap<string, SpanBaseline>,
): MemoryAnchor[] {
  return anchors.map((anchor) => {
    const key = symbolAnchorKey(anchor);
    const baseline = key ? baselines.get(key) : undefined;
    return baseline ? { ...anchor, ...baseline } : anchor;
  });
}
