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
 * - package.json: scripts, dependencies, devDependencies → `const`; each
 *   script → `function`
 * - tsconfig.json: compilerOptions keys → `property`
 * - JSON Schema / OpenAPI: $schema, $id, $ref → `schema`; every definition
 *   under `$defs` / `definitions` / `schemas` → `schema`
 * - Root object itself → kind `object`
 *
 * Uses a scanner, not a JSON parse: JSONC comments and trailing commas are
 * common in configuration files and must not drop the file from the index.
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
    return scanParse({ file, content, lang, maxSymbols: opts.maxSymbols });
  } catch {
    /* v8 ignore next -- scanParse is pure string work; the catch is a defensive fallback. */
    return { file, lang, symbols: [], mtimeMs: Date.now() };
  }
}

export { detectLang } from './languages.js';

// ─── Scanner ────────────────────────────────────────────────────────────────

/** Index of the next significant character at or after `from` (skips whitespace and JSONC comments). */
function skipTrivia(content: string, from: number): number {
  let i = from;
  while (i < content.length) {
    const ch = content[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '﻿') {
      i++;
      continue;
    }
    if (ch === '/' && content[i + 1] === '/') {
      const newline = content.indexOf('\n', i);
      i = newline === -1 ? content.length : newline + 1;
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2);
      i = end === -1 ? content.length : end + 2;
      continue;
    }
    break;
  }
  return i;
}

interface ObjectKey {
  key: string;
  /** Offset of the key's opening quote, for line/col mapping. */
  offset: number;
  /** Offset of the value's first significant character. */
  valueStart: number;
}

/**
 * Keys of the object whose `{` sits at `open`: strings at depth 1 of THAT
 * object followed by `:`. String-aware (escapes cannot end a string early)
 * and comment-aware, O(object length).
 *
 * Nested blocks used to be read with `"scripts"\s*:\s*\{([^}]+)\}`, which
 * stopped at the first `}` anywhere — a `${VAR}` inside one script value, or
 * `"paths": {…}` inside compilerOptions, silently dropped every key after it.
 */
function objectKeys(content: string, open: number): ObjectKey[] {
  const keys: ObjectKey[] = [];
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < content.length && content[j] !== '"') {
        if (content[j] === '\\') j++;
        j++;
      }
      if (j >= content.length) break;
      if (depth === 1) {
        const colon = skipTrivia(content, j + 1);
        if (content[colon] === ':') {
          keys.push({
            key: content.slice(i + 1, j),
            offset: i,
            valueStart: skipTrivia(content, colon + 1),
          });
        }
      }
      i = j;
      continue;
    }
    if (ch === '/' && (content[i + 1] === '/' || content[i + 1] === '*')) {
      i = skipTrivia(content, i) - 1;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  return keys;
}

/** Containers whose child keys are schema definitions. */
const DEFINITION_CONTAINERS: ReadonlySet<string> = new Set(['$defs', 'definitions', 'schemas']);

/** Container blocks recorded as symbols themselves (OpenAPI `components` holds `schemas`). */
const BLOCK_CONTAINERS: ReadonlySet<string> = new Set([...DEFINITION_CONTAINERS, 'components']);

/** Nesting depth searched for definition containers (OpenAPI puts them at `components.schemas`). */
const DEFINITION_SEARCH_DEPTH = 4;

// ─── Parser ─────────────────────────────────────────────────────────────────

function scanParse(opts: {
  file: string;
  content: string;
  lang: SymbolLang;
  maxSymbols?: number | undefined;
}): FileSymbols {
  const { file, content, lang } = opts;
  const maxSymbols = opts.maxSymbols ?? JSON_MAX_SYMBOLS_DEFAULT;
  const symbols: IndexSymbol[] = [];
  const basename = path.basename(file).toLowerCase();

  const isPackageJson = basename === 'package.json';
  const isTsconfig = basename === 'tsconfig.json' || basename === 'tsconfig.build.json';
  const isJsonSchema =
    content.includes('$schema') ||
    content.includes('$id') ||
    content.includes('$ref') ||
    content.includes('$defs');
  const isOpenApi = content.includes('openapi') || content.includes('swagger');

  const lines = content.split('\n');
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

  const push = (name: string, kind: IndexSymbol['kind'], offset: number, signature: string) => {
    if (symbols.length >= maxSymbols) return;
    const line = lineFromOffset(offset);
    symbols.push(
      makeSymbol({
        name,
        kind,
        line,
        col: offset - (lineOffsets[line - 1] ?? 0),
        signature,
        file,
        lang,
      }),
    );
  };

  // Root object symbol — only when the document IS an object. `^\s*\{` with
  // the multiline flag matched the first `{` at the start of ANY line, so a
  // root array of objects was reported as an object.
  const rootOpen = skipTrivia(content, 0);
  if (content[rootOpen] !== '{') {
    return { file, lang, symbols, mtimeMs: Date.now() };
  }
  const rootLine = lineFromOffset(rootOpen);
  symbols.push(
    makeSymbol({
      name: path.basename(file),
      kind: 'object',
      line: rootLine,
      col: 0,
      signature: `"${path.basename(file)}" = { ... }`,
      file,
      lang,
    }),
  );

  for (const { key, offset, valueStart } of objectKeys(content, rootOpen)) {
    if (symbols.length >= maxSymbols) break;

    let kind: IndexSymbol['kind'] = 'property';
    let signature = `"${key}": ...`;

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
    } else if (isTsconfig && key === 'compilerOptions') {
      signature = `"compilerOptions": { ... }`;
    }

    if ((isJsonSchema || isOpenApi) && (key === '$schema' || key === '$id' || key === '$ref')) {
      kind = 'schema';
      signature = `"${key}": "..."`;
    }

    push(key, kind, offset, signature);

    const objectValue = content[valueStart] === '{';
    // Script names routinely carry `:` (`build:prod`, `test:unit`); the old
    // `\w[\w-]*` key pattern dropped every one of them.
    if (isPackageJson && key === 'scripts' && objectValue) {
      for (const script of objectKeys(content, valueStart)) {
        push(script.key, 'function', script.offset, `"${script.key}": "..."`);
      }
    }
    if (isTsconfig && key === 'compilerOptions' && objectValue) {
      for (const option of objectKeys(content, valueStart)) {
        push(option.key, 'property', option.offset, `"${option.key}": ...`);
      }
    }
  }

  // Schema blocks. Gated on the document looking like a schema: the
  // containers used to be regex-matched in EVERY JSON file, anywhere in the
  // text (inside string values included), and only the container's own name
  // was recorded — never the definitions it holds. Each block occurrence is
  // recorded once (`"key": { ... }`), and every definition in it as `schema`.
  if (isJsonSchema || isOpenApi) {
    const visit = (open: number, depth: number): void => {
      for (const entry of objectKeys(content, open)) {
        if (symbols.length >= maxSymbols) return;
        if (content[entry.valueStart] !== '{') continue;
        if (BLOCK_CONTAINERS.has(entry.key)) {
          push(entry.key, 'property', entry.offset, `"${entry.key}": { ... }`);
        }
        if (DEFINITION_CONTAINERS.has(entry.key)) {
          for (const definition of objectKeys(content, entry.valueStart)) {
            push(definition.key, 'schema', definition.offset, `"${definition.key}": { ... }`);
          }
        }
        if (depth < DEFINITION_SEARCH_DEPTH) visit(entry.valueStart, depth + 1);
      }
    };
    visit(rootOpen, 0);
  }

  return { file, lang, symbols, mtimeMs: Date.now() };
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
