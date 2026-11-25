import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { aggregateAll } from '../aggregate.js';
import type {
  BenchProgress,
  BenchReport,
  HarnessFingerprint,
  ModelCell,
  TaskResult,
} from '../types.js';

/**
 * Write the machine-readable report artifacts:
 *   - results.jsonl  → one line per (task × cell), for reproducibility
 *   - summary.json   → fingerprint + folded cell results
 *
 * The markdown report is derived from summary.json (see report/markdown.ts), so
 * `wstack bench report` can re-render without re-running anything.
 */
export async function writeJsonArtifacts(outDir: string, report: BenchReport): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });

  const jsonl = report.results.map((r) => JSON.stringify(r)).join('\n');
  await fs.writeFile(path.join(outDir, 'results.jsonl'), jsonl + (jsonl ? '\n' : ''), 'utf8');

  const summary = {
    suite: report.suite,
    finishedAt: report.finishedAt,
    fingerprint: report.fingerprint,
    cells: report.cells,
    ...(report.progress ? { progress: report.progress } : {}),
  };
  await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
}

/** Read back a summary.json into the partial report shape markdown needs. */
export async function readSummary(
  outDir: string,
): Promise<Pick<BenchReport, 'suite' | 'finishedAt' | 'fingerprint' | 'cells' | 'progress'>> {
  const raw = await fs.readFile(path.join(outDir, 'summary.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    typeof parsed['suite'] !== 'string' ||
    typeof parsed['finishedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(parsed['finishedAt'])) ||
    !isRecord(parsed['fingerprint']) ||
    !Array.isArray(parsed['cells']) ||
    !parsed['cells'].every(isCellResultRecord)
  ) {
    throw new Error('Benchmark summary has an invalid envelope.');
  }
  return parsed as unknown as Pick<
    BenchReport,
    'suite' | 'finishedAt' | 'fingerprint' | 'cells' | 'progress'
  >;
}

/** Load per-(task × cell) rows from a finished run directory. Missing file → []. */
export async function readResultsJsonl(outDir: string): Promise<TaskResult[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(outDir, 'results.jsonl'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return [];
    throw error;
  }
  const rows: TaskResult[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isTaskResultRecord(parsed)) rows.push(parsed as unknown as TaskResult);
    } catch {
      // `bench run` streams partial results.jsonl to disk during the run so a
      // crash keeps partial results; a hard-killed write can leave a truncated
      // trailing line. Tolerate it (like readSessionLogEvents) instead of
      // throwing and losing the whole report read.
    }
  }
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCellResultRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value['cell']) &&
    typeof value['cell']['label'] === 'string' &&
    value['cell']['label'].length > 0
  );
}

const RUN_STATUSES = new Set([
  'completed',
  'failed',
  'aborted',
  'max_iterations',
  'timeout',
  'crashed',
]);

function isTaskResultRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['taskId'] === 'string' &&
    value['taskId'].length > 0 &&
    isCellResultRecord({ cell: value['cell'] }) &&
    isRecord(value['grade']) &&
    typeof value['grade']['passed'] === 'boolean' &&
    isRecord(value['run']) &&
    typeof value['run']['status'] === 'string' &&
    RUN_STATUSES.has(value['run']['status']) &&
    isRecord(value['tools'])
  );
}

/** Load summary.json plus results.jsonl so a report can be re-rendered or compared. */
export async function readRunDir(outDir: string): Promise<BenchReport> {
  const results = await readResultsJsonl(outDir);
  let summary: Awaited<ReturnType<typeof readSummary>>;
  try {
    summary = await readSummary(outDir);
  } catch (error) {
    // No summary.json: the run was stopped or killed before it finished.
    // run.json, written at its start, still says what it was.
    const manifest = await readRunManifest(outDir);
    if (!manifest) throw error;
    return {
      suite: manifest.suite,
      finishedAt: `unfinished (started ${manifest.startedAt})`,
      fingerprint: manifest.fingerprint,
      cells: aggregateAll(manifest.cells, results),
      results,
      progress: { planned: manifest.planned, completed: results.length, interrupted: true },
    };
  }
  return { ...summary, results };
}

/**
 * Written when a run starts, so a run that never reaches summary.json can
 * still be reported and resumed with the same flags.
 */
export interface RunManifest {
  suite: BenchReport['suite'];
  startedAt: string;
  fingerprint: HarnessFingerprint;
  cells: ModelCell[];
  planned: number;
  /** The `bench run` flags, replayed by `--resume`. */
  flags: Record<string, string | boolean>;
  /** Lean-profile overlay the run used (a prompt-variant menu run). */
  harnessOverlay?: Record<string, unknown> | undefined;
}

export const RUN_MANIFEST_FILE = 'run.json';

export async function writeRunManifest(outDir: string, manifest: RunManifest): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.join(outDir, RUN_MANIFEST_FILE),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
}

export async function readRunManifest(outDir: string): Promise<RunManifest | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await fs.readFile(path.join(outDir, RUN_MANIFEST_FILE), 'utf8'),
    );
    if (
      !isRecord(parsed) ||
      typeof parsed['suite'] !== 'string' ||
      typeof parsed['startedAt'] !== 'string' ||
      !isRecord(parsed['fingerprint']) ||
      !Array.isArray(parsed['cells']) ||
      !Number.isSafeInteger(parsed['planned']) ||
      (parsed['planned'] as number) < 0 ||
      !isRecord(parsed['flags'])
    ) {
      return undefined;
    }
    return parsed as unknown as RunManifest;
  } catch {
    return undefined;
  }
}

/** Planned vs recorded, for a finished or unfinished run directory. */
export function runProgress(report: Pick<BenchReport, 'progress' | 'results'>): BenchProgress {
  const fallback = {
    planned: report.results.length,
    completed: report.results.length,
    interrupted: false,
  };
  const progress = report.progress;
  if (
    !progress ||
    !Number.isSafeInteger(progress.planned) ||
    progress.planned < 0 ||
    !Number.isSafeInteger(progress.completed) ||
    progress.completed < 0 ||
    typeof progress.interrupted !== 'boolean'
  ) {
    return fallback;
  }
  return progress;
}
