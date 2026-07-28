import type { FileSymbols, SymbolLang } from './schema.js';

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
    default: {
      const { parseSymbols } = await import('./generic-parser.js');
      return parseSymbols({ file, content, lang });
    }
  }
}
