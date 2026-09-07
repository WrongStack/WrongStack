/**
 * Atlas — a committable projection of the codebase index.
 *
 * The index itself is a 180 MB SQLite database under `~/.wrongstack/projects/`:
 * machine-local, binary, and unreviewable. That means every fresh clone, every
 * CI run and every teammate starts cold, and nobody can see in a pull request
 * what the index believes about the code.
 *
 * The atlas is the derived, human-sized answer to that: a small, deterministic
 * set of files written into the repository at `.wrongstack/atlas/`. The
 * database stays canonical — this is strictly a one-way projection, and
 * regenerating it from an unchanged index must produce byte-identical output.
 *
 * ## Determinism is a hard requirement
 *
 * Anything that varies between two runs over the same index turns every
 * indexing run into a merge conflict. So: no timestamps, no host paths, keys
 * emitted in sorted order, floats rounded to a fixed precision, and LF line
 * endings (the pre-commit hook enforces those repo-wide anyway).
 *
 * ## Staleness is reported, never guessed
 *
 * A committed atlas describing code that has since moved is worse than no
 * atlas, because it is confidently wrong. {@link checkAtlasFreshness} compares
 * the recorded per-file content hashes against the live index and says exactly
 * which files drifted.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { renderAtlasHtml } from './atlas-export.js';
import type {
  AtlasDocument,
  AtlasEdge,
  AtlasFile,
  AtlasManifest,
  AtlasPackage,
  AtlasProjection,
  AtlasSymbol,
} from './atlas-types.js';
import type { FileRankRow } from './graph-rank.js';
import { type IndexStore, indexStorePool } from './writer.js';
import { posixIndexPath, resolveIndexDir } from './writer-helpers.js';
import type { RankedFileRow } from './writer-rank.js';

/** Directory the projection is written to, relative to the project root. */
export const ATLAS_DIR = path.join('.wrongstack', 'atlas');

export const ATLAS_JSON = 'atlas.json';
export const ATLAS_MARKDOWN = 'ATLAS.md';
export const ATLAS_MANIFEST = 'manifest.json';

/**
 * Bumped when the emitted shape changes. A reader seeing a different schema
 * reports the atlas as stale rather than misinterpreting its fields.
 */
export const ATLAS_SCHEMA = 2;

/**
 * Files carried in the projection. Enough to describe the architecture,
 * small enough to read in a diff — the full 8k-file list would be neither.
 */
export const ATLAS_FILE_LIMIT = 300;

/** Declarations recorded per file in `atlas.json`. */
const SYMBOLS_PER_FILE = 6;

/**
 * Files rendered in `ATLAS.md`. The markdown is the human overview; the
 * complete ranking lives in `atlas.json`, which tools read.
 */
const MARKDOWN_FILE_LIMIT = 60;

/** Declarations named per file in the markdown table. */
const MARKDOWN_SYMBOLS_PER_FILE = 3;

/** Rank decimals. Fixed so two runs cannot differ in the last bit. */
const RANK_PRECISION = 4;

function round(value: number): number {
  return Number(value.toFixed(RANK_PRECISION));
}

export type {
  AtlasDocument,
  AtlasEdge,
  AtlasFile,
  AtlasManifest,
  AtlasPackage,
  AtlasProjection,
  AtlasSymbol,
};

function relativeFactory(projectRoot: string): (file: string) => string {
  return (file) => {
    const relative = path.relative(projectRoot, file);
    if (!relative || relative.startsWith('..')) return posixIndexPath(file);
    return posixIndexPath(relative);
  };
}

/** sha-256 over the sorted `path\0hash` lines of every indexed file. */
function digestOf(entries: ReadonlyArray<readonly [string, string]>): string {
  const hash = createHash('sha256');
  for (const [file, contentHash] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    hash.update(file);
    hash.update('\u0000');
    hash.update(contentHash);
    hash.update('\n');
  }
  return hash.digest('hex');
}

