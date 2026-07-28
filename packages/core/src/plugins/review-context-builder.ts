import { spawn } from 'node:child_process';
import type { KanbanTask } from '@wrongstack/kanban';
import type { ChronicleFileLineageRow } from '../chronicle/metrics-store.js';
import { createChronicleProjectAccess } from '../chronicle/project-access.js';
import type {
  ResolvedChimeraConfig,
  ReviewContextBundle,
  ReviewFileEntry,
} from './review-types.js';

// ---------------------------------------------------------------------------
// Git helpers (shared with chimera-plugin.ts, intentionally duplicated
// to keep this module self-contained for testing).
// ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 15_000;
const MAX_DIFF_BYTES = 50_000; // cap individual file diffs to ~50KB
const MAX_RECENT_COMMITS = 10;

async function runGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer | string) => {
      stdout += d;
    });
    child.stderr?.on('data', (d: Buffer | string) => {
      stderr += d;
    });
    child.on('error', () => resolve({ stdout, stderr, code: 1 }));
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

/**
 * Get the unified diff for a single file against HEAD.
 * Returns `undefined` when the file is untracked (added) or git fails.
 */
async function getFileDiff(cwd: string, filePath: string): Promise<string | undefined> {
  const r = await runGit(['diff', 'HEAD', '--', filePath], cwd);
  if (r.code !== 0 || !r.stdout.trim()) return undefined;
  return r.stdout.length > MAX_DIFF_BYTES
    ? `${r.stdout.slice(0, MAX_DIFF_BYTES)}\n... (diff truncated at ${MAX_DIFF_BYTES} bytes)`
    : r.stdout;
}

/**
 * List all changed files in the working tree (porcelain status).
 * Includes both tracked modifications and untracked additions.
 *
 * Uses NUL-delimited porcelain output so Git returns raw path bytes instead of
 * C-style quoted/escaped names. Rename and copy entries contain an additional
 * source-path record; the first record is the destination path we review.
 */
export function parsePorcelainStatusZ(stdout: string): Array<{ path: string; status: string }> {
  const records = stdout.split('\0');
  const out: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.length < 3) continue;
    const statusCode = record.slice(0, 2).trim();
    const filePath = record.slice(3);
    if (filePath) out.push({ path: filePath, status: statusCode });
    if (statusCode.includes('R') || statusCode.includes('C')) index++;
  }
  return out;
}

async function getAllChangedFiles(cwd: string): Promise<Array<{ path: string; status: string }>> {
  const r = await runGit(['status', '--porcelain', '-z'], cwd);
  return r.code === 0 ? parsePorcelainStatusZ(r.stdout) : [];
}

/**
 * Get recent commit messages (oneline), newest first.
 */
async function getRecentCommits(cwd: string): Promise<string[]> {
  const r = await runGit(['log', `-${MAX_RECENT_COMMITS}`, '--oneline', '--format=%s'], cwd);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter(Boolean);
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

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
}

/**
 * Enrich a bare file list with diffs, sibling-change awareness, and
 * recent commit history — the minimal "story" a reviewer needs to
 * judge changes in context rather than in isolation.
 *
 * This is the P0 subset: diffs + siblings + commits.
 * Future additions: todos, kanban card, prompt chain, prior findings.
 *
 * The function never throws — all enrichment is best-effort. If a git
 * operation fails, the corresponding field is simply left `undefined`,
 * and the caller still gets a valid bundle with the original file data.
 */
export async function buildReviewContext(
  opts: BuildReviewContextOptions,
): Promise<ReviewContextBundle> {
  const { cwd, config } = opts;

  // ── Enrich files with diffs ──
  const filesWithDiffs: ReviewFileEntry[] = [];
  for (const f of opts.files) {
    const entry: ReviewFileEntry = {
      path: f.path,
      status: f.status,
      content: f.content,
    };
    if (f.status === 'modified') {
      // Best-effort diff — undefined if git fails or file is untracked
      try {
        entry.diff = await getFileDiff(cwd, f.path);
      } catch {
        // leave diff undefined
      }
    }
    filesWithDiffs.push(entry);
  }

  // ── Sibling changes (all working-tree changes) ──
  let allChangedFiles: Array<{ path: string; status: string }> | undefined;
  try {
    allChangedFiles = await getAllChangedFiles(cwd);
  } catch {
    // leave undefined
  }

  // ── Recent commits ──
  let recentCommits: string[] | undefined;
  try {
    recentCommits = await getRecentCommits(cwd);
    if (recentCommits.length === 0) recentCommits = undefined;
  } catch {
    // leave undefined
  }

  // ── Active todos (passed in from caller) ──
  const activeTodos =
    opts.activeTodos && opts.activeTodos.length > 0 ? opts.activeTodos : undefined;

  // ── Cascade threshold (passed in from caller) ──
  const cascadeOn = opts.cascadeOn ?? undefined;
  const cascadeDepth = opts.cascadeDepth ?? undefined;
  const maxCascadeDepth = opts.maxCascadeDepth ?? undefined;

  // ── Kanban card (P1: find active running/review task across all boards) ──
  let kanbanCard: ReviewContextBundle['kanbanCard'];
  try {
    kanbanCard = await findActiveKanbanCard(cwd);
  } catch {
    // kanban not configured or not installed — leave undefined
  }

  // ── File provenance from Chronicle (P1: last event per file path) ──
  let fileProvenance: ReviewContextBundle['fileProvenance'];
  try {
    const paths = opts.files.map((f) => f.path);
    fileProvenance = await findFileProvenance(cwd, paths);
    if (fileProvenance.length === 0) fileProvenance = undefined;
  } catch {
    // chronicle not configured or journal unreadable — leave undefined
  }

  return {
    config,
    cwd,
    files: filesWithDiffs,
    allChangedFiles,
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
 * Query the Chronicle journal for the most recent event touching each
 * changed file path. Returns agent/session/task attribution so the
 * reviewer knows WHO made the change and in what task context.
 *
 * Uses the canonical per-project Chronicle gateway. Best-effort: returns []
 * if Chronicle isn't available or the journal is empty.
 */
async function findFileProvenance(
  projectRoot: string,
  filePaths: string[],
): Promise<NonNullable<ReviewContextBundle['fileProvenance']>> {
  if (filePaths.length === 0) return [];

  const access = createChronicleProjectAccess({ projectRoot });
  const provenance: NonNullable<ReviewContextBundle['fileProvenance']> = [];
  try {
    // Read the derived SQLite lineage projection in one indexed query. The old
    // loop performed one full reverse scan of every raw Chronicle partition
    // per file — an 80-file review over a multi-GB journal could pin a CPU
    // core and allocate Buffers/strings inside the TUI process for minutes.
    const uniquePaths = [...new Set(filePaths)];
    const result = await access.call('metrics', {
      view: 'files',
      refresh: false,
      files: {
        paths: uniquePaths,
        latestPerPath: true,
        limit: Math.min(10_000, uniquePaths.length),
      },
    });
    const rows = result.data as ChronicleFileLineageRow[];
    const byPath = new Map(
      rows.map((row) => [normalizeReviewPath(row.path), row] as const),
    );
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
  } finally {
    await access.close();
  }
  return provenance;
}

function normalizeReviewPath(filePath: string): string {
  return filePath.replaceAll('\\', '/').toLocaleLowerCase();
}

function lineageEventType(row: ChronicleFileLineageRow): string {
  return row.source === 'external'
    ? `file.external.${row.operation || 'modified'}`
    : 'file.event';
}
