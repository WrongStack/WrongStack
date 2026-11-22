/**
 * Go source symbol extraction using `go/parser`.
 *
 * Runs the extraction program from `toolchain-scripts.ts` under `go run`, with
 * the source on stdin, and decodes its JSON. When the toolchain is missing or
 * the run yields nothing, a line-based extractor keeps the file indexed.
 *
 * Extracts: func, method, type, const, var
 */

import { resolveWin32Command } from '@wrongstack/primitives';
import { parseParserOutput, toIndexSymbols } from './parser-output.js';
import type { FileSymbols, Symbol as IndexSymbol, SymbolLang } from './schema.js';
import { withSpawnGate } from './spawn-gate.js';
import {
  GO_PARSE_SCRIPT,
  goSpawnOptions,
  privateScriptPath,
  runToolchainChild,
} from './toolchain-scripts.js';

// ─── Public API ─────────────────────────────────────────────────────────────

export async function parseSymbols(opts: {
  file: string;
  content: string;
  lang: SymbolLang;
}): Promise<FileSymbols> {
  const { file, content, lang } = opts;

  try {
    // Serialize go child processes process-wide (same gate as Python).
    const parsed = await withSpawnGate(() => syncGoParse(file, content, lang));
    if (parsed.symbols.length > 0) {
      return parsed;
    }
    // No symbols means the toolchain is missing or the file failed to parse.
    // Keep any refs the run did produce rather than discarding them with it.
    const fallback = parseGoWithoutToolchain(file, content, lang);
    return parsed.refs?.length ? { ...fallback, refs: parsed.refs } : fallback;
  } catch {
    /* v8 ignore next -- syncGoParse has its own catch; this outer guard is defensive. */
    return parseGoWithoutToolchain(file, content, lang);
  }
}

export { detectLang } from './languages.js';

// ─── Lightweight fallback parser ────────────────────────────────────────────