function renderMarkdown(document: AtlasDocument): string {
  const lines: string[] = [
    '# Codebase Atlas',
    '',
    'Generated from the codebase index. Do not edit by hand — run `/codebase-map --write`.',
    '',
    `- Indexed files: ${document.counts.files}`,
    `- Indexed symbols: ${document.counts.symbols}`,
    `- Packages: ${document.counts.packages}`,
    '',
    'Ranking is PageRank over the reference graph (calls, imports, type references,',
    'inheritance). `1.0000` is the most central file in this repository; the scores',
    'are relative to this repository only.',
    '',
    '## Packages',
    '',
    '| Package | Files | Hub | Rank |',
    '| --- | ---: | --- | ---: |',
  ];
  for (const pkg of document.packages) {
    lines.push(`| ${pkg.name} | ${pkg.files} | \`${pkg.hub}\` | ${pkg.rank.toFixed(4)} |`);
  }

  // The concept layer is optional, so its section exists only when it has run.
  // An empty heading in a committed file is a standing question about whether
  // something broke.
  const described = document.packages.filter((pkg) => pkg.summary !== undefined);
  if (described.length > 0) {
    lines.push('', '## Subsystems', '');
    for (const pkg of described) {
      lines.push(`- **${pkg.name}** — ${pkg.summary}`);
    }
  }

  // Only the head of the ranking is rendered here. `atlas.json` carries all
  // ATLAS_FILE_LIMIT entries with their full declaration lists; repeating that
  // as prose produced a 100 kB document nobody would read, and made every
  // regeneration a very large diff.
  lines.push(
    '',
    `## Most central files (top ${Math.min(MARKDOWN_FILE_LIMIT, document.files.length)} of ${document.files.length})`,
    '',
    `The full ranking, with every declaration, is in \`${ATLAS_JSON}\`.`,
    '',
    '| Rank | File | In | Out | Declarations |',
    '| ---: | --- | ---: | ---: | --- |',
  );
  for (const file of document.files.slice(0, MARKDOWN_FILE_LIMIT)) {
    const declarations = file.symbols
      .slice(0, MARKDOWN_SYMBOLS_PER_FILE)
      .map((symbol) => `\`${symbol.name}\``)
      .join(', ');
    lines.push(
      `| ${file.rank.toFixed(4)} | \`${file.path}\` | ${file.inDeg} | ${file.outDeg} | ${declarations} |`,
    );
  }
  // Trailing newline, LF only: the pre-commit hook normalises line endings and
  // a missing final newline would show as a diff on every regeneration.
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Build the projection from the index. Pure with respect to the filesystem —
 * {@link writeAtlas} is what touches disk.
 */
export function buildAtlas(store: IndexStore, projectRoot: string): AtlasProjection {
  const relativeOf = relativeFactory(projectRoot);
  const stats = store.getStats();
  const packageCounts = store.getPackageFileCounts();
  const ranked: RankedFileRow[] = store.getRankedFiles(ATLAS_FILE_LIMIT);
  const concepts = store.getReadyConceptSummaries();
  const subsystemSummaries = new Map(
    store.getSubsystems().map((subsystem) => [subsystem.id, subsystem.summary]),
  );

  // Package rollup: the hub is the highest-ranked member we saw.
  // `packageNameOf` is the single source of the label, because a file whose
  // `package` column is empty still belongs to a package in this document —
  // and an atlas where a file's package names no package in `packages[]`
  // cannot be filtered, grouped or drawn.
  const packages = new Map<string, AtlasPackage>();
  const packageNameOf = (row: RankedFileRow): string =>
    row.package || relativeOf(row.file).split('/')[0] || '(root)';
  for (const row of ranked) {
    const relative = relativeOf(row.file);
    const name = packageNameOf(row);
    const existing = packages.get(name);
    if (existing === undefined) {
      const summary = subsystemSummaries.get(name);
      packages.set(name, {
        name,
        files: packageCounts.get(row.package) ?? 0,
        hub: relative,
        rank: round(row.rank),
        // Absent rather than empty: an un-enriched repository must project the
        // same bytes it projected before the concept layer existed.
        ...(summary !== undefined && summary !== '' ? { summary } : {}),
      });
      continue;
    }
    if (row.rank > existing.rank) {
      existing.hub = relative;
      existing.rank = round(row.rank);
    }
  }

  // Declarations per file, ordered by position so the list reads like the file.
  const files: AtlasFile[] = ranked.map((row) => {
    const symbols = store
      .getFileSymbols(row.file, SYMBOLS_PER_FILE)
      .map((symbol) => ({ name: symbol.name, kind: symbol.kind, line: symbol.line }));
    const concept = concepts.get(row.file);
    return {
      path: relativeOf(row.file),
      rank: round(row.rank),
      inDeg: row.inDeg,
      outDeg: row.outDeg,
      package: packageNameOf(row),
      symbols,
      ...(concept !== undefined && concept !== '' ? { concept } : {}),
    };
  });

  // Package dependencies, restricted to packages the atlas actually carries so
  // no edge lands on a node the document does not define.
  const known = new Set(packages.keys());
  const edges: AtlasEdge[] = store
    .getPackageGraph()
    .edges.map((edge) => ({
      from: edge.source.replace(/^pkg:/, ''),
      to: edge.target.replace(/^pkg:/, ''),
      weight: edge.weight,
      refType: edge.refType as string,
    }))
    .filter((edge) => known.has(edge.from) && known.has(edge.to))
    .sort(
      (a, b) =>
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to) ||
        a.refType.localeCompare(b.refType),
    );

  const document: AtlasDocument = {
    schema: ATLAS_SCHEMA,
    counts: { files: stats.totalFiles, symbols: stats.totalSymbols, packages: packages.size },
    packages: [...packages.values()].sort(
      (a, b) => b.rank - a.rank || a.name.localeCompare(b.name),
    ),
    edges,
    files,
  };

  const allHashes: Array<readonly [string, string]> = store
    .getAllFileMetas()
    .map((meta) => [relativeOf(meta.file), meta.contentHash ?? ''] as const);
  const atlasPaths = new Set(files.map((file) => file.path));
  const manifestFiles: Record<string, string> = {};
  for (const [file, hash] of [...allHashes].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (atlasPaths.has(file)) manifestFiles[file] = hash;
  }

  const manifest: AtlasManifest = {
    schema: ATLAS_SCHEMA,
    counts: {
      files: document.counts.files,
      symbols: document.counts.symbols,
      tracked: allHashes.length,
    },
    digest: digestOf(allHashes),
    files: manifestFiles,
  };

  return { document, manifest, markdown: renderMarkdown(document) };
}

