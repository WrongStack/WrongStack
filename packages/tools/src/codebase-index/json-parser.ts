import { expectDefined } from '@wrongstack/core/utils';
/**
 * JSON file symbol extraction.
 *
 * Extracts the ROOT object's keys as "symbols" with kind `property` (P3:
 * depth-1 only — keys nested in child objects or arrays are deliberately not
 * extracted; the previous line-anchored regex matched every pretty-printed
 * key line at any depth, which let a single i18n or report file produce
 * thousands of noise symbols). Extraction is string-aware and capped.
 * Special handling for:
 * - package.json: scripts, dependencies, devDependencies → `const`
 * - tsconfig.json: compilerOptions keys → `property`
 * - JSON Schema / OpenAPI: $schema, $id, $ref → `schema`
 * - Root object itself → kind `object`
 *
 * Uses regex/scanner-based extraction for speed and zero dependencies.
 */

import * as path from 'node:path';
import type { FileSymbols, Symbol as IndexSymbol, SymbolLang } from './schema.js';
// ─── Public API ─────────────────────────────────────────────────────────────

/** Soft cap per file (mirrors the 500 caps in generic-parser / tree-sitter,
 * raised because top-level-only extraction yields far fewer candidates). */
export const JSON_MAX_SYMBOLS_DEFAULT = 1_000;

export function parseSymbols(opts: {
  file: string;
  content: string;
  lang: SymbolLang;
  maxSymbols?: number | undefined;
}): FileSymbols {
  const { file, content, lang } = opts;

  try {
    return regexParse({ file, content, lang, maxSymbols: opts.maxSymbols });
  } catch {
    /* v8 ignore next -- regexParse is pure regex/string work; the catch is a defensive fallback. */
    return { file, lang, symbols: [], mtimeMs: Date.now() };
  }
}

export { detectLang } from './languages.js';

// ─── Scanner ────────────────────────────────────────────────────────────────

interface TopLevelKey {
  key: string;
  /** Offset of the opening quote, for line/col mapping. */
  offset: number;
}

/**
 * Single-pass scan for the ROOT object's keys: strings seen while the
 * container stack is exactly `[{` that are followed (after whitespace) by `:`.
 * String-aware (handles `\"` escapes, so a quote inside a key or value cannot
 * desynchronize the scan), O(n), zero dependencies. Keys nested in child
 * objects/arrays are deliberately not emitted (P3).
 */
function topLevelKeys(content: string): TopLevelKey[] {
  const keys: TopLevelKey[] = [];
  const stack: string[] = [];
  let inString = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (ch === '\\') {
        i++; // skip the escaped character
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '/' && content[i + 1] === '/') {
      // JSONC line comment (.jsonc routes here): skip to end of line.
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      // JSONC block comment: skip past the closing */ (or EOF).
      i += 2;
      while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i++; // past '*'; the loop's i++ moves past '/'
      continue;
    }
    if (ch === '"') {
      inString = true;
      if (stack.length === 1 && stack[0] === '{') {
        // Consume the key string manually so escapes cannot end it early.
        let j = i + 1;
        while (j < content.length && content[j] !== '"') {
          if (content[j] === '\\') j++;
          j++;
        }
        if (j < content.length) {
          const key = content.slice(i + 1, j);
          let k = j + 1;
          while (k < content.length && /\s/.test(content[k] ?? '')) k++;
          if (content[k] === ':') keys.push({ key, offset: i });
          i = j; // the loop's i++ resumes after the closing quote
          inString = false;
        }
        // j >= length: unterminated key at EOF — the loop exits naturally.
      }
      continue;
    }
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  return keys;
}

// ─── Regex parser ───────────────────────────────────────────────────────────

/**
 * Extract the root object's keys from JSON content. Nested keys are covered
 * only by the explicit special cases below (package.json scripts, tsconfig
 * compilerOptions, JSON Schema / OpenAPI definition blocks).
 */
