import { extractImports, hasImportPatterns } from './import-extractor.js';
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
