import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { failureHint, heartbeatLine, resultSummary } from '../src/orchestrate.js';
import { readResultsJsonl, readRunManifest, readSummary, runProgress } from '../src/report/json.js';
import { crashDetail, errorMessage } from '../src/runner.js';

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(join(tmpdir(), 'bench-boundary-'));
  roots.push(value);
  return value;
};
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

const cell = { label: 'x', provider: 'p', model: 'm' };
const run = {
  status: 'completed',
  finalText: null,
  iterations: 1,
  tokensIn: 1,
  tokensOut: 1,
  costUsd: 1,
  elapsedMs: 1_000,
  exitCode: 0,
};
const tools = { totalCalls: 1, editCalls: 0, editErrors: 0, rateLimitRetries: 0 };
const validRow = { taskId: 't', cell, run, grade: { passed: true }, tools };

describe('bench boundary normalization audit regressions', () => {
  it('does not split surrogate pairs in parsed error messages', () => {
    expect(hasLoneSurrogate(errorMessage({ message: `${'a'.repeat(499)}😀` }) ?? '')).toBe(false);
  });

  it('does not split surrogate pairs in failure hints', () => {
    expect(hasLoneSurrogate(failureHint(`${'a'.repeat(156)}😀tail`))).toBe(false);
  });

  it('does not start crash tails with a lone low surrogate', () => {
    expect(hasLoneSurrogate(crashDetail(1, `😀${'a'.repeat(1999)}`, ''))).toBe(false);
  });

  it('normalizes non-finite heartbeat times', () => {
    const text = heartbeatLine({
      completed: 0,
      planned: 1,
      finishedThisRun: 0,
      inflight: new Map([['x', 0]]),
      now: Number.POSITIVE_INFINITY,
      startedAt: 0,
    });
    expect(text).not.toMatch(/NaN|Infinity/u);
  });

  it('normalizes non-finite elapsed time in result summaries', () => {
    expect(
      resultSummary({ ...run, elapsedMs: Number.POSITIVE_INFINITY } as never, undefined, 1),
    ).not.toMatch(/NaN|Infinity/u);
  });

  it('normalizes non-finite token metrics in result summaries', () => {
    expect(
      resultSummary(run as never, { total: Number.POSITIVE_INFINITY, input: 1, cacheRead: 1 }, 1),
    ).not.toMatch(/NaN|Infinity/u);
  });

  it('omits non-finite costs from result summaries', () => {
    expect(
      resultSummary({ ...run, costUsd: Number.POSITIVE_INFINITY } as never, undefined, 1),
    ).not.toMatch(/NaN|Infinity/u);
  });

  it('rejects non-finite manifest plan counts', async () => {
    const dir = root();
    writeFileSync(
      join(dir, 'run.json'),
      '{"suite":"s","startedAt":"2026-01-01T00:00:00Z","fingerprint":{},"cells":[],"planned":1e999,"flags":{}}',
    );
    await expect(readRunManifest(dir)).resolves.toBeUndefined();
  });

  it('rejects invalid summary completion timestamps', async () => {
    const dir = root();
    writeFileSync(
      join(dir, 'summary.json'),
      JSON.stringify({ suite: 's', finishedAt: 'not-a-date', fingerprint: {}, cells: [{ cell }] }),
    );
    await expect(readSummary(dir)).rejects.toThrow(/invalid envelope/u);
  });

  it('rejects incomplete persisted result rows', async () => {
    const dir = root();
    writeFileSync(
      join(dir, 'results.jsonl'),
      `${JSON.stringify({ taskId: 't', cell, run: {}, grade: {}, tools: {} })}\n`,
    );
    await expect(readResultsJsonl(dir)).resolves.toEqual([]);
  });

  it('falls back from invalid persisted progress counters', () => {
    expect(
      runProgress({
        progress: { planned: -1, completed: Number.POSITIVE_INFINITY, interrupted: false },
        results: [validRow],
      } as never),
    ).toEqual({ planned: 1, completed: 1, interrupted: false });
  });
});
