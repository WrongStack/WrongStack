/**
 * Shared synchronized-load pairing checks for codebase-index benchmarks.
 *
 * Both benchmark modes (inline and detached-daemon) enforce the same contract:
 * a sample is only valid when the shared box's CPU load stays within
 * `WRONGSTACK_BENCH_MAX_CPU_DRIFT_PCT` (default 10 percentage points) between
 * the start and end of the measured section, and the online-peer count
 * (`WRONGSTACK_BENCH_ONLINE_AGENTS`, captured by the runner before the run)
 * does not change mid-run. An invalid pair THROWS so the samples can never be
 * recorded as a valid comparison.
 */
import * as os from 'node:os';

export interface LoadSnapshot {
  cpu: number;
  /** Online-peer count captured by the runner via WRONGSTACK_BENCH_ONLINE_AGENTS. */
  agents: number | null;
  at: string;
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

/** Fail the run when shared-box load drifts beyond the configured pairing thresholds. */
export function assertPairingValid(
  start: LoadSnapshot,
  end: LoadSnapshot,
  suite: string,
  detail = '',
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
  if (!valid) {
    throw new Error(
      `benchmark pairing invalid: CPU drifted ${driftPct.toFixed(1)}pp ` +
        `(max ${maxDriftPct}pp)${agentsStable ? '' : ' or online-agent count changed mid-run'} ` +
        '— comparison samples must not be used',
    );
  }
}
