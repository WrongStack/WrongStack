/** Built-dist detached-daemon benchmark. Run after `bun run --filter '@wrongstack/tools...' build`. */
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPairingValid, captureLoad, isStrictPairing } from './bench-pairing.js';

// Resolve the published dependency graph, including Codebase's compiled daemon.
// Vitest's workspace aliases would replace it with source and omit the daemon.
const {
  CircuitOpenError,
  checkCodebaseIndexServerHealth,
  getCodebaseIndexPerfSnapshot,
  resetCodebaseIndexPerfMetrics,
  resetIndexCircuitBreaker,
  runStartupIndex,
  shutdownCodebaseIndexHost,
  shutdownCodebaseIndexServer,
} = createRequire(import.meta.url)(
  '../dist/codebase-index/index.js',
) as typeof import('../dist/codebase-index/index.js');

/**
 * `bench-pairing` already says what a loaded box means for this suite: an
 * unusable sample is not a product defect, so the test SKIPS rather than
 * turning the suite red — unless the runner asked for strict pairing.
 *
 * That contract only covered the MEASUREMENT. Under full-suite load the
 * detached daemon's socket dies inside `runStartupIndex`, before
 * `assertPairingValid` is ever reached, so the guard never got its say and the
 * benchmark failed the whole run on `codebase-index server connection closed`.
 * Worse, the breaker it tripped stayed open into the next case, which then
 * failed with `CircuitOpenError` — a second red from the first case's load.
 *
 * `benchIt` extends the existing contract to the setup: infrastructure failures
 * skip on a developer box and still throw under WRONGSTACK_BENCH_STRICT_PAIRING,
 * so a perf leg that cannot produce a sample still fails loudly. Assertion
 * failures are never swallowed — only the daemon dying is.
 *
 * Two shapes of "the daemon could not keep up" escaped that contract in the
 * 2026-09-18 full-suite run and both are covered now:
 *
 *  1. The daemon is SLOW rather than dead, so nothing is ever thrown into the
 *     body and Vitest's own `testTimeout` fires instead. A Vitest timeout is
 *     not a rejection of `body()` — the try/catch below can never see it, so
 *     widening the regex alone cannot help. `benchIt` therefore races the body
 *     against its OWN deadline, set below the Vitest one, and converts losing
 *     that race into the same skip. The margin must stay large enough for the
 *     `afterEach` daemon teardown to still run inside Vitest's budget.
 *  2. The failure arrives with a timeout WORDING the regex did not list
 *     (`handshake timed out` from project-server-client's connect path, and the
 *     per-op `exceeded its <n>ms watchdog timeout`). Same class, different
 *     text; both are in INFRASTRUCTURE_FAILURE now. Keep this regex in step
 *     with the client's timeout messages — a wording it does not match turns a
 *     loaded box back into a red full-suite run.
 */
const INFRASTRUCTURE_FAILURE =
  /connection closed|socket hang up|EPIPE|ECONNRESET|ECONNREFUSED|daemon (?:exited|unavailable)|handshake timed out|exceeded its \d+ms watchdog timeout/i;

function isInfrastructureFailure(error: unknown): boolean {
  if (error instanceof CircuitOpenError) return true;
  return error instanceof Error && INFRASTRUCTURE_FAILURE.test(error.message);
}

type BenchContext = { skip: (note?: string) => never };

/**
 * Head room left to Vitest so the `afterEach` daemon teardown still runs when
 * `benchIt` gives up: the body loses its race, the case skips, and the daemon
 * is reaped inside Vitest's own budget instead of being killed mid-shutdown.
 */
const BENCH_DEADLINE_MARGIN_MS = 30_000;

/** Marks the internal deadline so only IT is treated as a slow-box skip. */
const BENCH_DEADLINE = Symbol('bench-deadline');

