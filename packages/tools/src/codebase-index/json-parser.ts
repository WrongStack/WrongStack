import { expectDefined } from '@wrongstack/core/utils';
/**
 * JSON file symbol extraction.
 *
 * Extracts top-level keys as "symbols" with kind `property`.
 * Special handling for:
 * - package.json: scripts, dependencies, devDependencies → `const`
 * - tsconfig.json: compilerOptions keys → `property`
 * - JSON Schema / OpenAPI: $schema, $id, $ref → `schema`
 * - Root object itself → kind `object`
 *
 * Uses regex-based extraction for speed and zero dependencies.
 */

import * as path from 'node:path';
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

/**
 * Extract key-value pairs from JSON content using regex.
 * Handles: "key": value, arrays with keyed objects, nested objects (depth ≤ 3).
 */
function regexParse(opts: { file: string; content: string; lang: SymbolLang }): FileSymbols {
  const { file, content, lang } = opts;
  const symbols: IndexSymbol[] = [];
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
    symbols.push(
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

  // Extract top-level keys
  const topLevelKeyRegex = /^\s*"([^"]+)"\s*:/gm;
  for (
    let match = topLevelKeyRegex.exec(content);
    match !== null;
    match = topLevelKeyRegex.exec(content)
  ) {
    const key = expectDefined(match[1]);
    const offset = match.index ?? 0;
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

    symbols.push(
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
      extractPackageScripts(content, symbols, file, lang, lineOffsets, lineFromOffset);
    }

    // For tsconfig.json compilerOptions, extract nested keys
    if (isTsconfig && key === 'compilerOptions') {
      extractCompilerOptions(content, symbols, file, lang, lineOffsets, line, lineFromOffset);
    }
  }

  // Extract JSON Schema $defs or definitions
  const defsRegex = /"\$defs"\s*:|"\$defs"\s*:/g;
  const defsMatch = defsRegex.exec(content);
  if (defsMatch !== null) {
    const offset = expectDefined(defsMatch.index);
    const line = lineFromOffset(offset);
    symbols.push(
      makeSymbol({
        name: '$defs',
        kind: 'property',
        line,
        col: offset - (lineOffsets[line - 1] ?? 0),
        signature: '"$defs": { ... }',
        file,
        lang,
      }),
    );
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
      const offset = match.index ?? 0;
      const line = lineFromOffset(offset);
      const key = match[0]?.match(/"([^"]+)"/)?.[1] ?? expectDefined(match[0]);
      symbols.push(
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
): void {
  // Find the "scripts": { ... } block and extract each script key
  const scriptsBlockRegex = /"scripts"\s*:\s*\{([^}]+)\}/g;
  for (
    let match = scriptsBlockRegex.exec(content);
    match !== null;
    match = scriptsBlockRegex.exec(content)
  ) {
    const blockContent = expectDefined(match[0]);
    const blockOffset = match.index ?? 0;

    // Extract each "key" inside the block (simple approach)
    const scriptKeyRegex = /"(\w[\w-]*)"\s*:/g;
    for (
      let scriptMatch = scriptKeyRegex.exec(blockContent);
      scriptMatch !== null;
      scriptMatch = scriptKeyRegex.exec(blockContent)
    ) {
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
): void {
  // Find the "compilerOptions": { ... } block
  const optsBlockRegex = /"compilerOptions"\s*:\s*\{([^}]+)\}/g;
  for (
    let match = optsBlockRegex.exec(content);
    match !== null;
    match = optsBlockRegex.exec(content)
  ) {
    const blockContent = expectDefined(match[0]);
    const blockOffset = match.index ?? 0;

    // Extract nested key inside compilerOptions (up to depth 1)
    const optKeyRegex = /"(\w[\w]*)"\s*:/g;
    for (
      let optMatch = optKeyRegex.exec(blockContent);
      optMatch !== null;
      optMatch = optKeyRegex.exec(blockContent)
    ) {
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
