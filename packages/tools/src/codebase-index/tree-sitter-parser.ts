/**
 * Tree-Sitter WASM Universal AST Extractor (Phase 1).
 *
 * Replaces regex heuristics in `generic-parser.ts` for languages with a
 * pre-compiled tree-sitter grammar: C, C++, Java, C#, PHP, Ruby, Swift,
 * Kotlin, Elixir, Shell (bash), plus Go/Python/Rust as opt-in WASM paths
 * (default behavior still uses the existing first-class parsers).
 *
 * The runtime contract matches {@link parseGeneric}: callers receive a
 * {@link FileSymbols} record. Symbol ids are always 0 — the caller assigns
 * them during bulk insertion. Refs carry `fromId: 0` and are deduplicated
 * downstream by `parser-dispatch.ts#withRelations`.
 *
 * Design notes:
 *   - Grammar WASM files live alongside the runtime in `wasm/<lang>/`.
 *     Vendoring them in-tree makes builds deterministic; no fetch-on-first-run.
 *   - The {@link web-tree-sitter} runtime is initialized once per process.
 *     `Language.load(wasmPath)` resolves on the first parse of each language
 *     and is memoized — every subsequent parse reuses the same Language object.
 *   - On any failure (grammar file missing, runtime not installed, parse error
 *     with no recoverable symbols) this module returns an empty `symbols[]`
 *     rather than throwing — matching the existing parsers' "never drops a
 *     file from the index" contract.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileSymbols, SymbolLang } from './schema.js';
import { getQueries } from './tree-sitter/queries.js';
import { visitTree } from './tree-sitter/visitor.js';

/**
 * Directory holding `tree-sitter-runtime.wasm` and the 13 vendored
 * `<lang>/tree-sitter-<lang>.wasm` grammar files.
 *
 * Resolved relative to this module via `import.meta.url` so the path
 * remains correct whether the code runs from `dist/` (built) or
 * `src/` (vitest under tsx). No reliance on process.cwd().
 */
const WASM_DIR = fileURLToPath(new URL('./wasm/', import.meta.url));

/** Runtime tree-sitter engine WASM (the `web-tree-sitter` package's binary). */
const RUNTIME_WASM = path.join(WASM_DIR, 'tree-sitter-runtime.wasm');

// ─── Grammar integrity gate (security report Phase 4, item 20 / VF-30) ───────
//
// The vendored .wasm set is pinned by `wasm/checksums.json` (generated and
// CI-verified by scripts/check-tree-sitter-wasm.mjs). Verified lazily at the
// first load of each grammar: on mismatch this throws, `parseSymbols`'s
// never-throws contract turns that into zero symbols, and the dispatcher
// falls back to the regex parser — tampered bytes never execute and the
// failure is visible on stderr. When the manifest is absent (the published
// dist tree does not ship the wasm directory) verification is skipped and
// behavior is unchanged for that surface.

const CHECKSUMS_PATH = path.join(WASM_DIR, 'checksums.json');
let cachedChecksums: Record<string, string> | null | undefined;

