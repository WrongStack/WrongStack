import { expectDefined, truncate } from '@wrongstack/core/utils';
import { parseInfraArtifact } from './infra-parser.js';
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

  // Lines that are the TEXT of a block scalar (`run: |`, `script: >-`), not
  // YAML structure. A GitHub Actions step body or an embedded config file
  // (`config.yaml: |`) was scanned like mapping syntax, so every `word:` or
  // `&`/`*` inside it became a symbol.
  const scalarBody = blockScalarBodyLines(lines);
  const inScalarBody = (offset: number): boolean => scalarBody.has(lineFromOffset(offset) - 1);

  // ── 1. Anchors and aliases ─────────────────────────────────────────────────
  // &anchor_name — the sigil must sit in value position (start of line,
  // whitespace, or after `:`, `[`, `{`, `,`, `-`). Without this, `&word`
  // inside a plain scalar (e.g. a URL query string `?a=1&b=2`) was emitted
  // as a phantom `const` anchor symbol.
  const anchorRegex = /(?:^|(?<=[\s:\-[{,]))&(\w[\w-]*)/gm;
  for (let match = anchorRegex.exec(content); match !== null; match = anchorRegex.exec(content)) {
    const name = expectDefined(match[1]);
    const offset = match.index ?? 0;
    if (inScalarBody(offset)) continue;
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

  // *alias_name — same value-position rule as anchors: a bare `*` inside a
  // scalar (`a*b`, `**bold**`) is not a YAML alias.
  const aliasRegex = /(?:^|(?<=[\s:\-[{,]))\*(\w[\w-]*)/gm;
  for (let match = aliasRegex.exec(content); match !== null; match = aliasRegex.exec(content)) {
    const name = expectDefined(match[1]);
    const offset = match.index ?? 0;
    if (inScalarBody(offset)) continue;
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
  const kvRegex = /^([ \t]*)([^:#\s][^:#\s]*)\s*:/gm;
  for (let match = kvRegex.exec(content); match !== null; match = kvRegex.exec(content)) {
    const indent = match[1]?.length ?? 0;
    const key = unquoteKey(match[2] ?? '');
    /* v8 ignore next -- the capture group always matches ≥1 char, so key is never empty; defensive. */
    if (!key) continue;
    const offset = match.index ?? 0;
    if (inScalarBody(offset)) continue;
    const line = lineFromOffset(offset);
    // The match starts at `^`; the key itself sits after the indent.
    const col = offset + indent - (lineOffsets[line - 1] ?? 0);

    // Skip block scalar indicators (| or > at column 0 with key name before :)
    const lineContent = lines[line - 1] ?? '';
    if (/^[|&>]/.test(lineContent.trim())) continue;
    // Skip YAML document markers
    if (key === '---' || key === '...') continue;
    // Skip keys that are clearly part of a string value (unusual indent)
    if (indent > 12) continue;

    // Slice the value from the END of the `key:` match. Passing match.index
    // (the line start: indent + key) made extractValue return the whole line
    // (`"count: 42"`), so isScalar never fired and the signature doubled
    // the key (`"count: count: 42"`).
    // Block-scalar headers (`key: |`, `key: >`) are owned by section 4;
    // emitting them here too produced two near-identical symbols per header.
    const value = extractValue(content, (match.index ?? 0) + expectDefined(match[0]).length);
    if (BLOCK_SCALAR_VALUE.test(value)) continue;
    const kind: IndexSymbol['kind'] = isScalar(value) ? 'literal' : 'property';
    const signature = `${key}: ${truncate(value, 60)}`;

    symbols.push(makeSymbol({ name: key, kind, line, col, signature, file, lang }));
  }

  // ── 3. List item keys ──────────────────────────────────────────────────────
  // `- key: value` (list item that is a keyed object), at any indentation.
  // Items normally sit indented under a parent key (`items:\n  - num: 42`);
  // anchoring `-` at column 0 silently dropped every indented item, and the
  // section-2 kvRegex cannot catch them either (`-` + space never satisfies
  // `\s*:`), so they produced no symbol at all.
  const listItemRegex = /^([ \t]*)-(\s+)([^:#\s][^:#\s]*)\s*:/gm;
  for (
    let match = listItemRegex.exec(content);
    match !== null;
    match = listItemRegex.exec(content)
  ) {
    const key = unquoteKey(expectDefined(match[3]));
    const offset = match.index ?? 0;
    if (inScalarBody(offset)) continue;
    const line = lineFromOffset(offset);
    // Key column = indent + `-` + the spaces after it.
    const keyStart = offset + (match[1]?.length ?? 0) + 1 + (match[2]?.length ?? 0);
    const col = keyStart - (lineOffsets[line - 1] ?? 0);
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
  // Indentation/chomping indicators (`|-`, `>+`, `|2`) are part of the header.
  const blockScalarRegex = /^([ \t]*)([^:#\s][^:#\s]*)\s*:[ \t]*[|>][-+0-9]*(?=[ \t]|$)/gm;
  for (
    let match = blockScalarRegex.exec(content);
    match !== null;
    match = blockScalarRegex.exec(content)
  ) {
    const key = unquoteKey(expectDefined(match[2]));
    const offset = match.index ?? 0;
    if (inScalarBody(offset)) continue;
    const line = lineFromOffset(offset);
    const col = offset + (match[1]?.length ?? 0) - (lineOffsets[line - 1] ?? 0);
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

  const infra = parseInfraArtifact({ file, content, lang });
  return {
    file,
    lang,
    symbols,
    ...(infra.refs.length > 0 ? { refs: infra.refs } : {}),
    mtimeMs: Date.now(),
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * A block scalar header value: `|` or `>` plus optional chomping/indentation
 * indicators. `^[|>](\s|$)` missed `|-` and `>-` — the most common forms —
 * so those headers were emitted twice and their bodies parsed as YAML.
 */
const BLOCK_SCALAR_VALUE = /^[|>][-+0-9]*(\s|#|$)/;

/** 0-based indices of lines that belong to a block scalar's text. */
function blockScalarBodyLines(lines: readonly string[]): Set<number> {
  const body = new Set<number>();
  const header = /^(\s*)(?:(?:-[ \t]+)?[^#\n]*?:|-)[ \t]*[|>][-+0-9]*[ \t]*(?:#.*)?$/;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').replace(/\r$/, '');
    const match = header.exec(line);
    if (!match) continue;
    const baseIndent = match[1]?.length ?? 0;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const next = (lines[j] ?? '').replace(/\r$/, '');
      if (next.trim() === '') {
        body.add(j);
        continue;
      }
      const indent = next.length - next.trimStart().length;
      if (indent <= baseIndent) break;
      body.add(j);
    }
    i = j - 1;
  }
  return body;
}

/** `"key"` / `'key'` → `key`. */
function unquoteKey(key: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(key);
  return quoted ? (quoted[2] ?? '') : key;
}

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