function benchIt(
  name: string,
  body: (ctx: BenchContext) => Promise<void>,
  timeoutMs: number,
): void {
  it(
    name,
    async (ctx) => {
      // Never let the deadline exceed the Vitest budget it is meant to precede.
      const deadlineMs = Math.max(1_000, timeoutMs - BENCH_DEADLINE_MARGIN_MS);
      let deadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          body(ctx as unknown as BenchContext),
          new Promise((_resolve, reject) => {
            deadline = setTimeout(() => reject(BENCH_DEADLINE), deadlineMs);
            // An unref'd timer cannot hold the worker open on the happy path.
            deadline.unref?.();
          }),
        ]);
      } catch (error) {
        if (error === BENCH_DEADLINE) {
          if (isStrictPairing()) {
            throw new Error(
              `${name}: benchmark did not finish within ${deadlineMs}ms on this box.`,
            );
          }
          // `skip()` is typed `never` and throws, but returning keeps the bare
          // symbol from escaping as an error if that ever stops being true.
          return (ctx as unknown as BenchContext).skip(
            `${name}: the shared box did not finish the benchmark within ` +
              `${deadlineMs}ms. Benchmark sample unusable; not a product defect.`,
          );
        }
        if (!isInfrastructureFailure(error) || isStrictPairing()) throw error;
        (ctx as unknown as BenchContext).skip(
          `${name}: the detached daemon did not survive the shared box — ` +
            `${(error as Error).message}. Benchmark sample unusable; not a product defect.`,
        );
      } finally {
        if (deadline) clearTimeout(deadline);
      }
    },
    timeoutMs,
  );
}

const elapsedMs = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e6;
const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
};
const summary = (values: number[]) => ({
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: Math.max(...values),
});

