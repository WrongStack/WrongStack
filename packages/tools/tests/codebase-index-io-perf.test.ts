/** Controlled end-to-end I/O/concurrency benchmark for codebase indexing. */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPairingValid, captureLoad } from './bench-pairing.js';
import {
  cancelPendingReindexes,
  enqueueReindex,
  getCodebaseIndexPerfSnapshot,
  resetCodebaseIndexPerfMetrics,
  runStartupIndex,
  shutdownCodebaseIndexHost,
} from '../src/codebase-index/index.js';

const elapsedMs = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e6;

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
};

const summarize = (values: number[]) => ({
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: Math.max(...values),
});

describe('codebase-index controlled I/O benchmark', () => {
  const roots: string[] = [];

  afterEach(async () => {
    cancelPendingReindexes();
    await shutdownCodebaseIndexHost();
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('records repeated p50/p95 latency for a controlled incremental burst', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-io-perf-'));
    roots.push(root);
    const indexDir = path.join(root, '.index');
    const files = Array.from({ length: 12 }, (_, i) => path.join(root, `file-${i}.ts`));
    await Promise.all(files.map((file, i) => fs.writeFile(file, `export function f${i}() { return ${i}; }\n`)));

    const loadStart = await captureLoad();
    resetCodebaseIndexPerfMetrics();
    await runStartupIndex({ projectRoot: root, indexDir, force: true, timeoutMs: 30_000 });

    const latencies: number[] = [];
    for (let round = 0; round < 3; round++) {
      await Promise.all(files.map((file) => fs.appendFile(file, `\nexport const changed${round} = true;\n`)));
      const starts = files.map(() => process.hrtime.bigint());
      await Promise.all(
        files.map(async (_file, i) => {
          await runStartupIndex({ projectRoot: root, indexDir, timeoutMs: 30_000 });
          latencies.push(elapsedMs(starts[i]!));
        }),
      );
    }

    const loadEnd = await captureLoad();
    assertPairingValid(loadStart, loadEnd, 'codebase-index-inline', 'mode=incremental-burst');

    const metrics = getCodebaseIndexPerfSnapshot();
    const summary = summarize(latencies);
    const p95 = summary.p95;
    expect(latencies).toHaveLength(files.length * 3);
    expect(metrics.filesystemReadCount).toBeGreaterThanOrEqual(files.length);
    expect(metrics.filesystemBytesRead).toBeGreaterThan(0);
    expect(p95).toBeLessThan(30_000);
    // eslint-disable-next-line no-console
    console.log(
      `[codebase-index-io-perf] incremental burst n=${latencies.length} p50=${summary.p50.toFixed(1)}ms ` +
        `p95=${p95.toFixed(1)}ms max=${summary.max.toFixed(1)}ms ` +
        `fsBytes=${metrics.filesystemBytesRead} parserGateWait=${metrics.parserGateWaitMs.toFixed(1)}ms ` +
        `subprocesses=${metrics.parserSubprocessCount} ipcPendingPeak=${metrics.ipcPendingPeak} ` +
        `writeQueueWait=${metrics.writeQueueWaitMs.toFixed(1)}ms`,
    );
  });

  it('awaits a direct debounced enqueue burst', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-enqueue-perf-'));
    roots.push(root);
    const indexDir = path.join(root, '.index');
    const files = Array.from({ length: 8 }, (_, i) => path.join(root, `enqueue-${i}.ts`));
    await Promise.all(files.map((file, i) => fs.writeFile(file, `export const e${i} = ${i};\n`)));
    await runStartupIndex({ projectRoot: root, indexDir, force: true, timeoutMs: 30_000 });
    const loadStart = await captureLoad();
    resetCodebaseIndexPerfMetrics();
    await Promise.all(files.map((file) => fs.appendFile(file, '\nexport const touched = true;\n')));
    const start = process.hrtime.bigint();
    await enqueueReindex({
      projectRoot: root,
      indexDir,
      files,
      debounceMs: 1,
      coalesceWindowMs: 10,
      timeoutMs: 30_000,
    });
    const latency = elapsedMs(start);
    const loadEnd = await captureLoad();
    assertPairingValid(loadStart, loadEnd, 'codebase-index-inline', 'mode=enqueue-burst');
    const metrics = getCodebaseIndexPerfSnapshot();
    expect(latency).toBeLessThan(30_000);
    expect(metrics.filesystemBytesRead).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`[codebase-index-io-perf] enqueue burst n=${files.length} latency=${latency.toFixed(1)}ms`);
  });

  it('reports the controlled boundary counters without requiring a daemon', () => {
    resetCodebaseIndexPerfMetrics();
    const metrics = getCodebaseIndexPerfSnapshot();
    expect(metrics.ipcPendingPeak).toBe(0);
    expect(metrics.parserSubprocessCount).toBe(0);
    expect(metrics.writeQueueWaitMs).toBe(0);
  });
});
