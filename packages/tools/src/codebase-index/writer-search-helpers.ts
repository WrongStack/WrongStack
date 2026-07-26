import type { SearchResult, SymbolKind, SymbolLang } from './schema.js';
import { lspKindToInternalKind } from './lsp-kind.js';
import { escapeLike } from './writer-helpers.js';

export interface WriterSearchFilter {
  kind?: SymbolKind | undefined;
  lang?: SymbolLang | undefined;
  file?: string | undefined;
  lspKind?: number | undefined;
}

export interface WriterSearchRow {
  id: number;
  lang: string;
  kind: string;
  name: string;
  file: string;
  line: number;
  col: number;
  signature: string;
  doc_comment: string;
  text?: string;
  score?: number;
  snippet?: string;
}

export function normalizeSearchLimit(limit: number | undefined): number | undefined {
  return typeof limit === 'number' && Number.isFinite(limit)
    ? Math.max(0, Math.trunc(limit))
    : undefined;
}

export function buildWriterSearchWhere(
  query: string,
  filter?: WriterSearchFilter | undefined,
): { where: string; values: unknown[] } | null {
  const conditions: string[] = [];
  const values: unknown[] = [];

  let effectiveKind: SymbolKind | undefined = filter?.kind;
  if (filter?.lspKind !== undefined) {
    const mapped = lspKindToInternalKind(filter.lspKind);
    if (mapped !== null) {
      effectiveKind = mapped;
    } else {
      return null;
    }
  }

  if (effectiveKind) {
    conditions.push('kind = ?');
    values.push(effectiveKind);
  }
  if (filter?.lang) {
    conditions.push('lang = ?');
    values.push(filter.lang);
  }
  if (filter?.file) {
    conditions.push("replace(file, '\\', '/') LIKE ? ESCAPE '\\'");
    values.push(`%${escapeLike(filter.file.replace(/\\/g, '/'))}%`);
  }
  if (query.trim()) {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    conditions.push(`(${tokens.map(() => 'text LIKE ?').join(' OR ')})`);
    for (const token of tokens) values.push(`%${token}%`);
  }

  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values };
}

export function mapWriterSearchRow(
  row: WriterSearchRow,
  lspKind: number | undefined,
  score = 0,
  snippet = '',
): SearchResult {
  return {
    id: row.id,
    lang: row.lang as SymbolLang,
    kind: row.kind as SymbolKind,
    name: row.name,
    file: row.file,
    line: row.line,
    col: row.col,
    signature: row.signature,
    docComment: row.doc_comment,
    score,
    snippet,
    lspKind,
  };
}
