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

const RS_PATTERNS: RustPattern[] = [
  { regex: /fn\s+(\w+)\s*\([^)]*\)/g, kind: 'function' },
  { regex: /struct\s+(\w+)/g, kind: 'struct' },
  { regex: /enum\s+(\w+)/g, kind: 'enum' },
  { regex: /trait\s+(\w+)/g, kind: 'trait' },
  { regex: /impl\s+(?:<[^>]+>)?(\w+)/g, kind: 'impl' },
  { regex: /type\s+(\w+)\s*=/g, kind: 'type' },
  { regex: /const\s+(\w+)/g, kind: 'const' },
  { regex: /static\s+(\w+)/g, kind: 'static' },
  { regex: /mod\s+(\w+)/g, kind: 'mod' },
];

function regexParse(opts: { file: string; content: string; lang: SymbolLang }): FileSymbols {
  const { file, content, lang } = opts;
  const symbols: IndexSymbol[] = [];
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
    return lo + 1; // 1-based
  }

  function extractDeclaration(lineIdx: number, _match: RegExpExecArray): string {
    const line = lines[lineIdx] ?? '';
    return line.trim().slice(0, 500);
  }

  for (const pattern of RS_PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (
      let match = pattern.regex.exec(content);
      match !== null;
      match = pattern.regex.exec(content)
    ) {
      const name = expectDefined(match[1]);
      const offset = match.index ?? 0;
      const line = lineFromOffset(offset);
      const col = offset - (lineOffsets[line - 1] ?? 0);
      const lineIdx = line - 1;
      const signature = extractDeclaration(lineIdx, match);

      symbols.push({
        id: 0,
        lang,
        kind: pattern.kind,
        name,
        file,
        line,
        col,
        signature,
        docComment: '',
        scope: '',
        text: `${name} ${signature}`.trim(),
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
