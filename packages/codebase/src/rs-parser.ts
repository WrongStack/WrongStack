import { expectDefined } from '@wrongstack/core/utils';
/**
 * Rust source symbol extraction.
 *
 * Extracts fn, struct, enum, trait, impl, type, const, static and mod with
 * line-anchored regexes. Dependency edges do not come from here — `use` and
 * `mod` declarations are read by `import-extractor.ts` and resolved against the
 * crate's `Cargo.toml` by `module-resolver.ts`.
 *
 * ### Why there is no native `syn` parser
 *
 * There used to be a path that shelled out to a cargo subproject for real AST
 * parsing. It resolved that subproject relative to `process.cwd()` — the
 * *indexed project*, not the wstack installation — and the crate has never
 * existed in this repository. So the branch was unreachable except in the one
 * case where it must never fire: an indexed repository that happens to contain
 * `tools/Cargo.toml`, where indexing would have run `cargo run` inside the
 * user's checkout and written to `tools/syn-parser/src/input.rs`.
 *
 * Indexing reads a repository; it does not execute its build or write to its
 * working tree. Reinstating native parsing means shipping the crate inside the
 * wstack installation and resolving it from there — never from the scan target.
 */

import type { FileSymbols, Symbol as IndexSymbol, SymbolLang } from './schema.js';

// ─── Public API ─────────────────────────────────────────────────────────────

export async function parseSymbols(opts: {
  file: string;
  content: string;
  lang: SymbolLang;
}): Promise<FileSymbols> {
  const { file, content, lang } = opts;
  return regexParse({ file, content, lang });
}

export { detectLang } from './languages.js';

// ─── Regex fallback parser ───────────────────────────────────────────────────

interface RustPattern {
  regex: RegExp;
  kind: IndexSymbol['kind'];
}

/**
 * Declaration patterns, run over {@link maskRustNonCode} output so a keyword in
 * a comment or string never produces a symbol. Previously:
 *  - `fn\s+(\w+)\s*\(` required `(` right after the name, so every generic
 *    function (`fn parse<T>(…)`) was missing from the index;
 *  - `static\s+(\w+)` matched the lifetime in `&'static str`, indexing a
 *    `static` named `str` for nearly every string-typed signature;
 *  - `const\s+(\w+)` indexed `const fn new()` as a const named `fn`;
 *  - `impl` in return position (`-> impl Iterator`) became an impl symbol.
 */
