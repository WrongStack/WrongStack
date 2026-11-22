import { lspKindToInternalKinds } from './lsp-kind.js';
import {
  MODULE_OWNER_NAME,
  type SearchResult,
  type SymbolKind,
  type SymbolLang,
} from './schema.js';
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

/**
 * Ceiling on how many LIKE candidates the FTS5-less ranked fallback pulls into
 * memory before scoring (WS-031).
 *
 * The fallback ranks with an in-process BM25 pass, so it needs more than the
 * caller's `limit` (≤100) to rank well — but it does not need the whole corpus.
 * Without a bound, a broad query on a large index materializes every matching
 * row as a JS object; this subsystem has a documented OOM history, and search
 * runs on the request path.
 *
 * Set far above any query a human would type, so ranking quality is unchanged
 * in practice: it bounds the pathological case, it does not shape normal ones.
 * `total` is reported from a SQL `COUNT(*)` rather than the truncated array, so
 * capping never makes the reported match count wrong.
 */
export const SEARCH_CANDIDATE_SCAN_CAP = 5000;

export function normalizeSearchLimit(limit: number | undefined): number | undefined {
  return typeof limit === 'number' && Number.isFinite(limit)
    ? Math.max(0, Math.trunc(limit))
    : undefined;
}

/**
 * The symbol kinds a search may return.
 *
 * `undefined` — no kind constraint. `null` — the filter can match nothing (an
 * LSP kind with no internal equivalent, or a `kind` outside the `lspKind`'s
 * set). Otherwise the allowed kinds. `kind` and `lspKind` INTERSECT: the old
 * code let `lspKind` silently override an explicit `kind`.
 */
export function resolveKindFilter(
  filter: WriterSearchFilter | undefined,
): readonly SymbolKind[] | null | undefined {
  // `!= null`: binary-framed (MessagePack) clients deliver a missing lspKind
  // as null; absent and null mean the same thing here.
  const lspKinds = filter?.lspKind != null ? lspKindToInternalKinds(filter.lspKind) : undefined;
  if (lspKinds !== undefined && lspKinds.length === 0) return null;
  if (filter?.kind) {
    if (lspKinds !== undefined && !lspKinds.includes(filter.kind)) return null;
    return [filter.kind];
  }
  return lspKinds;
}

export function buildWriterSearchWhere(
  query: string,
  filter?: WriterSearchFilter | undefined,
): { where: string; values: unknown[] } | null {
  const conditions: string[] = [];
  const values: unknown[] = [];

  const kinds = resolveKindFilter(filter);
  if (kinds === null) return null;
  // A file's synthetic ref owner is not a declaration anyone searches for.
  conditions.push(`NOT (kind = 'mod' AND name = '${MODULE_OWNER_NAME}')`);
  if (kinds !== undefined) {
    conditions.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
    values.push(...kinds);
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
    // WS-031: the token pattern MUST be escaped, like every other LIKE in this
    // builder. Unescaped, `%` and `_` from the caller's query stay live
    // wildcards: the one-character query `%` compiles to a `LIKE '%%%'`
    // against every derived column, which matches every row in `symbols` — a
    // whole-corpus scan and materialization from a single tool argument. `_`
    // is the quieter half of the same bug: it is common in real symbol names
    // (`user_id`), where it silently matched any character and inflated the
    // candidate set.
    // P4: symbols.text is no longer persisted — tokens match the same
    // coverage via the derived columns (text was name + signature + doc).
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    conditions.push(
      `(${tokens
        .map(
          () =>
            "(name LIKE ? ESCAPE '\\' OR signature LIKE ? ESCAPE '\\' OR doc_comment LIKE ? ESCAPE '\\')",
        )
        .join(' OR ')})`,
    );
    for (const token of tokens) {
      const like = `%${escapeLike(token)}%`;
      values.push(like, like, like);
    }
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