function regexParse(opts: {
  file: string;
  content: string;
  lang: SymbolLang;
  maxSymbols?: number | undefined;
}): FileSymbols {
  const { file, content, lang } = opts;
  const maxSymbols = opts.maxSymbols ?? JSON_MAX_SYMBOLS_DEFAULT;
  const symbols: IndexSymbol[] = [];
  const pushSymbol = (symbol: IndexSymbol): void => {
    if (symbols.length < maxSymbols) symbols.push(symbol);
  };
  const basename = path.basename(file).toLowerCase();

  const isPackageJson = basename === 'package.json';
  const isTsconfig = basename === 'tsconfig.json' || basename === 'tsconfig.build.json';
  const isJsonSchema =
    content.includes('$schema') || content.includes('$id') || content.includes('$ref');
  const isOpenApi = content.includes('openapi') || content.includes('swagger');

  const lines = content.split('\n');

  // Build line offset map
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

  // Root object symbol
  const rootMatch = content.match(/^\s*\{/m);
  if (rootMatch) {
    const offset = expectDefined(rootMatch.index);
    const line = lineFromOffset(offset);
    pushSymbol(
      makeSymbol({
        name: path.basename(file),
        kind: 'object',
        line,
        col: 0,
        signature: `"${path.basename(file)}" = { ... }`,
        file,
        lang,
      }),
    );
  }

  // Extract root-object keys
  for (const { key, offset } of topLevelKeys(content)) {
    if (symbols.length >= maxSymbols) break;
    const line = lineFromOffset(offset);
    const col = offset - (lineOffsets[line - 1] ?? 0);

    let kind: IndexSymbol['kind'] = 'property';
    let signature = `"${key}": ..."`;

    // Special casing for known file types
    if (isPackageJson) {
      if (
        key === 'scripts' ||
        key === 'dependencies' ||
        key === 'devDependencies' ||
        key === 'peerDependencies' ||
        key === 'optionalDependencies'
      ) {
        kind = 'const';
        signature = `"${key}": { ... }`;
      }
    } else if (isTsconfig) {
      if (key === 'compilerOptions') {
        kind = 'property';
        signature = `"compilerOptions": { ... }`;
      }
    }

    // JSON Schema / OpenAPI special keys
    if (isJsonSchema || isOpenApi) {
      if (key === '$schema' || key === '$id') {
        kind = 'schema';
        signature = `"${key}": "..."`;
      } else if (key === '$ref') {
        kind = 'schema';
        signature = `"$ref": "..."`;
      }
    }

    pushSymbol(
      makeSymbol({
        name: key,
        kind,
        line,
        col,
        signature,
        file,
        lang,
      }),
    );

    // For package.json, also extract individual scripts as 'function'
    if (isPackageJson && key === 'scripts') {
      extractPackageScripts(content, symbols, file, lang, lineOffsets, lineFromOffset, maxSymbols);
    }

    // For tsconfig.json compilerOptions, extract nested keys
    if (isTsconfig && key === 'compilerOptions') {
      extractCompilerOptions(
        content,
        symbols,
        file,
        lang,
        lineOffsets,
        line,
        lineFromOffset,
        maxSymbols,
      );
    }
  }

  // Extract definitions (OpenAPI components, JSON Schema definitions)
  const defsPatterns = [
    /"\$defs"\s*:/g,
    /"definitions"\s*:/g,
    /"components"\s*:/g,
    /"schemas"\s*:/g,
  ];
  for (const pat of defsPatterns) {
    pat.lastIndex = 0;
    for (let match = pat.exec(content); match !== null; match = pat.exec(content)) {
      if (symbols.length >= maxSymbols) break;
      const offset = match.index ?? 0;
      const line = lineFromOffset(offset);
      const key = match[0]?.match(/"([^"]+)"/)?.[1] ?? expectDefined(match[0]);
      pushSymbol(
        makeSymbol({
          name: key,
          kind: 'property',
          line,
          col: offset - (lineOffsets[line - 1] ?? 0),
          signature: `"${key}": { ... }`,
          file,
          lang,
        }),
      );
    }
  }

  return { file, lang, symbols, mtimeMs: Date.now() };
}

function extractPackageScripts(
  content: string,
  symbols: IndexSymbol[],
  file: string,
  lang: SymbolLang,
  lineOffsets: number[],
  lineFromOffset: (offset: number) => number,
  maxSymbols: number,
): void {
  // Find the "scripts": { ... } block and extract each script key
  const scriptsBlockRegex = /"scripts"\s*:\s*\{([^}]+)\}/g;
  for (
    let match = scriptsBlockRegex.exec(content);
    match !== null;
    match = scriptsBlockRegex.exec(content)
  ) {
    if (symbols.length >= maxSymbols) return;
    const blockContent = expectDefined(match[0]);
    const blockOffset = match.index ?? 0;

    // Extract each "key" inside the block (simple approach)
    const scriptKeyRegex = /"(\w[\w-]*)"\s*:/g;
    for (
      let scriptMatch = scriptKeyRegex.exec(blockContent);
      scriptMatch !== null;
      scriptMatch = scriptKeyRegex.exec(blockContent)
    ) {
      if (symbols.length >= maxSymbols) return;
      const key = expectDefined(scriptMatch[1]);
      const keyOffset = blockOffset + expectDefined(scriptMatch.index);
      const line = lineFromOffset(keyOffset);
      symbols.push(
        makeSymbol({
          name: key,
          kind: 'function',
          line,
          col: keyOffset - (lineOffsets[line - 1] ?? 0),
          signature: `"${key}": "..."`,
          file,
          lang,
        }),
      );
    }
  }
}

function extractCompilerOptions(
  content: string,
  symbols: IndexSymbol[],
  file: string,
  lang: SymbolLang,
  lineOffsets: number[],
  parentLine: number,
  lineFromOffset: (offset: number) => number,
  maxSymbols: number,
): void {
  // Find the "compilerOptions": { ... } block
  const optsBlockRegex = /"compilerOptions"\s*:\s*\{([^}]+)\}/g;
  for (
    let match = optsBlockRegex.exec(content);
    match !== null;
    match = optsBlockRegex.exec(content)
  ) {
    if (symbols.length >= maxSymbols) return;
    const blockContent = expectDefined(match[0]);
    const blockOffset = match.index ?? 0;

    // Extract nested key inside compilerOptions (up to depth 1)
    const optKeyRegex = /"(\w[\w]*)"\s*:/g;
    for (
      let optMatch = optKeyRegex.exec(blockContent);
      optMatch !== null;
      optMatch = optKeyRegex.exec(blockContent)
    ) {
      if (symbols.length >= maxSymbols) return;
      const key = expectDefined(optMatch[1]);
      const keyOffset = blockOffset + expectDefined(optMatch.index);
      const line = lineFromOffset(keyOffset);
      if (line <= parentLine) continue; // Skip top-level (already captured)
      symbols.push(
        makeSymbol({
          name: key,
          kind: 'property',
          line,
          col: keyOffset - (lineOffsets[line - 1] ?? 0),
          signature: `"${key}": ...`,
          file,
          lang,
        }),
      );
    }
  }
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