/** `func Name(`, `func Name[T any](`, `func (r *Recv[T]) Name(` — receiver type in group 1. */
const GO_FUNC_RE =
  /^func\s+(?:\(\s*(?:[A-Za-z_]\w*\s+)?\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*)?([A-Za-z_]\w*)\s*[[(]/;
const GO_NAME_LIST_RE = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/;

/**
 * Blank comment and string/rune literal contents, keeping offsets and newlines.
 * Quote characters survive so the line structure stays readable.
 */
export function maskGoNonCode(src: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/g, ' ');
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const newline = src.indexOf('\n', i);
      const stop = newline === -1 ? n : newline;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      // Go block comments do not nest.
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const raw = c === '`';
      let j = i + 1;
      while (j < n && src[j] !== c && (raw || src[j] !== '\n')) {
        j += !raw && src[j] === '\\' ? 2 : 1;
      }
      if (j < n && src[j] === c) {
        out += c + blank(src.slice(i + 1, j)) + c;
        i = j + 1;
      } else {
        const stop = Math.min(j, n);
        out += c + blank(src.slice(i + 1, stop));
        i = stop;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Line-based extraction for when `go run` is unavailable or failed.
 *
 * Runs over {@link maskGoNonCode} output and only reads declarations at the top
 * level. Previously it scanned every trimmed line of the raw source, so:
 *  - a `(` or `}` inside a string or comment tripped the delimiter check and
 *    the whole file indexed empty (`strings.Split(s, "(")` is enough);
 *  - every `var x` / `type t` local inside a function body became a
 *    package-level symbol;
 *  - generic functions (`func Map[T any](`) were missing, grouped
 *    `const ( … )` / `var ( … )` members were missing, and methods were
 *    scoped `pkg.Name` instead of the native parser's `pkg.Recv.Name`.
 */
export function parseGoWithoutToolchain(
  filePath: string,
  content: string,
  lang: SymbolLang = 'go',
): FileSymbols {
  const code = maskGoNonCode(content);
  if (!/^\s*package\s+[A-Za-z_]\w*/m.test(code) || hasUnbalancedDelimiters(code)) {
    return { file: filePath, lang, symbols: [], mtimeMs: Date.now() };
  }

  const symbols: IndexSymbol[] = [];
  const packageName = code.match(/^\s*package\s+([A-Za-z_]\w*)/m)?.[1] ?? '';
  const qualify = (...parts: string[]): string => [packageName, ...parts].filter(Boolean).join('.');
  const codeLines = code.split('\n');
  const srcLines = content.split('\n');
  let braces = 0;
  let parens = 0;
  let group: 'const' | 'var' | 'type' | null = null;

  for (const [idx, line] of codeLines.entries()) {
    const trimmed = line.trimStart();
    const add = (kind: IndexSymbol['kind'], name: string, scope: string): void => {
      if (name === '_') return;
      addFallbackSymbol(symbols, {
        filePath,
        lang,
        kind,
        name,
        line: idx + 1,
        col: line.length - trimmed.length,
        signature: (srcLines[idx] ?? '').trim(),
        scope,
      });
    };

    if (braces === 0 && parens === 0) {
      group = null;
      const fn = GO_FUNC_RE.exec(trimmed);
      const opener = /^(const|var|type)\s*\(/.exec(trimmed);
      if (fn?.[2]) {
        add(fn[1] ? 'method' : 'function', fn[2], fn[1] ? qualify(fn[1], fn[2]) : qualify(fn[2]));
      } else if (opener?.[1]) {
        group = opener[1] as 'const' | 'var' | 'type';
      } else {
        const typeDecl = /^type\s+([A-Za-z_]\w*)/.exec(trimmed);
        if (typeDecl?.[1]) add('type', typeDecl[1], packageName);
        const valueDecl = /^(const|var)\s+/.exec(trimmed);
        const names = valueDecl ? GO_NAME_LIST_RE.exec(trimmed.slice(valueDecl[0].length)) : null;
        if (valueDecl?.[1] && names?.[1]) {
          for (const name of names[1].split(',')) {
            add(valueDecl[1] as 'const' | 'var', name.trim(), packageName);
          }
        }
      }
    } else if (group && braces === 0 && parens === 1) {
      const names = GO_NAME_LIST_RE.exec(trimmed)?.[1];
      if (names) {
        const members = group === 'type' ? [names.split(',')[0] ?? ''] : names.split(',');
        for (const name of members) add(group, name.trim(), packageName);
      }
    }

    for (const ch of line) {
      if (ch === '{') braces++;
      else if (ch === '}') braces--;
      else if (ch === '(') parens++;
      else if (ch === ')') parens--;
    }
  }

  return { file: filePath, lang, symbols, mtimeMs: Date.now() };
}

function addFallbackSymbol(
  symbols: IndexSymbol[],
  opts: {
    filePath: string;
    lang: SymbolLang;
    kind: IndexSymbol['kind'];
    name: string;
    line: number;
    col: number;
    signature: string;
    scope: string;
  },
): void {
  symbols.push({
    id: 0,
    lang: opts.lang,
    kind: opts.kind,
    name: opts.name,
    file: opts.filePath,
    line: opts.line,
    col: opts.col,
    signature: opts.signature,
    docComment: '',
    scope: opts.scope,
    text: `${opts.name} ${opts.signature}`.trim(),
  });
}

function hasUnbalancedDelimiters(content: string): boolean {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const closers = new Set(Object.values(pairs));
  const stack: string[] = [];
  for (const ch of content) {
    if (pairs[ch]) {
      stack.push(pairs[ch]);
    } else if (closers.has(ch) && stack.pop() !== ch) {
      return true;
    }
  }
  return stack.length > 0;
}

// ─── Native parse via `go run` ───────────────────────────────────────────────

async function syncGoParse(
  filePath: string,
  content: string,
  lang: SymbolLang,
): Promise<FileSymbols> {
  const empty: FileSymbols = { file: filePath, lang, symbols: [], mtimeMs: Date.now() };
  // Feed the source over stdin — never pass the target .go file as a CLI arg.
  // `go run script.go target.go` makes the toolchain treat target.go as a
  // second package file ("named files must all be in one directory") and
  // refuses *_test.go outright.
  try {
    const scriptPath = await privateScriptPath('ws-go-parse-', 'parse.go', GO_PARSE_SCRIPT);
    // argv-array form (no shell); the Go binary is resolved via PATHEXT on Windows.
    const result = await runToolchainChild(
      resolveWin32Command('go'),
      ['run', scriptPath],
      content,
      15_000,
      goSpawnOptions(scriptPath),
    );
    if (result?.code !== 0 || !result.stdout.trim()) return empty;

    const { symbols, refs } = parseParserOutput(result.stdout, lang);
    return {
      file: filePath,
      lang,
      symbols: toIndexSymbols(symbols, filePath, lang),
      refs,
      mtimeMs: Date.now(),
    };
  } catch {
    return empty;
  }
}
