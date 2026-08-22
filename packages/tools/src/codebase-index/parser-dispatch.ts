import { extractImports, hasImportPatterns } from './import-extractor.js';
import type { BatchFile } from './parser-batch.js';
import { chunkBatchFiles, runGoBatch, runPyBatch } from './parser-batch.js';
import { resolvePythonBinary } from './py-parser.js';
import type { FileSymbols, Ref, SymbolLang } from './schema.js';

/**
 * Load only the parser needed for this file. Keeping these imports lazy is
 * important for the project server: TypeScript's compiler API stays out of the
 * SQLite/IPC owner when TS/JS parsing is delegated to parser workers.
 */
export async function parseFileContent(
  file: string,
  content: string,
  lang: SymbolLang,
): Promise<FileSymbols> {
  const parsed = await dispatch(file, content, lang);
  return withRelations(parsed, content, lang);
}

/**
 * Parse a mixed-language batch of files (P3.8).
 *
 * Go and Python files are grouped and handed to ONE child process per chunk
 * (`runGoBatch` / `runPyBatch`) instead of one spawn per file; every other
 * language goes through `parseFileContent` as before. Files the batch
 * parsers could not produce (per-file error inside the envelope, or the
 * whole chunk failing) fall back to the single-file parser, which owns the
 * per-language fallback semantics — so output is identical to the per-file
 * path in every case, only faster.
 *
 * Results are returned in input order (index-aligned), matching what callers
 * expected from N parallel `parseFileContent` calls.
 *
 * Opt out with `WRONGSTACK_TOOLCHAIN_BATCH=0` to restore per-file spawning
 * everywhere (bisecting a toolchain issue, exotic environments).
 */
/**
 * One file's parse outcome. `result` is null only when the parser THREW —
 * batch-invalid files still come back with the fallback parser's own
 * zero-symbol semantics. `error` carries the throw's message so callers can
 * record something actionable instead of a bare "no result".
 */
export interface ParseSlot {
  result: FileSymbols | null;
  error?: string | undefined;
}

export async function parseFilesContent(
  files: ReadonlyArray<{ file: string; content: string; lang: SymbolLang }>,
): Promise<ParseSlot[]> {
  if (files.length === 0) return [];
  const slots: ParseSlot[] = files.map(() => ({ result: null }));

  const batchingEnabled = process.env['WRONGSTACK_TOOLCHAIN_BATCH'] !== '0';

  if (batchingEnabled) {
    const goFiles: Array<BatchFile & { index: number }> = [];
    const pyFiles: Array<BatchFile & { index: number }> = [];
    files.forEach((f, index) => {
      if (f.lang === 'go') goFiles.push({ ...f, index });
      else if (f.lang === 'py') pyFiles.push({ ...f, index });
    });

    // Run the two toolchains' batches sequentially: the spawn gate serializes
    // them anyway, and this keeps peak memory to one chunk's sources.
    if (goFiles.length > 0) {
      await applyBatchResults(slots, goFiles, (chunks) => runGoBatch(chunks), 'go');
    }
    if (pyFiles.length > 0) {
      const pyBinary = await resolvePythonBinary();
      if (pyBinary) {
        await applyBatchResults(slots, pyFiles, (chunks) => runPyBatch(chunks, pyBinary), 'py');
      }
    }
  }

  // Everything not covered by a successful batch entry parses per-file, in
  // PARALLEL — this restores the pre-P3.8 Promise.all parallelism; the
  // sequential loop regressed incremental-index latency for mixed batches.
  // Per-slot error containment: a parser that THROWS leaves result null and
  // captures its message; the caller records it as a parse error, exactly
  // like the pool path does for files absent from worker results.
  const jobs: Promise<void>[] = [];
  for (let i = 0; i < files.length; i++) {
    if (slots[i]!.result !== null) continue;
    const { file, content, lang } = files[i]!;
    const slot = slots[i]!;
    jobs.push(
      (async () => {
        try {
          slot.result = await parseFileContent(file, content, lang);
        } catch (err) {
          slot.error = err instanceof Error ? err.message : String(err);
        }
      })(),
    );
  }
  await Promise.all(jobs);
  return slots;
}