function expectedChecksums(): Record<string, string> | null {
  if (cachedChecksums !== undefined) return cachedChecksums;
  try {
    cachedChecksums = JSON.parse(readFileSync(CHECKSUMS_PATH, 'utf8')) as Record<string, string>;
  } catch (err) {
    // Only an intentionally ABSENT manifest (the published dist tree does
    // not ship the wasm directory) skips verification. A manifest that
    // exists but cannot be read or parsed must not silently disable the
    // gate — that is exactly the state a tampered pin would produce — so it
    // is cached as an EMPTY record: every subsequent lookup finds no entry
    // and fails closed (Chimera review).
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      cachedChecksums = null;
    } else {
      console.error(
        `[tree-sitter] grammar checksum manifest is unreadable (${CHECKSUMS_PATH}): ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          'Treating as an integrity failure — tree-sitter grammars will not load.',
      );
      cachedChecksums = {};
    }
  }
  return cachedChecksums;
}

function verifyWasmIntegrity(wasmPath: string): void {
  const manifest = expectedChecksums();
  // null = manifest intentionally absent (dist tree) → verification skipped.
  if (manifest === null) return;
  const rel = path.relative(WASM_DIR, wasmPath).split(path.sep).join('/');
  const expected = manifest[rel];
  // A PRESENT manifest must pin every wasm file about to load: a missing
  // entry means the file arrived outside the checksum workflow (Chimera
  // review) — including the empty record cached for an unreadable manifest.
  if (expected === undefined) {
    console.error(
      `[tree-sitter] grammar ${rel} is not pinned in checksums.json. ` +
        'Refusing to load; falling back to the regex parser. If this change is intentional, ' +
        'regenerate wasm/checksums.json via scripts/check-tree-sitter-wasm.mjs --write and review the diff.',
    );
    throw new Error(`tree-sitter grammar not pinned: ${rel}`);
  }
  const actual = createHash('sha256').update(readFileSync(wasmPath)).digest('hex');
  if (actual !== expected) {
    console.error(
      `[tree-sitter] grammar integrity FAILED for ${rel}: expected sha256 ${expected}, found ${actual}. ` +
        'Refusing to load; falling back to the regex parser. If this change is intentional, ' +
        'regenerate wasm/checksums.json via scripts/check-tree-sitter-wasm.mjs --write and review the diff.',
    );
    throw new Error(`tree-sitter grammar integrity failure: ${rel}`);
  }
}

/**
 * Map our {@link SymbolLang} taxonomy to the tree-sitter grammar directory
 * names shipped by `tree-sitter-wasm`. Two notes:
 *
 *   1. Only the languages that *actually have* a first-class tree-sitter
 *      grammar in our vendored set are listed here. Adding a grammar is a
 *      one-line entry plus a query table in `tree-sitter/queries.ts`.
 *   2. Go/Python/Rust stay *off* this map by default — the existing
 *      `go-parser.ts` / `py-parser.ts` / `rs-parser.ts` are more mature
 *      (e.g. Python's `ast` is lossless, our regex Go parser works without
 *      a toolchain). They become available via opt-in env vars wired in
 *      Phase 5 once the worker-pool benchmark can decide on a switch.
 */
const LANG_TO_GRAMMAR: Partial<Record<SymbolLang, string>> = {
  c: 'c',
  cpp: 'cpp',
  java: 'java',
  csharp: 'c_sharp', // tree-sitter directory uses underscore
  php: 'php',
  ruby: 'ruby',
  swift: 'swift',
  kotlin: 'kotlin',
  shell: 'bash', // we treat `.sh` / `.bash` / `.zsh` via the bash grammar
  // Go/Python/Rust are opt-in only (see goOptIn / pyOptIn / rsOptIn below)
  elixir: 'elixir',
};

/** Env-var opt-in switches for migrating Go/Python/Rust off their current parsers. */
const GO_OPT_IN = 'WRONGSTACK_USE_TS_GO';
const PY_OPT_IN = 'WRONGSTACK_USE_TS_PY';
const RS_OPT_IN = 'WRONGSTACK_USE_TS_RS';

function optInEnabled(env: string): boolean {
  return process.env[env] === '1' || process.env[env] === 'true';
}

// ─── Runtime + grammar cache ─────────────────────────────────────────────────

interface RuntimeState {
  Parser: typeof import('web-tree-sitter').Parser;
  Language: typeof import('web-tree-sitter').Language;
  init: () => Promise<void>;
}

let runtimePromise: Promise<RuntimeState> | null = null;

interface CachedLanguage {
  lang: SymbolLang;
  Language: import('web-tree-sitter').Language;
}

/** Per-language language-object cache. Populated lazily on first parse. */
const languageCache = new Map<SymbolLang, Promise<CachedLanguage>>();

function getRuntime(): Promise<RuntimeState> {
  if (!runtimePromise) {
    runtimePromise = (async (): Promise<RuntimeState> => {
      const mod = await import('web-tree-sitter');
      // `Parser.init` takes Emscripten moduleOptions, not a path string. The
      // runtime WASM lookup is redirected via `locateFile`, which is the
      // Emscripten-standard hook for "where is the .wasm". Pointing it at our
      // vendored runtime keeps the build deterministic — no fetch-on-first-run.
      const init = (): Promise<void> => {
        verifyWasmIntegrity(RUNTIME_WASM);
        return mod.Parser.init({ locateFile: () => RUNTIME_WASM });
      };
      return { Parser: mod.Parser, Language: mod.Language, init };
    })();
  }
  return runtimePromise;
}

async function loadLanguage(lang: SymbolLang): Promise<CachedLanguage> {
  const existing = languageCache.get(lang);
  if (existing) return existing;

  const promise = (async (): Promise<CachedLanguage> => {
    const grammarName = resolveGrammarName(lang);
    if (!grammarName) {
      throw new Error(`tree-sitter: no grammar registered for lang "${lang}"`);
    }
    const wasmPath = path.join(WASM_DIR, grammarName, `tree-sitter-${grammarName}.wasm`);
    const { Language, init } = await getRuntime();
    // `Language.load` requires the runtime (`Parser.init`) to have already
    // wired the WASM loader. Calling `init()` here means `loadLanguage` is
    // safe to call in any order — the smoke helper bypasses `parseSymbols`,
    // and a future caller might too. The init is idempotent (Promise cache).
    await init();
    // `Language.load` accepts a filesystem path string or a Uint8Array. On
    // Node 0.26.x the string form is resolved against cwd — passing a file://
    // URI produces a path concatenation like `cwd/file:///...` and crashes.
    // Use the raw absolute path; the runtime opens it directly.
    verifyWasmIntegrity(wasmPath);
    const languageObj = await Language.load(wasmPath);
    return { lang, Language: languageObj };
  })();

  // Set BEFORE the first `await init()` to close the race window: if two
  // concurrent callers both miss the `existing` check, the second one
  // re-uses our in-flight promise. Promise assignment is atomic in V8.
  languageCache.set(lang, promise);
  return promise;
}

