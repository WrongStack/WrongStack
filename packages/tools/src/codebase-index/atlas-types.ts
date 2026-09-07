/**
 * The shapes the Codebase Atlas projection emits.
 *
 * They live apart from the code that builds them so that a renderer can name
 * what it renders without importing the builder: `atlas-projection` produces
 * these and calls `atlas-export` to render them, and `atlas-export` needs the
 * types but must never reach back for the builder. Declaring them here is what
 * keeps that a one-way edge instead of a module cycle.
 *
 * Everything here is plain data — no imports, no behaviour. `atlas-projection`
 * re-exports the whole set, so consumers keep importing from there.
 */

export interface AtlasSymbol {
  name: string;
  kind: string;
  line: number;
}

export interface AtlasFile {
  path: string;
  rank: number;
  inDeg: number;
  outDeg: number;
  package: string;
  symbols: AtlasSymbol[];
  /** Concept-layer summary. Omitted entirely when the layer has not run. */
  concept?: string;
}

export interface AtlasPackage {
  name: string;
  files: number;
  /** Highest-ranked file in the package. */
  hub: string;
  rank: number;
  /** Subsystem summary for this package, when the concept layer derived one. */
  summary?: string;
}

/**
 * A package-level dependency, aggregated from the reference graph.
 *
 * Only the package level is projected. File-level edges would be tens of
 * thousands of rows — a diff nobody can read and a file nobody can render,
 * for a level of detail the index itself answers better on demand.
 */
export interface AtlasEdge {
  from: string;
  to: string;
  weight: number;
  refType: string;
}

export interface AtlasDocument {
  schema: number;
  counts: { files: number; symbols: number; packages: number };
  packages: AtlasPackage[];
  edges: AtlasEdge[];
  files: AtlasFile[];
}

export interface AtlasManifest {
  schema: number;
  /**
   * `files`/`symbols` are the index's own totals, for display.
   *
   * `tracked` is the size of the file set the digest was computed over — the
   * only number a freshness check may compare its own file set against. The
   * two can differ (a file with no symbols is tracked but may not count
   * towards `files`), and comparing across them reported phantom additions.
   */
  counts: { files: number; symbols: number; tracked: number };
  /**
   * sha-256 over every indexed file's `path\0contentHash`, sorted. Catches a
   * change anywhere in the repository, including files the atlas does not
   * itself carry.
   */
  digest: string;
  /** Per-file content hashes, for the files the atlas describes. */
  files: Record<string, string>;
}

export interface AtlasProjection {
  document: AtlasDocument;
  manifest: AtlasManifest;
  markdown: string;
}