/** Serialise a value the same way every time: two-space JSON, trailing newline. */
function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export interface WrittenAtlas {
  dir: string;
  files: string[];
  fileCount: number;
  packageCount: number;
}

/** Write the projection into `<projectRoot>/.wrongstack/atlas/`. */
export async function writeAtlas(store: IndexStore, projectRoot: string): Promise<WrittenAtlas> {
  const projection = buildAtlas(store, projectRoot);
  const dir = path.join(projectRoot, ATLAS_DIR);
  await fs.mkdir(dir, { recursive: true });

  const written: Array<[string, string]> = [
    [ATLAS_JSON, stableJson(projection.document)],
    [ATLAS_MANIFEST, stableJson(projection.manifest)],
    [ATLAS_MARKDOWN, projection.markdown],
  ];
  for (const [name, body] of written) {
    await fs.writeFile(path.join(dir, name), body, 'utf8');
  }

  return {
    dir: posixIndexPath(ATLAS_DIR),
    files: written.map(([name]) => name),
    fileCount: projection.document.files.length,
    packageCount: projection.document.packages.length,
  };
}

export interface AtlasFreshness {
  fresh: boolean;
  /** Why it is not fresh. Absent when `fresh`. */
  reason?: 'missing' | 'unreadable' | 'schema' | 'drift' | undefined;
  /** Atlas files whose content hash no longer matches the index. */
  changed: string[];
  /** Atlas files the index no longer knows about. */
  removed: string[];
  /** Indexed files absent from the atlas manifest. */
  added: number;
  /** True when the whole-repository digest still matches. */
  digestMatches: boolean;
}

/** Files listed in a drift report before it is summarised rather than enumerated. */
export const MAX_REPORTED_DRIFT = 20;

/**
 * Compare the committed atlas against the live index.
 *
 * Reads only the manifest — the atlas document and markdown are derived from
 * the same data, so a manifest that matches means all three are current.
 */
