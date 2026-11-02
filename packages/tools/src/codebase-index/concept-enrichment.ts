/**
 * The concept-layer enrichment pass.
 *
 * Walks the index's files most-central-first and asks a model, once per file,
 * what the file is for. The answer is a short plain-English summary plus a
 * **crux**: the line span that actually carries the file's meaning. A summary
 * can drift from the truth; a pointer into the source cannot, so the two are
 * always stored together.
 *
 * ## Why this is a separate pass
 *
 * Model calls take seconds. `runIndexerAtomic` is a SQLite write transaction —
 * holding one open across thousands of network round trips would block every
 * other writer for the duration and roll the whole thing back on the first
 * failure. So enrichment runs on its own, outside the indexer, writing each
 * result as it arrives.
 *
 * ## Why it is affordable
 *
 * `files.content_hash` already exists and is exactly the right cache key: a
 * file whose bytes have not changed is never re-sent. A first pass over this
 * repository is thousands of calls; every pass after it is only the files that
 * actually changed. That is the difference between a one-off cost and a
 * recurring one.
 *
 * ## Why it never takes the caller down
 *
 * Enrichment is an optional layer over a working index. A model that refuses,
 * times out, or returns something unparseable degrades one file's summary — it
 * is recorded in `errors` and the walk continues. Cancellation is honoured
 * between files, and everything already written stays written.
 */

import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isTestFilePath } from './codebase-impact-analysis-tool.js';
import {
  classifyIncrementalUpdateStrategy,
  type IncrementalUpdateStrategy,
} from './fingerprint.js';
import { detectLang } from './languages.js';
import { detectStoreFileCommunities } from './louvain.js';
import { type IndexStore, indexStorePool } from './writer.js';
import {
  type ConceptEdge,
  type FileConcept,
  isConceptRelation,
  normalizeConceptRelation,
  normalizeTestConceptEdge,
} from './writer-concepts.js';
import { posixIndexPath, resolveIndexDir } from './writer-helpers.js';
import { IndexOwnedExternallyError, isOwnedByWrongIndex } from './wrongindex/owner-lock.js';