// `d` (match indices) locates the captured name exactly, whatever precedes or
// follows it in the match.
const RS_PATTERNS: RustPattern[] = [
  { regex: /\bfn\s+(\w+)\s*[<(]/dg, kind: 'function' },
  { regex: /\bstruct\s+(\w+)/dg, kind: 'struct' },
  { regex: /\benum\s+(\w+)/dg, kind: 'enum' },
  { regex: /\btrait\s+(\w+)/dg, kind: 'trait' },
  {
    // Item position only (line start, optional `unsafe`); generic parameter
    // lists may nest one level (`impl<T: Into<String>> Foo`).
    regex:
      /^[ \t]*(?:unsafe\s+)?impl\b\s*(?:<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>)?\s*(?:[\w]+::)*(\w+)/dgm,
    kind: 'impl',
  },
  { regex: /\btype\s+(\w+)\s*(?:<[^=;]*>)?\s*=/dg, kind: 'type' },
  { regex: /(?<![\w'])const\s+(?!(?:fn|unsafe|extern|async)\b)(\w+)\s*:/dg, kind: 'const' },
  { regex: /(?<![\w'])static\s+(?:mut\s+)?(\w+)\s*:/dg, kind: 'static' },
  { regex: /\bmod\s+(\w+)\s*[;{]/dg, kind: 'mod' },
];

/**
 * Replace comments and string/char literal contents with spaces, keeping every
 * offset and newline intact so match positions map straight back to the
 * original source. Quote characters survive, so the lifetime guard
 * (`'static`) still sees its apostrophe.
 */
export function maskRustNonCode(src: string): string {
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
      // Rust block comments nest.
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (src[j] === '*' && src[j + 1] === '/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      out += blank(src.slice(i, j));
      i = j;
      continue;
    }
    const prev = src[i - 1] ?? '';
    // `br"…"` (byte) and `cr"…"` (C string, Rust 1.77) are raw too. Missing
    // `c` sent `cr"C:\"` to the escaping branch below, whose `\"` never
    // closes the literal, blanking every declaration after it.
    const rawPrefixOk =
      !/\w/.test(prev) || ((prev === 'b' || prev === 'c') && !/\w/.test(src[i - 2] ?? ''));
    if (c === 'r' && (next === '"' || next === '#') && rawPrefixOk) {
      let j = i + 1;
      let hashes = 0;
      while (src[j] === '#') {
        hashes++;
        j++;
      }
      if (src[j] === '"') {
        const closer = `"${'#'.repeat(hashes)}`;
        const end = src.indexOf(closer, j + 1);
        const stop = end === -1 ? n : end + closer.length;
        out += `r${blank(src.slice(i + 1, stop))}`;
        i = stop;
        continue;
      }
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      if (j >= n) {
        out += `"${blank(src.slice(i + 1, n))}`;
        i = n;
      } else {
        out += `"${blank(src.slice(i + 1, j))}"`;
        i = j + 1;
      }
      continue;
    }
    if (c === "'") {
      // Char literal (`'"'`, `'\n'`, `'\u{1F600}'`) vs lifetime (`'a`).
      let end = -1;
      if (next === '\\') {
        const close = src.indexOf("'", i + 2);
        if (close !== -1 && close - i <= 12) end = close;
      } else if (next !== undefined) {
        const width = (src.codePointAt(i + 1) ?? 0) > 0xffff ? 2 : 1;
        if (src[i + 1 + width] === "'") end = i + 1 + width;
      }
      if (end !== -1) {
        out += `'${blank(src.slice(i + 1, end))}'`;
        i = end + 1;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** First line of the `///` doc block directly above `lineIdx` (attributes skipped). */
function rustDocAbove(lines: readonly string[], lineIdx: number): string {
  const doc: string[] = [];
  for (let i = lineIdx - 1; i >= 0; i--) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed.startsWith('///')) doc.unshift(trimmed.slice(3).trim());
    else if (trimmed.startsWith('#[')) continue;
    else break;
  }
  return (doc.find((line) => line.length > 0) ?? '').slice(0, 200);
}

function regexParse(opts: { file: string; content: string; lang: SymbolLang }): FileSymbols {
  const { file, content, lang } = opts;
  const symbols: IndexSymbol[] = [];
  const lines = content.split('\n');
  const code = maskRustNonCode(content);

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
    return lo + 1; // 1-based
  }

  function extractDeclaration(lineIdx: number, _match: RegExpExecArray): string {
    const line = lines[lineIdx] ?? '';
    return line.trim().slice(0, 500);
  }

  for (const pattern of RS_PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (let match = pattern.regex.exec(code); match !== null; match = pattern.regex.exec(code)) {
      const name = expectDefined(match[1]);
      // Anchor on the captured NAME, not the match start: a line-anchored
      // pattern's match begins at the indentation.
      const offset = match.indices?.[1]?.[0] ?? match.index ?? 0;
      const line = lineFromOffset(offset);
      const col = offset - (lineOffsets[line - 1] ?? 0);
      const lineIdx = line - 1;
      const signature = extractDeclaration(lineIdx, match);
      const docComment = rustDocAbove(lines, lineIdx);

      symbols.push({
        id: 0,
        lang,
        kind: pattern.kind,
        name,
        file,
        line,
        col,
        signature,
        docComment,
        scope: '',
        text: [name, signature, docComment].filter(Boolean).join(' ').trim(),
      });
    }
  }

  // Deduplicate by name+line
  const seen = new Set<string>();
  const deduped = symbols.filter((s) => {
    const key = `${s.name}:${s.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { file, lang, symbols: deduped, mtimeMs: Date.now() };
}
