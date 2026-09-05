import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BenchReport, TaskResult } from '../types.js';

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
  };
  await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
}

/** Read back a summary.json into the partial report shape markdown needs. */
export async function readSummary(
  outDir: string,
): Promise<Pick<BenchReport, 'suite' | 'finishedAt' | 'fingerprint' | 'cells'>> {
  const raw = await fs.readFile(path.join(outDir, 'summary.json'), 'utf8');
  return JSON.parse(raw) as Pick<BenchReport, 'suite' | 'finishedAt' | 'fingerprint' | 'cells'>;
}

/** Load per-(task × cell) rows from a finished run directory. Missing file → []. */
export async function readResultsJsonl(outDir: string): Promise<TaskResult[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(outDir, 'results.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const rows: TaskResult[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      rows.push(JSON.parse(trimmed) as TaskResult);
    } catch {
      // `bench run` streams partial results.jsonl to disk during the run so a
      // crash keeps partial results; a hard-killed write can leave a truncated
      // trailing line. Tolerate it (like readSessionLogEvents) instead of
      // throwing and losing the whole report read.
    }
  }
  return rows;
}

/** Load summary.json plus results.jsonl so a report can be re-rendered or compared. */
export async function readRunDir(outDir: string): Promise<BenchReport> {
  const summary = await readSummary(outDir);
  const results = await readResultsJsonl(outDir);
  return { ...summary, results };
}