export async function checkAtlasFreshness(
  store: IndexStore,
  projectRoot: string,
): Promise<AtlasFreshness> {
  const stale = (reason: AtlasFreshness['reason']): AtlasFreshness => ({
    fresh: false,
    reason,
    changed: [],
    removed: [],
    added: 0,
    digestMatches: false,
  });

  let raw: string;
  try {
    raw = await fs.readFile(path.join(projectRoot, ATLAS_DIR, ATLAS_MANIFEST), 'utf8');
  } catch {
    return stale('missing');
  }

  let manifest: AtlasManifest;
  try {
    manifest = JSON.parse(raw) as AtlasManifest;
  } catch {
    return stale('unreadable');
  }
  if (manifest?.schema !== ATLAS_SCHEMA || typeof manifest.files !== 'object') {
    return stale('schema');
  }

  const relativeOf = relativeFactory(projectRoot);
  const live = new Map<string, string>();
  const allHashes: Array<readonly [string, string]> = [];
  for (const meta of store.getAllFileMetas()) {
    const relative = relativeOf(meta.file);
    const hash = meta.contentHash ?? '';
    live.set(relative, hash);
    allHashes.push([relative, hash] as const);
  }

  const changed: string[] = [];
  const removed: string[] = [];
  for (const [file, hash] of Object.entries(manifest.files)) {
    const current = live.get(file);
    if (current === undefined) {
      removed.push(file);
      continue;
    }
    // An empty hash on either side means the indexer never computed one; that
    // is not evidence of drift, so it is not reported as such.
    if (hash !== '' && current !== '' && hash !== current) changed.push(file);
  }

  const digestMatches = digestOf(allHashes) === manifest.digest;
  // Against `manifest.counts.files` (every indexed file at write time), not
  // against `manifest.files` — that map deliberately holds only the ~300 files
  // the atlas describes, so subtracting it reported the whole repository as
  // newly added the instant a fresh atlas was written.
  // Against `counts.tracked`, the size of the set the digest covers. Comparing
  // against `manifest.files` (only the ~300 files the atlas describes) reported
  // the whole repository as newly added the instant a fresh atlas was written;
  // comparing against `counts.files` mixed two different denominators. A
  // manifest without the field reports no additions rather than a wrong number.
  const tracked =
    typeof manifest.counts?.tracked === 'number' ? manifest.counts.tracked : live.size;
  const added = Math.max(0, live.size - tracked);
  const fresh = digestMatches && changed.length === 0 && removed.length === 0;

  return {
    fresh,
    ...(fresh ? {} : { reason: 'drift' as const }),
    changed: changed.sort().slice(0, MAX_REPORTED_DRIFT),
    removed: removed.sort().slice(0, MAX_REPORTED_DRIFT),
    added,
    digestMatches,
  };
}

/**
 * Project-level entry points.
 *
 * These own the store lifetime so callers outside this package never have to
 * touch `indexStorePool`. Both refuse to run when there is no index yet:
 * opening a store CREATES the database, and neither writing an atlas nor
 * checking one should be the thing that indexes a project.
 */

export type AtlasIndexMissing = { indexed: false };

function hasIndex(projectRoot: string, indexDir: string | undefined): boolean {
  return existsSync(path.join(resolveIndexDir(projectRoot, indexDir), 'index.db'));
}

async function withStore<T>(
  projectRoot: string,
  indexDir: string | undefined,
  job: (store: IndexStore) => Promise<T> | T,
): Promise<T | AtlasIndexMissing> {
  if (!hasIndex(projectRoot, indexDir)) return { indexed: false };
  const store = indexStorePool.acquire(projectRoot, { indexDir });
  try {
    return await job(store);
  } finally {
    indexStorePool.release(store);
  }
}

/** Write the atlas for a project, or report that it has no index yet. */
export function writeProjectAtlas(
  projectRoot: string,
  opts: { indexDir?: string | undefined } = {},
): Promise<WrittenAtlas | AtlasIndexMissing> {
  return withStore(projectRoot, opts.indexDir, (store) => writeAtlas(store, projectRoot));
}

/** Check a project's written atlas against its index. */
export function checkProjectAtlasFreshness(
  projectRoot: string,
  opts: { indexDir?: string | undefined } = {},
): Promise<AtlasFreshness | AtlasIndexMissing> {
  return withStore(projectRoot, opts.indexDir, (store) => checkAtlasFreshness(store, projectRoot));
}

/**
 * Build a project's static HTML atlas, or report that it has no index yet.
 *
 * Returns the markup rather than writing it: where the file belongs is the
 * caller's decision (a CI artifact directory, a temp file the CLI opens, an
 * HTTP response body), and this package should not guess.
 */
export function exportProjectAtlasHtml(
  projectRoot: string,
  opts: { indexDir?: string | undefined; projectName?: string | undefined } = {},
): Promise<string | AtlasIndexMissing> {
  return withStore(projectRoot, opts.indexDir, (store) =>
    renderAtlasHtml(buildAtlas(store, projectRoot).document, {
      projectName: opts.projectName ?? path.basename(projectRoot),
    }),
  );
}

/** Re-exported for callers that render rank rows next to atlas output. */
export type { FileRankRow };
