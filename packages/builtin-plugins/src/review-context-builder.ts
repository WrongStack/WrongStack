import { createHash } from 'node:crypto';
import type {
  ChronicleFileLineageReader,
  ChronicleFileLineageRow,
} from '@wrongstack/contracts/types/chronicle-metrics';
import type { KanbanTask } from '@wrongstack/kanban';
import { resolveCachedGitIsolation } from './auto-review-git.js';
import { normalizeReviewPath } from './review-candidates.js';
import {
  computeHybridIncrementalDeltaDiff,
  extractSymbolName,
  truncateDiffSurrogateSafe,
} from './review-diff.js';
import { JsonlFindingStore } from './review-finding-store.js';
import {
  findDeletedFileReferences,
  findModifiedExportCallers,
  getAllChangedFiles,
  getFileDiff,
  getHeadAndRecentCommits,
  MAX_DIFF_BYTES,
  resolvePairedTestStatus,
} from './review-git-context.js';
import type {
  ResolvedChimeraConfig,
  ReviewContextBundle,
  ReviewFileEntry,
  ReviewPriorFindingSummary,
  ReviewSkippedFile,
} from './review-types.js';

// Preserve the established imports used by plugins and external consumers.
export { parsePorcelainStatusZ, statusUnderPrefix } from './git-porcelain.js';
export { isIgnoredReviewNoisePath, prioritizeReviewCandidates } from './review-candidates.js';
export {
  type AnnotatedDiffResult,
  annotateUnifiedDiffWithLineNumbers,
  computeHybridIncrementalDeltaDiff,
} from './review-diff.js';
export {
  classifyZeroTokenReviewFastPath,
  type ZeroTokenReviewFastPathVerdict,
} from './review-fast-path.js';
export { extractSessionIntentSnippets } from './review-session-intent.js';

