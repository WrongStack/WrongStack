/**
 * Shared synchronized-load pairing checks for codebase-index benchmarks.
 *
 * Both benchmark modes (inline and detached-daemon) enforce the same contract:
 * a sample is only valid when the shared box's CPU load stays within
 * `WRONGSTACK_BENCH_MAX_CPU_DRIFT_PCT` (default 10 percentage points) between
 * the start and end of the measured section, and the online-peer count
 * (`WRONGSTACK_BENCH_ONLINE_AGENTS`, captured by the runner before the run)
 * does not change mid-run. An invalid pair is NEVER recorded as a comparison.
 *
 * How an invalid pair ends the test depends on the mode:
 *   - default (developer box, `pnpm test`): the test SKIPS. The sample is
 *     unusable, but an unusable sample is not a product defect, so a loaded
 *     box must not turn the suite red.
 *   - `WRONGSTACK_BENCH_STRICT_PAIRING=1` (runner-driven perf legs): it
 *     THROWS, so a leg that cannot produce a valid comparison fails loudly.
 * Callers that pass no test context always get the strict (throwing) path.
 */
import * as os from 'node:os';

export interface LoadSnapshot {
  cpu: number;
  /** Online-peer count captured by the runner via WRONGSTACK_BENCH_ONLINE_AGENTS. */
  agents: number | null;
  at: string;
}

/** Minimal shape of the vitest test context bits this helper needs. */
export interface PairingSkipContext {
  skip: (note?: string) => never;
}

/** Sample aggregate CPU busy% over `sampleMs` using os.cpus() deltas (Windows-safe). */
export async function captureCpuPercent(sampleMs = 300): Promise<number> {
  const start = os.cpus().map((cpu) => cpu.times);
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  const end = os.cpus().map((cpu) => cpu.times);
  let busy = 0;
  let total = 0;
  for (let i = 0; i < Math.min(start.length, end.length); i++) {
    const s = start[i]!;
    const e = end[i]!;
    const idleDelta = e.idle - s.idle;
    const totalDelta =
      e.user - s.user + e.nice - s.nice + e.sys - s.sys + e.idle - s.idle + e.irq - s.irq;
    busy += totalDelta - idleDelta;
    total += totalDelta;
  }
  return total <= 0 ? 0 : (busy / total) * 100;
}

export async function captureLoad(): Promise<LoadSnapshot> {
  const raw = process.env['WRONGSTACK_BENCH_ONLINE_AGENTS'];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return {
    cpu: await captureCpuPercent(),
    agents: Number.isFinite(parsed) ? parsed : null,
    at: new Date().toISOString(),
  };
}

/** True when the runner asked for the strict (fail-the-leg) pairing contract. */
export function isStrictPairing(): boolean {
  const raw = process.env['WRONGSTACK_BENCH_STRICT_PAIRING'];
  return raw !== undefined && raw !== '' && raw !== '0' && raw.toLowerCase() !== 'false';
}

/**
 * Reject the pair when shared-box load drifted beyond the configured thresholds.
 *
 * Pass the vitest test context to skip (instead of fail) on a developer box;
 * omit it — or set `WRONGSTACK_BENCH_STRICT_PAIRING=1` — to throw.
 */
export function assertPairingValid(
  start: LoadSnapshot,
  end: LoadSnapshot,
  suite: string,
  detail = '',
  ctx?: PairingSkipContext,
): void {
  const maxDriftPct = Number(process.env['WRONGSTACK_BENCH_MAX_CPU_DRIFT_PCT'] ?? 10);
  const driftPct = Math.abs(end.cpu - start.cpu);
  const agentsStable = start.agents === null || start.agents === end.agents;
  const valid = driftPct <= maxDriftPct && agentsStable;
  // eslint-disable-next-line no-console
  console.log(
    `[${suite}-pairing]${detail ? ` ${detail}` : ''} cpuStart=${start.cpu.toFixed(1)}% ` +
      `cpuEnd=${end.cpu.toFixed(1)}% cpuDrift=${driftPct.toFixed(1)}pp ` +
      `agents=${end.agents ?? 'unknown'} valid=${valid}`,
  );
  if (valid) return;
  const reason =
    `benchmark pairing invalid: CPU drifted ${driftPct.toFixed(1)}pp ` +
    `(max ${maxDriftPct}pp)${agentsStable ? '' : ' or online-agent count changed mid-run'} ` +
    '— comparison samples must not be used';
  if (ctx && !isStrictPairing()) ctx.skip(reason);
  throw new Error(reason);
}
