import type { FileSymbols, SymbolLang } from './schema.js';

export interface ParserWorkerRequest {
  id: number;
  file: string;
  lang: SymbolLang;
}

export type ParserWorkerResponse =
  | { id: number; ok: true; parsed: FileSymbols }
  | { id: number; ok: false; stage: 'read' | 'parse'; error: string };