async function loadPriorFindingsForFiles(
  projectDir: string | undefined,
  filePaths: readonly string[],
  extraPriorFindings: readonly ReviewPriorFindingSummary[] | undefined,
): Promise<ReviewPriorFindingSummary[] | undefined> {
  const out: ReviewPriorFindingSummary[] = [];
  const seenKeys = new Set<string>();
  const pushUnique = (entry: ReviewPriorFindingSummary) => {
    const key = `${entry.file ?? ''}:${entry.line ?? 0}:${entry.title.toLowerCase()}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    out.push(entry);
  };

  if (extraPriorFindings) {
    for (const item of extraPriorFindings) pushUnique(item);
  }

  if (projectDir && filePaths.length > 0) {
    try {
      const targetSet = new Set(filePaths.map((p) => normalizeReviewPath(p)));
      const store = new JsonlFindingStore(projectDir);
      const existing = await store.list({ limit: 200 });
      for (const finding of existing) {
        const fPath = finding.location?.file;
        if (!fPath || !targetSet.has(normalizeReviewPath(fPath))) continue;
        // Include active/triaged/in_progress AND operator-suppressed findings
        // (`ignored`, or `resolved` as `wontfix` / `false_positive`) so the
        // reviewer knows not to re-raise suppressed items.
        const outcome = finding.resolution?.outcome;
        const isSuppressed =
          finding.status === 'ignored' ||
          (finding.status === 'resolved' &&
            (outcome === 'wontfix' || outcome === 'false_positive'));
        const isOpen =
          finding.status === 'active' ||
          finding.status === 'triaged' ||
          finding.status === 'in_progress';
        if (!isSuppressed && !isOpen) continue;
        pushUnique({
          id: finding.id,
          severity: finding.severity,
          status: finding.status,
          ...(outcome ? { outcome } : {}),
          file: fPath,
          ...(finding.location?.line !== undefined ? { line: finding.location.line } : {}),
          title: finding.title,
        });
        if (out.length >= 25) break;
      }
    } catch {
      /* best-effort */
    }
  }

  return out.length > 0 ? out : undefined;
}

export interface BuildReviewContextOptions {
  cwd: string;
  config: ResolvedChimeraConfig;
  /** Files to review, with content already read. */
  files: Array<{ path: string; status: 'added' | 'modified'; content: string }>;
  /**
   * Active todo items from the session Context (P1 enrichment).
   * Available from `ctx.todos` in the iteration.completed handler.
   * Passed in by the caller — the builder itself has no ctx access.
   */
  activeTodos?: Array<{ id: string; content: string; status: string }> | undefined;
  /**
   * Bounded user request snippets from this session so the reviewer understands
   * user intent and avoids flagging deliberate choices.
   */
  sessionIntent?: string[] | undefined;
  /**
   * Chronicle file-lineage lookup for provenance (host-bound, see
   * `CHRONICLE_FILE_LINEAGE`). Absent: the bundle carries no provenance.
   */
  fileLineage?: ChronicleFileLineageReader | undefined;
  /**
   * Cascade severity threshold from the auto-review plugin config.
   * Threaded into the bundle so execution.ts and the cascade listener
   * can decide whether findings warrant a follow-up agent. Absent for
   * non-auto-review triggers (chimera plugin, /review slash command).
   */
  cascadeOn?: 'off' | 'critical' | 'high' | undefined;
  /**
   * Current cascade depth (0 = initial review). Increments on each
   * fix+re-review cycle; the cascade stops at maxCascadeDepth.
   */
  cascadeDepth?: number | undefined;
  /**
   * Maximum cascade iterations before the self-correcting loop stops.
   * Default 2. Absent for non-auto-review triggers.
   */
  maxCascadeDepth?: number | undefined;
  /**
   * Earlier completed review snapshots in this session (keyed by path or
   * normalized lowercase path). When a modified file was already reviewed and
   * edited again, `buildReviewContext` emits a compact hybrid delta diff
   * instead of re-sending the entire session diff.
   */
  previousSnapshots?: ReadonlyMap<string, { sha256: string; content: string }> | undefined;
  /**
   * Project metadata directory (`~/.wrongstack/projects/<slug>`) used to look up
   * prior/ignored/wontfix findings on the reviewed files.
   */
  projectDir?: string | undefined;
  /**
   * Files excluded before `buildReviewContext` ran (noise, maxFiles cap,
   * already reviewed, unreadable).
   */
  skippedFiles?: ReviewSkippedFile[] | undefined;
  /**
   * Explicit prior findings (e.g. parent verified findings in a cascade
   * re-review) merged ahead of persisted store findings.
   */
  priorFindings?: ReviewPriorFindingSummary[] | undefined;
  /**
   * Pre-resolved `gitIsolationEnv(cwd)` from the caller so `buildReviewContext`
   * skips spawning duplicate git-config/isolation probes on Windows.
   */
  preResolvedIsolation?: Record<string, string> | null | undefined;
  /**
   * Pre-computed porcelain status entries from the caller so `buildReviewContext`
   * skips spawning a second `git status --porcelain -z` subprocess.
   */
  precomputedChangedFiles?: Array<{ path: string; status: string }> | undefined;
}

/**
 * Enrich a bare file list with line-numbered diffs (or hybrid incremental
 * deltas), symbol & paired-test signals, sibling-change awareness, deleted
 * files, HEAD SHA, prior findings, and recent commit history.
 *
 * The function never throws — all enrichment is best-effort. If a git
 * operation fails, the corresponding field is simply left `undefined`,
 * and the caller still gets a valid bundle with the original file data.
 */
export async function buildReviewContext(
  opts: BuildReviewContextOptions,
): Promise<ReviewContextBundle> {
  const { cwd, config } = opts;

  let isolation: Record<string, string> | null = null;
  if (opts.preResolvedIsolation !== undefined) {
    isolation = opts.preResolvedIsolation;
  } else {
    try {
      isolation = (await resolveCachedGitIsolation(cwd)) ?? null;
    } catch {
      isolation = null;
    }
  }

  const filePaths = opts.files.map((f) => f.path);

  // ── Single parallel wave: git status, git log, per-file git diff, kanban, chronicle & prior findings ──
  const [allChangedFiles, logMeta, rawFileDiffs, kanbanCard, rawFileProvenance, priorFindings] =
    await Promise.all([
      opts.precomputedChangedFiles !== undefined
        ? Promise.resolve(opts.precomputedChangedFiles)
        : getAllChangedFiles(cwd, isolation).catch(() => undefined),
      getHeadAndRecentCommits(cwd, isolation).catch(() => ({
        headSha: undefined,
        recentCommits: undefined,
      })),
      Promise.all(
        opts.files.map((f) =>
          f.status === 'modified'
            ? getFileDiff(cwd, f.path, isolation).catch(() => undefined)
            : Promise.resolve(undefined),
        ),
      ),
      findActiveKanbanCard(cwd).catch(() => undefined),
      findFileProvenance(cwd, filePaths, opts.fileLineage).catch(() => []),
      loadPriorFindingsForFiles(opts.projectDir, filePaths, opts.priorFindings),
    ]);

  const headSha = logMeta.headSha;
  const recentCommits = logMeta.recentCommits;
  const fileProvenance = rawFileProvenance.length > 0 ? rawFileProvenance : undefined;
  const changedPathSet = new Set(
    (allChangedFiles ?? []).map((entry) => normalizeReviewPath(entry.path)),
  );
  const deletedFiles = (allChangedFiles ?? [])
    .filter((entry) => entry.status === 'D' || entry.status.includes('D'))
    .map((entry) => entry.path);

  // ── Enrich files with pre-fetched diffs / hybrid deltas, SHA-256, symbols & paired tests ──
  const modifiedExportCandidates: Array<{ symbol: string; file: string }> = [];
  const filesWithDiffs: ReviewFileEntry[] = await Promise.all(
    opts.files.map(async (f, fileIdx) => {
      const sha256 = createHash('sha256').update(f.content).digest('hex');
      const entry: ReviewFileEntry = {
        path: f.path,
        status: f.status,
        content: f.content,
        sha256,
      };

      const prevSnap =
        opts.previousSnapshots?.get(f.path) ??
        opts.previousSnapshots?.get(f.path.replaceAll('\\', '/').toLowerCase());
      const hasPrevContent = Boolean(
        prevSnap && prevSnap.content.length > 0 && prevSnap.sha256 !== sha256,
      );

      if (f.status === 'modified' || hasPrevContent) {
        const headDiff = rawFileDiffs[fileIdx];

        if (hasPrevContent && prevSnap) {
          const delta = computeHybridIncrementalDeltaDiff(
            prevSnap.content,
            f.content,
            headDiff
              ? {
                  hunkCount: headDiff.hunkCount,
                  addedLines: headDiff.addedLines,
                  removedLines: headDiff.removedLines,
                }
              : undefined,
          );
          if (delta) {
            const capped = truncateDiffSurrogateSafe(delta.annotatedDiff, MAX_DIFF_BYTES);
            entry.diff = capped.text;
            entry.hunkCount = delta.hunkCount;
            entry.addedLines = delta.addedLines;
            entry.removedLines = delta.removedLines;
            entry.diffTruncated = capped.truncated;
            entry.isIncrementalDelta = true;
            entry.unchangedHunkSummary = delta.unchangedHunkSummary;
            if (delta.changedSymbols.length > 0) entry.changedSymbols = delta.changedSymbols;
            for (const sym of delta.modifiedExportedSymbols) {
              modifiedExportCandidates.push({ symbol: sym, file: f.path });
            }
          } else if (headDiff) {
            entry.diff = headDiff.annotatedDiff;
            entry.hunkCount = headDiff.hunkCount;
            entry.addedLines = headDiff.addedLines;
            entry.removedLines = headDiff.removedLines;
            entry.diffTruncated = headDiff.diffTruncated;
            if (headDiff.changedSymbols.length > 0) entry.changedSymbols = headDiff.changedSymbols;
            for (const sym of headDiff.modifiedExportedSymbols) {
              modifiedExportCandidates.push({ symbol: sym, file: f.path });
            }
          }
        } else if (headDiff) {
          entry.diff = headDiff.annotatedDiff;
          entry.hunkCount = headDiff.hunkCount;
          entry.addedLines = headDiff.addedLines;
          entry.removedLines = headDiff.removedLines;
          entry.diffTruncated = headDiff.diffTruncated;
          if (headDiff.changedSymbols.length > 0) entry.changedSymbols = headDiff.changedSymbols;
          for (const sym of headDiff.modifiedExportedSymbols) {
            modifiedExportCandidates.push({ symbol: sym, file: f.path });
          }
        }
      } else if (f.status === 'added') {
        const addedLineList = f.content.replace(/\r\n/g, '\n').split('\n');
        entry.addedLines =
          addedLineList.length > 0 && addedLineList[addedLineList.length - 1] === ''
            ? addedLineList.length - 1
            : addedLineList.length;
        entry.removedLines = 0;
        const symbols = new Set<string>();
        for (const line of addedLineList) {
          const sym = extractSymbolName(line);
          if (sym) {
            symbols.add(sym);
            if (symbols.size >= 16) break;
          }
        }
        if (symbols.size > 0) entry.changedSymbols = [...symbols];
      }

      try {
        const paired = await resolvePairedTestStatus(cwd, f.path, changedPathSet);
        if (paired.pairedTestPath) {
          entry.pairedTestPath = paired.pairedTestPath;
          entry.pairedTestUpdated = paired.pairedTestUpdated;
        }
      } catch {
        // best-effort
      }

      return entry;
    }),
  );

  // ── Active todos & cascade threshold (passed in from caller) ──
  const activeTodos =
    opts.activeTodos && opts.activeTodos.length > 0 ? opts.activeTodos : undefined;
  const cascadeOn = opts.cascadeOn ?? undefined;
  const cascadeDepth = opts.cascadeDepth ?? undefined;
  const maxCascadeDepth = opts.maxCascadeDepth ?? undefined;

  // ── Deleted-file dangling references & modified export callers in parallel (0 git spawns in common case) ──
  const [deletedFileReferences, signatureCallers] = await Promise.all([
    findDeletedFileReferences(cwd, deletedFiles, isolation).catch(() => undefined),
    findModifiedExportCallers(cwd, modifiedExportCandidates, deletedFiles, isolation).catch(
      () => undefined,
    ),
  ]);

  const sessionIntent =
    opts.sessionIntent && opts.sessionIntent.length > 0 ? opts.sessionIntent : undefined;

  return {
    config,
    cwd,
    files: filesWithDiffs,
    allChangedFiles,
    ...(headSha ? { headSha } : {}),
    ...(deletedFiles.length > 0 ? { deletedFiles } : {}),
    ...(deletedFileReferences ? { deletedFileReferences } : {}),
    ...(signatureCallers ? { signatureCallers } : {}),
    ...(sessionIntent ? { sessionIntent } : {}),
    ...(opts.skippedFiles && opts.skippedFiles.length > 0
      ? { skippedFiles: opts.skippedFiles }
      : {}),
    ...(priorFindings ? { priorFindings } : {}),
    recentCommits,
    activeTodos,
    cascadeOn,
    cascadeDepth,
    maxCascadeDepth,
    kanbanCard,
    fileProvenance,
  };
}

// ---------------------------------------------------------------------------
// P1 enrichment: kanban card lookup
// ---------------------------------------------------------------------------

/**
 * Find the active (in_progress/review status or running/review lifecycle stage)
 * kanban task across all boards. Enrichment is safe only when exactly one card
 * is active; concurrent active cards are ambiguous and could attach another
 * task's criteria.
 *
 * Uses dynamic import so the builder doesn't hard-depend on @wrongstack/kanban
 * (which may not be installed in all contexts). Best-effort: returns
 * undefined if kanban isn't available, no boards exist, or the active card
 * cannot be identified unambiguously.
 */
async function findActiveKanbanCard(
  projectRoot: string,
): Promise<ReviewContextBundle['kanbanCard']> {
  let kanbanApi: typeof import('@wrongstack/kanban');
  try {
    kanbanApi = await import('@wrongstack/kanban');
  } catch {
    return undefined; // kanban package not available
  }

  const activeTasks: KanbanTask[] = [];
  const boards = await kanbanApi.listBoards(projectRoot);
  for (const board of boards) {
    const data = await kanbanApi.getBoard(projectRoot, board.id);
    if (!data?.tasks) continue;
    activeTasks.push(
      ...data.tasks.filter(
        (task) =>
          task.status === 'in_progress' ||
          task.status === 'review' ||
          task.lifecycle?.currentStage === 'running' ||
          task.lifecycle?.currentStage === 'review',
      ),
    );
  }

  if (activeTasks.length !== 1) return undefined;
  const task = activeTasks[0];
  if (!task) return undefined;
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    successCriteria: task.successCriteria?.map((criterion) => criterion.description),
  };
}

// ---------------------------------------------------------------------------
// P1 enrichment: Chronicle file provenance
// ---------------------------------------------------------------------------

/**
 * Most recent Chronicle event touching each changed file path: agent/task
 * attribution so the reviewer knows WHO made the change and in what task
 * context. The lineage reader is host-bound (`CHRONICLE_FILE_LINEAGE`); without
 * one there is no provenance. Provenance enriches a review, it never gates one.
 */
async function findFileProvenance(
  projectRoot: string,
  filePaths: string[],
  readLineage: ChronicleFileLineageReader | undefined,
): Promise<NonNullable<ReviewContextBundle['fileProvenance']>> {
  if (filePaths.length === 0 || !readLineage) return [];
  const uniquePaths = [...new Set(filePaths)];
  const rows = await readLineage(projectRoot, uniquePaths);
  const byPath = new Map(rows.map((row) => [normalizeReviewPath(row.path), row] as const));
  const provenance: NonNullable<ReviewContextBundle['fileProvenance']> = [];
  for (const filePath of uniquePaths) {
    const row = byPath.get(normalizeReviewPath(filePath));
    if (!row) continue;
    provenance.push({
      path: filePath,
      agentId: row.agentId || undefined,
      taskId: row.taskId || undefined,
      eventType: lineageEventType(row),
      observedAt: row.occurredAt,
    });
  }
  return provenance;
}

function lineageEventType(row: ChronicleFileLineageRow): string {
  return row.source === 'external' ? `file.external.${row.operation || 'modified'}` : 'file.event';
}
