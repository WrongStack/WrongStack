import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { aggregateAll } from '../src/aggregate.js';
import { compareReports } from '../src/compare.js';
import { computeHarnessFingerprint } from '../src/fingerprint.js';
import { readRunDir, writeJsonArtifacts, writeRunManifest } from '../src/report/json.js';
import { renderComparisonMarkdown } from '../src/report/markdown.js';
import type { BenchReport, TaskResult } from '../src/types.js';

const cell = { label: 'example', provider: 'fixture', model: 'example' };
const finishedAt = '2026-01-01T00:00:00.000Z';
const fingerprint = computeHarnessFingerprint({
  cliVersion: '1.7.21',
  toolNames: [],
  maxIterations: 1,
  yolo: true,
  subsetId: 'smoke:two-tasks',
});

function row(taskId: string, passed: boolean): TaskResult {
  return {
    taskId,
    cell,
    run: {
      status: 'completed',
      finalText: '',
      iterations: 1,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      elapsedMs: 1,
      exitCode: 0,
    },
    grade: { passed },
    tools: { totalCalls: 0, editCalls: 0, editErrors: 0, rateLimitRetries: 0 },
  };
}

function report(results: TaskResult[]): BenchReport {
  return { suite: 'smoke', finishedAt, fingerprint, cells: aggregateAll([cell], results), results };
}

it.each(['finished', 'baseline', 'candidate'] as const)(
  'reports comparability honestly with %s run state',
  async (interrupted) => {
    const dir = await mkdtemp(join(tmpdir(), 'compare-fixture-'));
    try {
      const left = join(dir, 'baseline');
      const right = join(dir, 'candidate');
      const baseline = row('smoke/a', false);
      const candidate = row('smoke/a', true);
      for (const [side, path, result] of [
        ['baseline', left, baseline],
        ['candidate', right, candidate],
      ] as const) {
        if (side === interrupted) {
          await writeRunManifest(path, {
            suite: 'smoke',
            startedAt: finishedAt,
            fingerprint,
            cells: [cell],
            planned: 2,
            flags: {},
          });
          await writeFile(join(path, 'results.jsonl'), `${JSON.stringify(result)}\n`);
        } else {
          await writeJsonArtifacts(path, report([result, row('smoke/b', true)]));
        }
      }
      const comparison = compareReports(await readRunDir(left), await readRunDir(right));
      expect(comparison.sharedTaskCount).toBe(interrupted === 'finished' ? 2 : 1);
      expect(comparison.flipped.map((flip) => flip.taskId)).toEqual(['smoke/a']);
      expect(comparison.comparable).toBe(interrupted === 'finished');
      const markdown = renderComparisonMarkdown(comparison);
      if (interrupted === 'finished') {
        expect(markdown).toContain('**Comparable:** harness fingerprints match');
      } else {
        expect(markdown).toContain('**Not comparable:**');
        expect(markdown).toContain(`${interrupted} run incomplete (1/2 attempts recorded)`);
        expect(markdown).not.toContain('harness fingerprints differ');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
