import { expectDefined, truncate } from '@wrongstack/core/utils';
import type { FileSymbols, Symbol as IndexSymbol, SymbolLang } from './schema.js';
// ─── Public API ─────────────────────────────────────────────────────────────

export function parseSymbols(opts: {
  file: string;
  content: string;
  lang: SymbolLang;
}): FileSymbols {
  const { file, content, lang } = opts;

  try {
    return regexParse({ file, content, lang });
  } catch {
    /* v8 ignore next -- regexParse is pure regex/string work; the catch is a defensive fallback. */
    return { file, lang, symbols: [], mtimeMs: Date.now() };
  }
}

export { detectLang } from './languages.js';

// ─── Regex parser ───────────────────────────────────────────────────────────

function regexParse(opts: { file: string; content: string; lang: SymbolLang }): FileSymbols {
  const { file, content, lang } = opts;
  const symbols: IndexSymbol[] = [];

  const lines = content.split('\n');

  // Build line offset map for accurate line/col
  const lineOffsets: number[] = [0];
  for (let i = 0; i < lines.length; i++) {
    lineOffsets.push((lineOffsets[i] ?? 0) + (lines[i]?.length ?? 0) + 1);
  }

  function lineFromOffset(offset: number): number {
    let lo = 0;
    let hi = lineOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (expectDefined(lineOffsets[mid]) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  // ── 1. Anchors and aliases ─────────────────────────────────────────────────
  // &anchor_name
  const anchorRegex = /&(\w[\w-]*)/g;
  for (let match = anchorRegex.exec(content); match !== null; match = anchorRegex.exec(content)) {
    const name = expectDefined(match[1]);
    const offset = match.index ?? 0;
    const line = lineFromOffset(offset);
    const col = offset - (lineOffsets[line - 1] ?? 0);
    symbols.push(
      makeSymbol({
        name,
        kind: 'const',
        line,
        col,
        signature: `&${name}`,
        file,
        lang,
      }),
    );
  }

  // *alias_name
  const aliasRegex = /\*(\w[\w-]*)/g;
  for (let match = aliasRegex.exec(content); match !== null; match = aliasRegex.exec(content)) {
    const name = expectDefined(match[1]);
    const offset = match.index ?? 0;
    const line = lineFromOffset(offset);
    const col = offset - (lineOffsets[line - 1] ?? 0);
    symbols.push(
      makeSymbol({
        name,
        kind: 'const',
        line,
        col,
        signature: `*${name}`,
        file,
        lang,
      }),
    );
  }

  // ── 2. Top-level and nested key: value pairs ───────────────────────────────
  // Matches `key: value` (but not block scalars or document markers)
  // Uses negative lookbehind and context to avoid false positives
  const kvRegex = /^(\s*)([^:#\s][^:#\s]*)\s*:/gm;
  for (let match = kvRegex.exec(content); match !== null; match = kvRegex.exec(content)) {
    const indent = match[1]?.length ?? 0;
    const key = match[2];
    /* v8 ignore next -- the capture group always matches ≥1 char, so key is never empty; defensive. */
    if (!key) continue;
    const offset = match.index ?? 0;
    const line = lineFromOffset(offset);
    const col = offset - (lineOffsets[line - 1] ?? 0);

    // Skip block scalar indicators (| or > at column 0 with key name before :)
    const lineContent = lines[line - 1] ?? '';
    if (/^[|&>]/.test(lineContent.trim())) continue;
    // Skip YAML document markers
    if (key === '---' || key === '...') continue;
    // Skip keys that are clearly part of a string value (unusual indent)
    if (indent > 12) continue;

    const value = extractValue(content, match.index ?? 0);
    const kind: IndexSymbol['kind'] = isScalar(value) ? 'literal' : 'property';
    const signature = `${key}: ${truncate(value, 60)}`;

    symbols.push(makeSymbol({ name: key, kind, line, col, signature, file, lang }));
  }

  // ── 3. List item keys ──────────────────────────────────────────────────────
  // `- key: value` (list item that is a keyed object)
  const listItemRegex = /^-(\s+)([^:#\s][^:#\s]*)\s*:/gm;
  for (
    let match = listItemRegex.exec(content);
    match !== null;
    match = listItemRegex.exec(content)
  ) {
    const key = expectDefined(match[2]);
    const offset = match.index ?? 0;
    const line = lineFromOffset(offset);
    const col = offset - (lineOffsets[line - 1] ?? 0);
    const value = extractValue(content, offset + match[0]?.length);
    const kind: IndexSymbol['kind'] = isScalar(value) ? 'literal' : 'property';
    symbols.push(
      makeSymbol({
        name: key,
        kind,
        line,
        col,
        signature: `- ${key}: ${truncate(value, 60)}`,
        file,
        lang,
      }),
    );
  }

  // ── 4. Block scalar keys (key: | or key: >) ────────────────────────────────
  const blockScalarRegex = /^(\s*)([^:#\s][^:#\s]*)\s*:\s*[|>](\s|$)/gm;
  for (
    let match = blockScalarRegex.exec(content);
    match !== null;
    match = blockScalarRegex.exec(content)
  ) {
    const key = expectDefined(match[2]);
    const offset = match.index ?? 0;
    const line = lineFromOffset(offset);
    const col = offset - (lineOffsets[line - 1] ?? 0);
    symbols.push(
      makeSymbol({
        name: key,
        kind: 'property',
        line,
        col,
        signature: `${key}: | ...`,
        file,
        lang,
      }),
    );
  }

  return { file, lang, symbols, mtimeMs: Date.now() };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractValue(content: string, afterColonOffset: number): string {
  // Get the rest of the line after the colon
  const lineEnd = content.indexOf('\n', afterColonOffset);
  const rest = content.slice(afterColonOffset, lineEnd < 0 ? undefined : lineEnd);
  return rest.trim();
}

function isScalar(value: string): boolean {
  if (!value) return false;
  // Numbers, booleans, null, quoted strings
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) return true;
  if (/^(true|false|null|undefined)$/i.test(value)) return true;
  if (/^'[^']*'$/.test(value) || /^"[^"]*"$/.test(value)) return true;
  return false;
}

function makeSymbol(opts: {
  name: string;
  kind: IndexSymbol['kind'];
  line: number;
  col: number;
  signature: string;
  file: string;
  lang: SymbolLang;
}): IndexSymbol {
  return {
    id: 0,
    lang: opts.lang,
    kind: opts.kind,
    name: opts.name,
    file: opts.file,
    line: opts.line,
    col: opts.col,
    signature: opts.signature,
    docComment: '',
    scope: '',
    text: `${opts.name} ${opts.signature}`.trim(),
  };
}