function resolveGrammarName(lang: SymbolLang): string | undefined {
  if (lang === 'go' && optInEnabled(GO_OPT_IN)) return 'go';
  if (lang === 'py' && optInEnabled(PY_OPT_IN)) return 'python';
  if (lang === 'rs' && optInEnabled(RS_OPT_IN)) return 'rust';
  return LANG_TO_GRAMMAR[lang];
}

/** True when this lang has a tree-sitter grammar available right now. */
function isTreeSitterSupported(lang: SymbolLang): boolean {
  return resolveGrammarName(lang) !== undefined;
}

/** Visible for tests: the absolute path to a vendored grammar WASM. */
export function getGrammarWasmPath(lang: SymbolLang): string | undefined {
  const name = resolveGrammarName(lang);
  if (!name) return undefined;
  return path.join(WASM_DIR, name, `tree-sitter-${name}.wasm`);
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Async entry point mirroring {@link parseGeneric}. Used by
 * `parser-dispatch.ts` via dynamic import. Returns an empty `symbols[]`
 * on any failure rather than throwing — the dispatch layer falls back to
 * `generic-parser` for regex coverage when this returns zero symbols.
 *
 * Symbol emission is *not* implemented in this file yet — this Day-1
 * scaffold only proves grammar loading and parsing work end-to-end.
 * Day 2-3 introduces the universal visitor (`tree-sitter/visitor.ts`)
 * and per-language query tables (`tree-sitter/queries.ts`).
 */
export async function parseSymbols(opts: {
  file: string;
  content: string;
  lang: SymbolLang;
}): Promise<FileSymbols> {
  const { file, content, lang } = opts;

  if (!isTreeSitterSupported(lang)) {
    return { file, lang, symbols: [], mtimeMs: Date.now() };
  }

  try {
    const { Parser } = await getRuntime();
    const cached = await loadLanguage(lang);

    const parser = new Parser();
    parser.setLanguage(cached.Language);
    const tree = parser.parse(content);
    if (!tree) {
      return { file, lang, symbols: [], mtimeMs: Date.now() };
    }

    // P3.9: the visitor now emits call/import/heritage refs alongside
    // symbols (per-language refRules in tree-sitter/queries.ts). Refs flow
    // through withRelations like every other parser's.
    const { symbols, refs } = visitTree(tree, content, file, lang, getQueries(lang));
    parser.delete();
    tree.delete();
    return { file, lang, symbols, refs, mtimeMs: Date.now() };
  } catch {
    // Any failure — missing WASM, runtime mismatch, parse crash on
    // pathological input — returns empty so the dispatch can fall through
    // to the regex extractor.
    return { file, lang, symbols: [], mtimeMs: Date.now() };
  }
}

/**
 * Internal helper used by AST-shape inspectors and tests. Loads and caches
 * the tree-sitter `Language` for a given {@link SymbolLang} without parsing.
 * Not part of the public parser API — the indexer should always go through
 * {@link parseSymbols}.
 */
export async function loadTreeSitterLanguage(
  lang: SymbolLang,
): Promise<import('web-tree-sitter').Language> {
  const cached = await loadLanguage(lang);
  return cached.Language;
}

/** Test-only helper: parse and return the root node type. Throws on failure. */
export async function __smokeRootType(opts: {
  content: string;
  lang: SymbolLang;
}): Promise<string> {
  if (!isTreeSitterSupported(opts.lang)) {
    throw new Error(`tree-sitter: no grammar registered for lang "${opts.lang}"`);
  }
  const { Parser } = await getRuntime();
  const cached = await loadLanguage(opts.lang);
  const parser = new Parser();
  parser.setLanguage(cached.Language);
  // Try/finally so the WASM-side native handles are always released. Each
  // call leaks ~1KB of WASM heap otherwise — small per call, but the smoke
  // test invokes this helper 10× per test file across the suite.
  let tree: import('web-tree-sitter').Tree | null = null;
  try {
    tree = parser.parse(opts.content);
    if (!tree) throw new Error('tree-sitter: parser.parse returned null');
    return tree.rootNode.type;
  } finally {
    tree?.delete();
    parser.delete();
  }
}

/**
 * Parse source code using Tree-Sitter and return the AST and parser.
 * Caller MUST call `tree.delete()` and `parser.delete()` in a finally block.
 */
export async function parseTreeSitterAst(opts: { content: string; lang: SymbolLang }): Promise<{
  tree: import('web-tree-sitter').Tree;
  parser: import('web-tree-sitter').Parser;
} | null> {
  const grammar =
    resolveGrammarName(opts.lang) ??
    (opts.lang === 'go'
      ? 'go'
      : opts.lang === 'py'
        ? 'python'
        : opts.lang === 'rs'
          ? 'rust'
          : undefined);
  if (!grammar) return null;

  try {
    const { Parser, Language, init } = await getRuntime();
    await init();
    const wasmPath = path.join(WASM_DIR, grammar, `tree-sitter-${grammar}.wasm`);
    // Same integrity gate as loadLanguage(): this second grammar-load path
    // bypassed the checksum check (Chimera review) — a tampered .wasm would
    // have been accepted here while every parseSymbols load verified.
    // The catch below converts the throw to `null`, preserving the caller
    // contract of degrading rather than throwing.
    verifyWasmIntegrity(wasmPath);
    const languageObj = await Language.load(wasmPath);
    const parser = new Parser();
    parser.setLanguage(languageObj);
    const tree = parser.parse(opts.content);
    if (!tree) {
      parser.delete();
      return null;
    }
    return { tree, parser };
  } catch {
    return null;
  }
}