describe('built-dist detached codebase-index benchmark', () => {
  const roots: string[] = [];
  afterEach(async () => {
    delete process.env['WRONGSTACK_INDEX_BENCH_NO_HOST_MUTEX'];
    delete process.env['WRONGSTACK_INDEX_BENCH_WRITE_HOLD_MS'];
    // A daemon that died under load trips the breaker, and an open breaker
    // refuses every later index run for 60s — which turned one case's bad luck
    // into the next case's failure. The breaker is process-global state; this
    // file must not leak it between cases.
    resetIndexCircuitBreaker();
    for (const root of roots) {
      try {
        await shutdownCodebaseIndexServer(root, path.join(root, '.index'), 'benchmark teardown');
      } catch {
        // The daemon may close its socket immediately after acknowledging stop.
      }
    }
    await shutdownCodebaseIndexHost();
    for (const root of roots.splice(0)) {
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          await fs.rm(root, { recursive: true, force: true });
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || attempt === 4) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
  });

  benchIt(
    'captures repeated daemon p50/p95/max and non-zero queue metrics',
    async (ctx) => {
      expect(process.env['WRONGSTACK_INDEX_INLINE']).toBeUndefined();
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-daemon-perf-'));
      process.env['WRONGSTACK_INDEX_BENCH_NO_HOST_MUTEX'] =
        process.env['WRONGSTACK_BENCH_NO_HOST_MUTEX'] ?? '1';
      process.env['WRONGSTACK_INDEX_BENCH_WRITE_HOLD_MS'] =
        process.env['WRONGSTACK_BENCH_HOLD_MS'] ?? '250';
      const holdMs = Number(process.env['WRONGSTACK_INDEX_BENCH_WRITE_HOLD_MS'] ?? '250');
      roots.push(root);

      const indexDir = path.join(root, '.index');
      const files = Array.from({ length: 12 }, (_, i) => path.join(root, `daemon-${i}.ts`));
      await Promise.all(files.map((file, i) => fs.writeFile(file, `export const d${i} = ${i};\n`)));

      await runStartupIndex({ projectRoot: root, indexDir, force: true, timeoutMs: 30_000 });
      resetCodebaseIndexPerfMetrics();
      // Bracket the measured burst only: sampling before the forced startup index
      // (or before the previous case's daemon teardown has drained) reads that
      // warm-up as drift and invalidates an otherwise clean pair.
      const loadStart = await captureLoad();
      const latencies: number[] = [];
      for (let round = 0; round < 3; round++) {
        await Promise.all(
          files.map((file) =>
            fs.appendFile(file, `\nexport const daemonChanged${round} = true;\n`),
          ),
        );
        const starts = files.map(() => process.hrtime.bigint());
        await Promise.all(
          files.map(async (_file, i) => {
            await runStartupIndex({ projectRoot: root, indexDir, timeoutMs: 30_000 });
            latencies.push(elapsedMs(starts[i]!));
          }),
        );
      }

      const loadEnd = await captureLoad();
      assertPairingValid(loadStart, loadEnd, 'codebase-index-daemon', `hold=${holdMs}`, ctx);

      const metrics = getCodebaseIndexPerfSnapshot();
      const health = await checkCodebaseIndexServerHealth(root, indexDir, { timeoutMs: 5_000 });
      const server = health.server;
      const stats = summary(latencies);
      expect(latencies).toHaveLength(36);
      expect(stats.p95).toBeLessThan(30_000);
      expect(server?.maxQueuedWrites ?? 0).toBeGreaterThan(0);
      expect(server?.writeQueueWaitMs ?? 0).toBeGreaterThan(0);
      // eslint-disable-next-line no-console
      console.log(
        `[codebase-index-daemon-perf] n=${latencies.length} p50=${stats.p50.toFixed(1)}ms ` +
          `p95=${stats.p95.toFixed(1)}ms max=${stats.max.toFixed(1)}ms ` +
          `ipcPendingPeak=${metrics.ipcPendingPeak} daemonMaxQueuedWrites=${server?.maxQueuedWrites ?? 0} ` +
          `daemonWriteQueueWait=${server?.writeQueueWaitMs ?? 0}ms`,
      );
    },
    180_000,
  );

  benchIt(
    'sweeps benchmark hold values and reports queue-wait sensitivity',
    async (ctx) => {
      const sweep: Array<{
        holdMs: number;
        p50: number;
        p95: number;
        max: number;
        waitMs: number;
        cpuStart: number;
        cpuEnd: number;
        cpuDrift: number;
        agents: number | null;
        pairingValid: true;
      }> = [];
      for (const holdMs of [50, 100, 250]) {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), `wstack-daemon-sweep-${holdMs}-`));
        roots.push(root);
        const indexDir = path.join(root, '.index');
        const files = Array.from({ length: 8 }, (_, i) => path.join(root, `sweep-${i}.ts`));
        process.env['WRONGSTACK_INDEX_BENCH_NO_HOST_MUTEX'] = '1';
        process.env['WRONGSTACK_INDEX_BENCH_WRITE_HOLD_MS'] = String(holdMs);
        await Promise.all(
          files.map((file, i) => fs.writeFile(file, `export const s${i} = ${i};\n`)),
        );
        await runStartupIndex({ projectRoot: root, indexDir, force: true, timeoutMs: 30_000 });
        resetCodebaseIndexPerfMetrics();
        // Sample after the warm-up so the pair brackets the burst, not the
        // previous sweep point's daemon shutdown.
        const loadStart = await captureLoad();
        await Promise.all(
          files.map((file) => fs.appendFile(file, '\nexport const sweepChanged = true;\n')),
        );
        const latencies: number[] = [];
        const starts = files.map(() => process.hrtime.bigint());
        await Promise.all(
          files.map(async (_file, i) => {
            await runStartupIndex({ projectRoot: root, indexDir, timeoutMs: 30_000 });
            latencies.push(elapsedMs(starts[i]!));
          }),
        );
        const loadEnd = await captureLoad();
        assertPairingValid(
          loadStart,
          loadEnd,
          'codebase-index-daemon',
          `hold=${holdMs} sweep`,
          ctx,
        );
        const health = await checkCodebaseIndexServerHealth(root, indexDir, { timeoutMs: 5_000 });
        const stats = summary(latencies);
        const waitMs = health.server?.writeQueueWaitMs ?? 0;
        expect(waitMs).toBeGreaterThan(0);
        sweep.push({
          holdMs,
          ...stats,
          waitMs,
          cpuStart: Number(loadStart.cpu.toFixed(1)),
          cpuEnd: Number(loadEnd.cpu.toFixed(1)),
          cpuDrift: Number(Math.abs(loadEnd.cpu - loadStart.cpu).toFixed(1)),
          agents: loadEnd.agents,
          pairingValid: true,
        });
      }
      // eslint-disable-next-line no-console
      console.log(`[codebase-index-daemon-sweep] ${JSON.stringify(sweep)}`);
      expect(sweep).toHaveLength(3);
      expect(sweep[2]!.waitMs).toBeGreaterThanOrEqual(sweep[0]!.waitMs);
    },
    180_000,
  );
});
