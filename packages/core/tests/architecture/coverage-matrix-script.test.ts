import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import {
  buildMatrix,
  discoverSummaries,
  isDirectRun,
  renderMarkdown,
  run,
  summarize,
  worstFiles,
} from '../../../../scripts/coverage-matrix.mjs';

const nowMs = Date.parse('2026-08-29T12:00:00.000Z');
let tmpRoots: string[] = [];

function makeTmpRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'coverage-matrix-'));
  tmpRoots.push(root);
  return root;
}

function writeSummary(root: string, areaDir: string, json: unknown): void {
  const dir = path.join(root, areaDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'coverage-summary.json'), JSON.stringify(json), 'utf8');
}

function summaryFor(pct: number, covered: number): unknown {
  return {
    total: {
      lines: { total: 100, covered, skipped: 0, pct },
      statements: { total: 100, covered, skipped: 0, pct },
      functions: { total: 10, covered: Math.round(pct / 10), skipped: 0, pct },
      branches: { total: 20, covered: Math.round(pct / 5), skipped: 0, pct },
    },
  };
}

afterEach(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
  tmpRoots = [];
});

describe('coverage-matrix script', () => {
  it('discovers fixed, package, and app summary locations in stable order', () => {
    const root = makeTmpRoot();
    mkdirSync(path.join(root, 'packages', 'alpha'), { recursive: true });
    mkdirSync(path.join(root, 'apps', 'beta'), { recursive: true });

    const locations = discoverSummaries(root);

    expect(locations.map((location) => location.label)).toEqual([
      'coverage/root',
      'coverage/scripts',
      'packages/alpha',
      'apps/beta',
    ]);
  });

  it('summarizes valid JSON, skips missing files, and flags unparseable ones', () => {
    const root = makeTmpRoot();
    writeSummary(root, path.join('coverage', 'root'), summaryFor(84.29, 84));
    const brokenDir = path.join(root, 'packages', 'broken', 'coverage');
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(path.join(brokenDir, 'coverage-summary.json'), '{not json', 'utf8');

    const [rootRow, missingRow, brokenRow] = [
      summarize({
        label: 'coverage/root',
        summaryPath: path.join(root, 'coverage', 'root', 'coverage-summary.json'),
      }),
      summarize({
        label: 'coverage/none',
        summaryPath: path.join(root, 'coverage', 'none', 'coverage-summary.json'),
      }),
      summarize({
        label: 'packages/broken',
        summaryPath: path.join(root, 'packages', 'broken', 'coverage', 'coverage-summary.json'),
      }),
    ];

    expect(rootRow).not.toBeNull();
    expect(missingRow).toBeNull();
    expect(brokenRow?.error).toContain('unparseable summary');
  });

  it('builds matrix rows with uncovered counts and age', () => {
    const row = summarize({
      label: 'coverage/root',
      summaryPath: path.join(makeTmpRoot(), 'coverage', 'root', 'coverage-summary.json'),
    });
    // summarize returned null for the missing fixture — feed a parsed row instead.
    const parsed = {
      label: 'coverage/root',
      summaryPath: 'x',
      mtimeMs: nowMs,
      json: summaryFor(50, 50),
    };
    expect(row).toBeNull();

    const [built] = buildMatrix([null, parsed], nowMs);
    expect(built).toMatchObject({
      label: 'coverage/root',
      lines: '50.00%',
      statements: '50.00%',
      uncoveredStatements: 50,
      measuredOn: '2026-08-29',
      ageDays: 0,
      error: undefined,
    });

    const [malformed] = buildMatrix(
      [
        {
          label: 'coverage/broken-metrics',
          summaryPath: 'y',
          mtimeMs: nowMs,
          json: { total: { lines: { pct: 'n/a' }, statements: {} } },
        },
      ],
      nowMs,
    );
    expect(malformed).toMatchObject({
      lines: '—',
      statements: '—',
      functions: '—',
      branches: '—',
      uncoveredStatements: null,
    });
  });

  it('ranks worst files by uncovered statements and drops fully covered ones', () => {
    const json = {
      total: {},
      'packages/a/src/big.ts': {
        lines: { pct: 10 },
        statements: { total: 400, covered: 100 },
      },
      'packages/b/src/small.ts': {
        lines: { pct: 90 },
        statements: { total: 20, covered: 10 },
      },
      'packages/c/src/done.ts': {
        lines: { pct: 100 },
        statements: { total: 30, covered: 30 },
      },
      'packages/d/src/no-lines-metric.ts': {
        statements: { total: 50, covered: 10 },
      },
      'packages/e/src/meta-only.ts': {
        lines: { pct: 50 },
      },
    };

    const worst = worstFiles(json, 5);
    expect(worst).toEqual([
      { file: 'packages/a/src/big.ts', uncoveredStatements: 300, linesPct: 10 },
      { file: 'packages/d/src/no-lines-metric.ts', uncoveredStatements: 40, linesPct: 0 },
      { file: 'packages/b/src/small.ts', uncoveredStatements: 10, linesPct: 90 },
    ]);
  });

  it('renders a markdown table including errors and the worst-file section', () => {
    const parsed = {
      label: 'coverage/root',
      summaryPath: 'x',
      mtimeMs: nowMs,
      json: summaryFor(84.29, 84),
    };
    const broken = {
      label: 'packages/broken',
      summaryPath: 'y',
      mtimeMs: nowMs,
      json: null,
      error: 'unparseable summary: boom',
    };
    const markdown = renderMarkdown({
      rows: buildMatrix([parsed, broken], nowMs),
      worst: worstFiles({
        'packages/a/src/big.ts': { lines: { pct: 10 }, statements: { total: 400, covered: 100 } },
      }),
      generatedAt: new Date(nowMs).toISOString(),
    });

    expect(markdown).toContain('# Coverage Matrix — 2026-08-29');
    expect(markdown).toContain('| coverage/root | 84.29%');
    expect(markdown).toContain('⚠️ packages/broken: unparseable summary: boom');
    expect(markdown).toContain('| packages/a/src/big.ts | 300 | 10.00% |');
    expect(
      renderMarkdown({ rows: [], worst: [], generatedAt: new Date(nowMs).toISOString() }),
    ).toContain('No root-run summary found.');
  });

  it('writes to --out, logs missing areas, and rejects unknown arguments', () => {
    const root = makeTmpRoot();
    writeSummary(root, path.join('coverage', 'root'), summaryFor(84.29, 84));
    const outPath = path.join(root, 'matrix.md');
    const log = vi.fn();

    expect(run(['--out', outPath], { repoRoot: root, log, nowMs })).toBe(0);
    expect(readFileSync(outPath, 'utf8')).toContain('# Coverage Matrix — 2026-08-29');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no summary for coverage/scripts'));

    expect(() => run(['--bogus'], { repoRoot: root, log, nowMs })).toThrow(
      'unknown argument: --bogus',
    );
    expect(() => run(['--out'], { repoRoot: root, log, nowMs })).toThrow('--out requires a path');
  });

  it('recognizes direct execution for the CLI guard', () => {
    const scriptPath = path.resolve(import.meta.dirname, '../../../../scripts/coverage-matrix.mjs');
    expect(isDirectRun(pathToFileURL(scriptPath).href, scriptPath)).toBe(true);
    expect(
      isDirectRun(pathToFileURL(scriptPath).href, path.join(scriptPath, '..', 'other.mjs')),
    ).toBe(false);
  });

  it('runs standalone via node (direct CLI branch, default dependencies)', () => {
    const scriptPath = path.resolve(import.meta.dirname, '../../../../scripts/coverage-matrix.mjs');
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      timeout: 20_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# Coverage Matrix —');
  });

  it('falls back to default dependencies and prints to stdout without --out', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const originalArgv = process.argv;
    process.argv = [process.execPath, 'coverage-matrix'];
    try {
      expect(run(undefined, undefined)).toBe(0);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('# Coverage Matrix —'));
      expect(buildMatrix([])).toEqual([]);

      const emptyRoot = makeTmpRoot();
      const emptyLog = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const outPath = path.join(emptyRoot, 'matrix.md');
        expect(run(['--out', outPath], { repoRoot: emptyRoot })).toBe(0);
        expect(readFileSync(outPath, 'utf8')).toContain('No root-run summary found.');
      } finally {
        emptyLog.mockRestore();
      }
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
    }
  });

  it('executes the direct CLI branch when invoked as the entry script', async () => {
    const scriptPath = path.resolve(import.meta.dirname, '../../../../scripts/coverage-matrix.mjs');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const originalArgv = process.argv;
    process.argv = [process.execPath, scriptPath];
    try {
      vi.resetModules();
      await import('../../../../scripts/coverage-matrix.mjs');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('# Coverage Matrix —'));
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
    }
  });
});