/** Fill `slots` from a batch parser; mark covered indexes, leave misses. */
async function applyBatchResults(
  slots: ParseSlot[],
  batchFiles: ReadonlyArray<BatchFile & { index: number }>,
  runBatch: (chunk: BatchFile[]) => Promise<Map<string, FileSymbols>>,
  lang: 'go' | 'py',
): Promise<void> {
  for (const chunk of chunkBatchFiles(batchFiles)) {
    let byFile: Map<string, FileSymbols> | null = null;
    try {
      byFile = await runBatch(chunk);
    } catch {
      byFile = null; // whole-chunk failure → per-file fallback for the chunk
    }
    if (!byFile) continue;
    for (const item of chunk) {
      const parsed = byFile.get(item.file);
      if (!parsed) continue; // per-file failure → per-file fallback
      slots[item.index] = { result: withRelations(parsed, item.content, lang) };
    }
  }
}

async function dispatch(file: string, content: string, lang: SymbolLang): Promise<FileSymbols> {
  switch (lang) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx': {
      const { parseSymbols } = await import('./ts-parser.js');
      return parseSymbols({ file, content, lang });
    }
    case 'go': {
      const { parseSymbols } = await import('./go-parser.js');
      return parseSymbols({ file, content, lang: 'go' });
    }
    case 'py': {
      const { parseSymbols } = await import('./py-parser.js');
      return parseSymbols({ file, content, lang: 'py' });
    }
    case 'rs': {
      const { parseSymbols } = await import('./rs-parser.js');
      return parseSymbols({ file, content, lang: 'rs' });
    }
    case 'json': {
      const { parseSymbols } = await import('./json-parser.js');
      return parseSymbols({ file, content, lang: 'json' });
    }
    case 'yaml': {
      const { parseSymbols } = await import('./yaml-parser.js');
      return parseSymbols({ file, content, lang: 'yaml' });
    }
    // Phase 1: ten languages now route through the Tree-Sitter WASM
    // universal parser (`tree-sitter-parser.ts`). The dispatch falls back to
    // the regex extractor in `generic-parser.ts` whenever WASM loading fails
    // or the parser returns zero symbols — preserving the indexable-file
    // contract that "missing a parser must never mean skipping the file".
    case 'c':
    case 'cpp':
    case 'java':
    case 'csharp':
    case 'php':
    case 'ruby':
    case 'swift':
    case 'kotlin':
    case 'shell':
    case 'elixir': {
      try {
        const { parseSymbols } = await import('./tree-sitter-parser.js');
        const parsed = await parseSymbols({ file, content, lang });
        // Tree-sitter emits real symbols for these ten languages now. The
        // regex fallback only fires when WASM loading or grammar init fails —
        // a machine without the vendored grammars (e.g. a slim CI image) still
        // indexes the file via the regex extractor rather than dropping it.
        if (parsed.symbols.length > 0) return parsed;
      } catch {
        /* fall through to regex */
      }
      const { parseSymbols } = await import('./generic-parser.js');
      return parseSymbols({ file, content, lang });
    }
    default: {
      const { parseSymbols } = await import('./generic-parser.js');
      return parseSymbols({ file, content, lang });
    }
  }
}

/**
 * Guarantee every parsed file carries dependency refs, and that every ref
 * carries its source language.
 *
 * Two things happen here rather than in each parser:
 *
 *  - **Regex import fallback.** A parser returns no refs either because its
 *    language has no AST extractor at all (Java, C#, Ruby, …) or because the
 *    toolchain it shells out to is missing — a machine without Go installed
 *    still indexes `.go` files, just via regex. In both cases the regex import
 *    extractor is what keeps the file from becoming an isolated dot in the Code
 *    Atlas. A parser that *did* produce refs is left alone, so the AST result
 *    always wins.
 *
 *  - **Language stamping.** `Ref.lang` scopes name resolution to one language
 *    family. Setting it at the single point every ref flows through means a new
 *    parser cannot forget to, and silently reintroduce cross-language edges.
 */
function withRelations(parsed: FileSymbols, content: string, lang: SymbolLang): FileSymbols {
  let refs: Ref[] = parsed.refs ?? [];
  if (refs.length === 0 && hasImportPatterns(lang)) {
    refs = extractImports({ content, lang });
  }
  return { ...parsed, refs: refs.map((ref) => (ref.lang ? ref : { ...ref, lang })) };
}