/** What the summariser is given about one file. */
export interface SummarizeFileInput {
  /** Project-relative path, for the model's benefit. */
  file: string;
  /** Absolute path, if the summariser wants to read more itself. */
  absolutePath: string;
  language: string;
  /** File source, already truncated to {@link MAX_SOURCE_CHARS}. */
  source: string;
  /** Whether `source` was cut short. */
  truncated: boolean;
  /** Declarations the index recorded, as orientation. */
  declarations: ReadonlyArray<{ name: string; kind: string; line: number }>;
  /**
   * 1-hop imported/referenced neighbor files and their top exported symbols,
   * allowing the summariser to understand cross-file contracts without reading
   * neighbor files from disk.
   */
  neighborExports?: ReadonlyArray<{ file: string; symbols: readonly string[] }> | undefined;
  /** A previous, now-outdated summary, when one exists. */
  staleSummary?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface SummarizeFileResult {
  /** One or two sentences on what the file is for. */
  summary: string;
  /** 1-based inclusive line span of the load-bearing lines. */
  cruxStart?: number | undefined;
  cruxEnd?: number | undefined;
  /** Model identifier, recorded so a later pass can tell what produced this. */
  model?: string | undefined;
}

export interface SummarizeSubsystemInput {
  /** Package or directory label. */
  name: string;
  files: ReadonlyArray<{ file: string; summary: string; rank: number }>;
  /** Known peer subsystem names so the model can emit valid target relations. */
  neighborSubsystems?: readonly string[] | undefined;
  signal?: AbortSignal | undefined;
}

export interface SummarizeSubsystemResult {
  summary: string;
  /**
   * Other subsystem names this one relates to, with a relation from the closed
   * vocabulary. Unknown relations and unknown targets are dropped by the caller.
   */
  relations?: ReadonlyArray<{ to: string; relation: string }> | undefined;
  model?: string | undefined;
}

/**
 * The host-supplied model transport.
 *
 * Injected rather than imported: producing a summary needs a configured
 * provider and the model-tier policy, both of which live in the host. This
 * mirrors how SAGE takes `getLlmCall` — `packages/tools` stays free of
 * provider wiring, and a host that supplies no port simply gets no concepts.
 */
export interface SummarizerPort {
  describeFile(input: SummarizeFileInput): Promise<SummarizeFileResult | null>;
  describeSubsystem?(input: SummarizeSubsystemInput): Promise<SummarizeSubsystemResult | null>;
}

/** Source sent per file. Enough for a summary; short enough to stay cheap. */
export const MAX_SOURCE_CHARS = 12_000;

/** Crux span ceiling. Graft uses twelve lines; longer stops being a pointer. */
export const MAX_CRUX_LINES = 12;

/** Declarations offered as orientation alongside the source. */
const MAX_DECLARATIONS = 24;

export const DEFAULT_CONCURRENCY = 5;

/** Summary length ceiling, so one verbose model cannot bloat the layer. */
export const MAX_SUMMARY_CHARS = 400;

export interface EnrichOptions {
  /** Stop after this many files. The natural way to sample the cost first. */
  maxFiles?: number | undefined;
  /** Files summarised in parallel. */
  concurrency?: number | undefined;
  /** Re-summarise files whose summary is already current. */
  force?: boolean | undefined;
  /** Also derive the subsystem layer, when the port supports it. */
  subsystems?: boolean | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((done: number, total: number) => void) | undefined;
}

export interface EnrichResult {
  /** Files sent to the model. */
  summarised: number;
  /** Files skipped because their stored summary already matched. */
  cached: number;
  /** Files the model declined or failed on. */
  failed: number;
  /** Concepts marked stale before the walk started. */
  markedStale: number;
  /** Concepts dropped because their file left the index. */
  pruned: number;
  subsystems: number;
  /** Incremental update strategy selected from the structural change volume. */
  updateStrategy?: IncrementalUpdateStrategy | undefined;
  durationMs: number;
  errors: string[];
}

/** Clamp a model-proposed crux to a real, bounded span inside the file. */
function normaliseCrux(
  result: SummarizeFileResult,
  lineCount: number,
): { start: number | null; end: number | null } {
  const rawStart = result.cruxStart;
  const rawEnd = result.cruxEnd;
  if (typeof rawStart !== 'number' || !Number.isFinite(rawStart)) return { start: null, end: null };
  const start = Math.max(1, Math.min(Math.trunc(rawStart), lineCount));
  const proposedEnd =
    typeof rawEnd === 'number' && Number.isFinite(rawEnd) ? Math.trunc(rawEnd) : start;
  const end = Math.max(start, Math.min(proposedEnd, lineCount, start + MAX_CRUX_LINES - 1));
  return { start, end };
}

/**
 * Run one enrichment pass.
 *
 * `relativeOf` is injected for the same reason the retrieval walk takes it —
 * the caller owns what "project-relative" means, and this module stays free of
 * path policy.
 */
export async function enrichConcepts(
  store: IndexStore,
  port: SummarizerPort,
  relativeOf: (file: string) => string,
  options: EnrichOptions = {},
): Promise<EnrichResult> {
  const startedAt = Date.now();
  const errors: string[] = [];
  const signal = options.signal;
  // A non-finite value made Math.max/min return NaN, which started ZERO
  // workers: the pass "succeeded" having summarised nothing.
  const requestedConcurrency = Number.isFinite(options.concurrency)
    ? Math.trunc(options.concurrency as number)
    : DEFAULT_CONCURRENCY;
  const concurrency = Math.max(1, Math.min(requestedConcurrency, 16));
  const maxFiles =
    options.maxFiles !== undefined && Number.isFinite(options.maxFiles)
      ? Math.max(0, Math.trunc(options.maxFiles))
      : undefined;

  // Housekeeping first, so the walk sees an accurate picture of what is
  // outstanding rather than re-summarising files that already match.
  const pruned = store.pruneOrphanConcepts();
  const markedStale = store.markStaleConcepts();

  const hashByFile = new Map<string, string>();
  for (const meta of store.getAllFileMetas()) hashByFile.set(meta.file, meta.contentHash ?? '');

  const existing = new Map<string, FileConcept>();
  for (const concept of store.getAllFileConcepts()) existing.set(concept.file, concept);

  // Rank decides the ORDER, never the membership. `file_rank` only contains
  // files the reference graph reached, so driving the walk from it would make
  // every unreferenced module — leaf files, scripts, config — permanently
  // invisible to enrichment. Every indexed file is a candidate; the most
  // central ones simply go first, so a budget that runs out runs out on the
  // files fewest people will ever open.
  const rankOf = new Map<string, number>();
  for (const row of store.getRankedFiles(hashByFile.size || 1)) rankOf.set(row.file, row.rank);
  const ordered = [...hashByFile.keys()].sort(
    (a, b) => (rankOf.get(b) ?? 0) - (rankOf.get(a) ?? 0) || a.localeCompare(b),
  );

  const queue: string[] = [];
  let cached = 0;
  for (const file of ordered) {
    // Checked before queueing: `maxFiles: 0` used to queue (and pay for) one file.
    if (maxFiles !== undefined && queue.length >= maxFiles) break;
    const hash = hashByFile.get(file);
    if (hash === undefined) continue;
    const concept = existing.get(file);
    const current =
      concept !== undefined && concept.state === 'ready' && concept.contentHash === hash;
    if (current && options.force !== true) {
      cached++;
      continue;
    }
    queue.push(file);
  }

  const updateStrategy = classifyIncrementalUpdateStrategy(queue.length);
  const neighborExportsByFile =
    queue.length > 0 ? buildNeighborExportsMap(store, queue, relativeOf) : new Map();

  let summarised = 0;
  let failed = 0;
  let done = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      const index = cursor++;
      const file = queue[index];
      if (file === undefined) return;

      try {
        const result = await summariseOne(
          store,
          port,
          relativeOf,
          file,
          hashByFile,
          existing,
          neighborExportsByFile.get(file),
          signal,
        );
        if (result === 'skipped') failed++;
        else summarised++;
      } catch (error) {
        failed++;
        if (errors.length < 50) {
          errors.push(
            `${relativeOf(file)}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } finally {
        done++;
        options.onProgress?.(done, queue.length);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));

  let subsystems = 0;
  const shouldDeriveSubsystems =
    options.subsystems === true &&
    port.describeSubsystem !== undefined &&
    signal?.aborted !== true &&
    (options.force === true ||
      updateStrategy !== 'SKIP_COSMETIC' ||
      store.getSubsystems().length === 0);
  if (shouldDeriveSubsystems) {
    try {
      subsystems = await deriveSubsystems(store, port, relativeOf, signal);
    } catch (error) {
      errors.push(`subsystems: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    summarised,
    cached,
    failed,
    markedStale,
    pruned,
    subsystems,
    updateStrategy,
    durationMs: Date.now() - startedAt,
    errors,
  };
}

/**
 * Precompute 1-hop outgoing neighbor files and their top exported declarations
 * for every queued file so `describeFile` receives cross-file contracts without
 * reading neighbor files from disk.
 */
function buildNeighborExportsMap(
  store: IndexStore,
  queuedFiles: readonly string[],
  relativeOf: (file: string) => string,
): Map<string, ReadonlyArray<{ file: string; symbols: readonly string[] }>> {
  const result = new Map<string, ReadonlyArray<{ file: string; symbols: readonly string[] }>>();
  const queuedSet = new Set(queuedFiles);
  const neighborsByFrom = new Map<string, Set<string>>();

  const fileBySymbolId = new Map<number, string>();
  for (const sym of store.getAllSymbols()) {
    fileBySymbolId.set(sym.id, sym.file);
  }

  for (const ref of store.getAllResolvedRefs()) {
    const fromFile = fileBySymbolId.get(ref.fromId);
    const toFile = fileBySymbolId.get(ref.toId);
    if (!fromFile || !toFile || fromFile === toFile || !queuedSet.has(fromFile)) continue;
    let set = neighborsByFrom.get(fromFile);
    if (!set) {
      set = new Set();
      neighborsByFrom.set(fromFile, set);
    }
    if (set.size < 8) set.add(toFile);
  }

  const symbolCache = new Map<string, readonly string[]>();
  for (const [fromFile, neighbors] of neighborsByFrom) {
    const entries: Array<{ file: string; symbols: readonly string[] }> = [];
    for (const neighborFile of neighbors) {
      let syms = symbolCache.get(neighborFile);
      if (!syms) {
        const rawSyms = store.getFileSymbols(neighborFile, 16);
        const exported = rawSyms.filter((s) => s.isExported === true);
        syms = (exported.length > 0 ? exported : rawSyms)
          .slice(0, 12)
          .map((s) => s.name)
          .filter(Boolean);
        symbolCache.set(neighborFile, syms);
      }
      if (syms.length > 0) {
        entries.push({ file: relativeOf(neighborFile), symbols: syms });
      }
    }
    if (entries.length > 0) {
      result.set(fromFile, entries);
    }
  }

  return result;
}

/** Summarise one file and write it. Returns 'skipped' when nothing was stored. */
async function summariseOne(
  store: IndexStore,
  port: SummarizerPort,
  relativeOf: (file: string) => string,
  file: string,
  hashByFile: ReadonlyMap<string, string>,
  existing: ReadonlyMap<string, FileConcept>,
  neighborExports: ReadonlyArray<{ file: string; symbols: readonly string[] }> | undefined,
  signal: AbortSignal | undefined,
): Promise<'stored' | 'skipped'> {
  let source: string;
  try {
    source = await fs.readFile(file, 'utf8');
  } catch {
    // Indexed but gone from disk: the next index run will prune it.
    return 'skipped';
  }
  if (source.trim().length === 0) return 'skipped';

  const truncated = source.length > MAX_SOURCE_CHARS;
  const declarations = store
    .getFileSymbols(file, MAX_DECLARATIONS)
    .map((symbol) => ({ name: symbol.name, kind: symbol.kind, line: symbol.line }));
  const stale = existing.get(file);

  const result = await port.describeFile({
    file: relativeOf(file),
    absolutePath: file,
    language: detectLang(file) ?? '',
    source: truncated ? source.slice(0, MAX_SOURCE_CHARS) : source,
    truncated,
    declarations,
    ...(neighborExports !== undefined && neighborExports.length > 0 ? { neighborExports } : {}),
    ...(stale !== undefined && stale.summary !== '' ? { staleSummary: stale.summary } : {}),
    signal,
  });

  const summary = result?.summary?.trim() ?? '';
  if (summary.length === 0) return 'skipped';

  const lineCount = source.split('\n').length;
  const crux = normaliseCrux(result as SummarizeFileResult, lineCount);
  store.upsertFileConcept({
    file,
    contentHash: hashByFile.get(file) ?? '',
    signatureHash: store.getFileStructuralFingerprint(file),
    summary: summary.slice(0, MAX_SUMMARY_CHARS),
    cruxStart: crux.start,
    cruxEnd: crux.end,
    state: 'ready',
    model: result?.model ?? '',
    updatedAt: Date.now(),
  });
  return 'stored';
}

/** Files offered to the subsystem summariser per package. */
const SUBSYSTEM_FILE_SAMPLE = 12;

/**
 * Derive one subsystem per package from the file summaries already stored.
 *
 * Runs on summaries rather than source: the per-file pass has already paid to
 * read the code, and asking a model to re-read a whole package would cost far
 * more for a worse answer.
 */
async function deriveSubsystems(
  store: IndexStore,
  port: SummarizerPort,
  relativeOf: (file: string) => string,
  signal: AbortSignal | undefined,
): Promise<number> {
  const describe = port.describeSubsystem;
  if (describe === undefined) return 0;

  const summaries = store.getReadyConceptSummaries();
  if (summaries.size === 0) return 0;

  // Membership comes from the summaries themselves; rank only orders the
  // sample. Driving it from the top `2 × summaries` ranked files dropped every
  // summarised file outside that slice — unranked leaf files always, and after
  // a force or incremental pass most of what had just been paid for.
  const rankOf = store.getFileRankMap();
  const packageOf = store.getFilePackages();
  const ordered = [...summaries.keys()].sort(
    (a, b) => (rankOf.get(b) ?? 0) - (rankOf.get(a) ?? 0) || a.localeCompare(b),
  );
  const byPackage = new Map<string, Array<{ file: string; summary: string; rank: number }>>();
  for (const file of ordered) {
    const summary = summaries.get(file);
    if (summary === undefined) continue;
    const name = packageOf.get(file) || relativeOf(file).split('/')[0] || '(root)';
    const bucket = byPackage.get(name);
    const entry = { file: relativeOf(file), summary, rank: rankOf.get(file) ?? 0 };
    if (bucket === undefined) byPackage.set(name, [entry]);
    else if (bucket.length < SUBSYSTEM_FILE_SAMPLE) bucket.push(entry);
  }

  // When a single-package repository collapses all files into one coarse bucket
  // (e.g. `src` or `(root)`), refine the partition using deterministic Louvain
  // community clustering over the call/import graph so subsystems reflect true
  // architectural modules.
  if (byPackage.size <= 1 && ordered.length >= 4) {
    const communities = detectStoreFileCommunities(store, relativeOf);
    if (communities.length >= 2) {
      const communityByRelFile = new Map<string, string>();
      for (const comm of communities) {
        for (const member of comm.files) {
          communityByRelFile.set(member, comm.label);
        }
      }
      byPackage.clear();
      for (const file of ordered) {
        const summary = summaries.get(file);
        if (summary === undefined) continue;
        const rel = relativeOf(file);
        const name =
          communityByRelFile.get(rel) || packageOf.get(file) || rel.split('/')[0] || '(root)';
        const bucket = byPackage.get(name);
        const entry = { file: rel, summary, rank: rankOf.get(file) ?? 0 };
        if (bucket === undefined) byPackage.set(name, [entry]);
        else if (bucket.length < SUBSYSTEM_FILE_SAMPLE) bucket.push(entry);
      }
    }
  }

  const names = [...byPackage.keys()].sort();
  const known = new Set(names);
  const isTestSub = (subId: string): boolean => {
    const members = byPackage.get(subId);
    if (!members || members.length === 0) return isTestFilePath(subId);
    const testCount = members.filter((m) => isTestFilePath(m.file)).length;
    return testCount > members.length / 2;
  };
  const subsystems = [];
  const edges = [];

  for (const name of names) {
    if (signal?.aborted) break;
    const files = byPackage.get(name) ?? [];
    const neighborSubsystems = names.filter((n) => n !== name);
    const result = await describe({ name, files, neighborSubsystems, signal });
    const summary = result?.summary?.trim() ?? '';
    if (summary.length === 0) continue;
    subsystems.push({
      id: name,
      name,
      summary: summary.slice(0, MAX_SUMMARY_CHARS),
      memberFiles: files.map((f) => f.file),
      model: result?.model ?? '',
      updatedAt: Date.now(),
    });
    for (const relation of result?.relations ?? []) {
      // Relations to subsystems we did not derive, and verbs outside the closed
      // vocabulary (after synonym normalization), are dropped rather than stored
      // as dangling edges.
      if (!known.has(relation.to) || relation.to === name) continue;
      const canonical = isConceptRelation(relation.relation)
        ? relation.relation
        : normalizeConceptRelation(relation.relation);
      if (!canonical) continue;
      edges.push(
        normalizeTestConceptEdge(
          { fromId: name, toId: relation.to, relation: canonical },
          isTestSub,
        ),
      );
    }
  }

  if (subsystems.length >= 2) {
    const recovered = recoverSubsystemConceptEdges(store, byPackage, edges);
    edges.push(...recovered);
  }

  store.replaceSubsystems(subsystems, edges);
  return subsystems.length;
}

/**
 * Deterministic Import/Ref Recovery for subsystem concept edges:
 * When two derived subsystems have concrete package-graph or file-graph
 * references between them that the LLM summarizer omitted, recover a canonical
 * `uses` edge so architectural dependencies are never lost.
 */
export function recoverSubsystemConceptEdges(
  store: IndexStore,
  bySubsystem: ReadonlyMap<string, ReadonlyArray<{ file: string }>>,
  existingEdges: readonly ConceptEdge[],
): ConceptEdge[] {
  const known = new Set(bySubsystem.keys());
  if (known.size < 2) return [];

  const seenPairs = new Set<string>(existingEdges.map((e) => `${e.fromId}\u0000${e.toId}`));
  const recovered: ConceptEdge[] = [];

  for (const pkgEdge of store.getPackageGraph().edges) {
    const fromId = pkgEdge.source.replace(/^pkg:/, '');
    const toId = pkgEdge.target.replace(/^pkg:/, '');
    if (fromId === toId || !known.has(fromId) || !known.has(toId)) continue;
    const pairKey = `${fromId}\u0000${toId}`;
    if (!seenPairs.has(pairKey)) {
      seenPairs.add(pairKey);
      recovered.push({ fromId, toId, relation: 'uses' });
    }
  }

  // Also recover cross-subsystem edges from resolved file-level references
  // (essential when subsystems are partitioned via Louvain communities in a
  // single-package repository).
  const subsystemByMemberPath = new Map<string, string>();
  for (const [subName, members] of bySubsystem) {
    for (const m of members) {
      subsystemByMemberPath.set(m.file.replace(/\\/g, '/'), subName);
    }
  }
  const matchSubsystem = (rawPath: string): string | undefined => {
    const norm = rawPath.replace(/\\/g, '/');
    const direct = subsystemByMemberPath.get(norm);
    if (direct) return direct;
    for (const [relFile, subName] of subsystemByMemberPath) {
      if (norm.endsWith(`/${relFile}`)) return subName;
    }
    return undefined;
  };
  const fileBySymbolId = new Map<number, string>();
  for (const sym of store.getAllSymbols()) {
    fileBySymbolId.set(sym.id, sym.file);
  }
  for (const refEdge of store.getAllResolvedRefs()) {
    const fromFile = fileBySymbolId.get(refEdge.fromId);
    const toFile = fileBySymbolId.get(refEdge.toId);
    if (!fromFile || !toFile) continue;
    const fromSub = matchSubsystem(fromFile);
    const toSub = matchSubsystem(toFile);
    if (!fromSub || !toSub || fromSub === toSub) continue;
    const pairKey = `${fromSub}\u0000${toSub}`;
    if (!seenPairs.has(pairKey)) {
      seenPairs.add(pairKey);
      recovered.push({ fromId: fromSub, toId: toSub, relation: 'uses' });
    }
  }

  return recovered;
}

/** Reported when a project has no index to enrich. */
export type ConceptIndexMissing = { indexed: false };

/**
 * Enrich a project's concept layer, owning the store lifetime so callers
 * outside this package never touch `indexStorePool`.
 *
 * Refuses to run without an existing index: opening a store CREATES the
 * database, and spending money summarising an empty index helps nobody.
 */
export async function enrichProjectConcepts(
  projectRoot: string,
  port: SummarizerPort,
  options: EnrichOptions & { indexDir?: string | undefined } = {},
): Promise<EnrichResult | ConceptIndexMissing> {
  const { indexDir, ...rest } = options;
  if (!existsSync(path.join(resolveIndexDir(projectRoot, indexDir), 'index.db'))) {
    return { indexed: false };
  }
  if (isOwnedByWrongIndex(resolveIndexDir(projectRoot, indexDir))) {
    throw new IndexOwnedExternallyError(resolveIndexDir(projectRoot, indexDir));
  }
  const store = indexStorePool.acquire(projectRoot, { indexDir });
  try {
    return await enrichConcepts(
      store,
      port,
      (file) => {
        const relative = path.relative(projectRoot, file);
        // Canonical escape test (paths.ts escapesRoot): a legal in-root
        // first segment like `..configs` is not a parent traversal; a bare
        // startsWith('..') misread it and displayed the absolute path.
        const inside =
          relative !== '' &&
          relative !== '..' &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative);
        const chosen = inside ? relative : file;
        return posixIndexPath(chosen);
      },
      rest,
    );
  } finally {
    indexStorePool.release(store);
  }
}
