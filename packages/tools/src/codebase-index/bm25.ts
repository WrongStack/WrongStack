/**
 * BM25 ranking implementation — no external dependencies.
 *
 * Algorithm: Okapi BM25 with standard parameters (k1=1.5, b=0.75).
 */

const K1 = 1.5;
const B = 0.75;

/**
 * Precompiled tokeniser regex. Hoisted to module scope so `tokenise` does not
 * recompile it on every call — it runs once per query term AND once per
 * indexed document, so per-call allocation is wasteful.
 *
 * Preserves Unicode letters, digits, dollar signs, and apostrophes; everything
 * else (including underscores) becomes a separator. Built via the RegExp
 * constructor to avoid quoting fragility in automated edit tooling.
 */
// The constructor form is deliberate: a literal here embeds a bare apostrophe
// that automated edit tooling has repeatedly mangled.
// biome-ignore lint/complexity/useRegexLiterals: keep the escaped-string form
const TOKENISE_RE = new RegExp("[^\\p{L}\\p{N}$']", 'gu');

interface Bm25Doc {
  id: number;
  tokens: string[];
  raw: string;
  len: number;
}

/**
 * Tokenise a string into lowercase word tokens.
 *
 * Preserves apostrophes so that identifiers like `can't` or `user's`
 * remain a single token. Underscores are treated as separators (they
 * conventionally split words in snake_case identifiers).
 */
export function tokenise(text: string): string[] {
  return text.replace(TOKENISE_RE, ' ').toLowerCase().trim().split(/\s+/).filter(Boolean);
}

interface IndexableDoc {
  id: number;
  text: string;
}

/**
 * Split a camelCase/SnakeCase identifier into its constituent words.
 * e.g. "complexOperation" → "complex Operation"
 *      "foo_bar_baz"       → "foo bar baz"
 * This allows a query for "complex" to match "complexOperation"
 * via the shared "complex" token.
 */
function splitName(name: string): string {
  return (
    name
      // Split an acronym from the word that follows it: HTTPServer → HTTP Server.
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      // Identifiers commonly encode versions/algorithms with digits.
      .replace(/([\p{L}])(\d)/gu, '$1 $2')
      .replace(/(\d)([\p{L}])/gu, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .trim()
  );
}

/**
 * Build indexable text for BM25 from a symbol's fields.
 * The name is split into camelCase/SnakeCase words so that queries
 * like "complex" match "complexOperation". The verbatim name is
 * also included for exact-match queries.
 */
export function buildIndexableText(name: string, signature: string, docComment: string): string {
  return [splitName(name), name, signature, docComment].filter(Boolean).join(' ');
}

export function buildBm25Index(docs: IndexableDoc[]): Bm25Index {
  const documents: Bm25Doc[] = docs.map((d) => {
    const tokens = tokenise(d.text);
    return { id: d.id, tokens, raw: d.text, len: tokens.length };
  });

  const N = documents.length;
  const totalLen = documents.reduce((sum, d) => sum + d.len, 0);
  const avgLen = N === 0 ? 0 : totalLen / N;

  return new Bm25Index(documents, N, avgLen);
}

export class Bm25Index {
  private readonly safeAvgLen: number;
  /** Lazily-built id→doc index so getDoc is O(1) instead of an O(D) linear find. */
  private _byId: Map<number, Bm25Doc> | undefined;

  constructor(
    private documents: Bm25Doc[],
    private N: number,
    avgLen: number,
  ) {
    this.safeAvgLen = avgLen === 0 ? 1 : avgLen;
  }

  score(query: string, filter?: (id: number) => boolean): Array<{ id: number; score: number }> {
    const qTokens = tokenise(query);
    if (qTokens.length === 0) return [];

    // Precompute document frequency per query term once, outside the
    // per-document loop. The SQLite FTS path uses token-prefix matching;
    // we mirror that contract here so fallback ranking has identical recall.
    // Previously this was recomputed for every (document, term) pair —
    // O(D²QT) — making large indexes (5500+ symbols) hit the 30s search
    // watchdog on every query.
    const dfByTerm = new Map<string, number>();
    for (const qTerm of qTokens) {
      let dfVal = 0;
      for (const candidate of this.documents) {
        if (candidate.tokens.some((t) => t.startsWith(qTerm))) dfVal++;
      }
      dfByTerm.set(qTerm, dfVal);
    }

    const results: Array<{ id: number; score: number }> = [];

    for (const doc of this.documents) {
      if (filter && !filter(doc.id)) continue;

      let docScore = 0;
      for (const qTerm of qTokens) {
        let tf = 0;
        for (const t of doc.tokens) {
          if (t.startsWith(qTerm)) tf++;
        }
        if (tf === 0) continue;

        const dfVal = dfByTerm.get(qTerm) ?? 0;
        if (dfVal === 0) continue;

        const idf = Math.log((this.N - dfVal + 0.5) / (dfVal + 0.5) + 1);
        const lenRatio = B * (doc.len / this.safeAvgLen);
        const tfComponent = (tf * (K1 + 1)) / (tf + K1 * (1 - B + lenRatio));

        docScore += idf * tfComponent;
      }

      if (docScore > 0) results.push({ id: doc.id, score: docScore });
    }

    return results;
  }

  getDoc(id: number): Bm25Doc | undefined {
    if (!this._byId) {
      this._byId = new Map(this.documents.map((d) => [d.id, d]));
    }
    return this._byId.get(id);
  }

  extractSnippet(docId: number, queryTokens: string[], radius = 40): string {
    const doc = this.getDoc(docId);
    if (!doc) return '';

    for (const tok of queryTokens) {
      const idx = doc.raw.toLowerCase().indexOf(tok);
      if (idx !== -1) {
        const start = Math.max(0, idx - radius);
        const end = Math.min(doc.raw.length, idx + tok.length + radius);
        const excerpt = doc.raw.slice(start, end);
        const ellipsis = '\u2026';
        return (start > 0 ? ellipsis : '') + excerpt + (end < doc.raw.length ? ellipsis : '');
      }
    }
    return doc.raw.slice(0, radius * 2) + (doc.raw.length > radius * 2 ? '\u2026' : '');
  }
}
