/**
 * EnsembleRegistry — discovery layer for ACP-supporting agents.
 *
 * Combines the static catalog (`agents.catalog.ts`) with a runtime
 * `$PATH` probe to report which agents are installed on this machine.
 * The result feeds `wstack acp list`, the `/spawn` picker, and the
 * ensemble UI.
 *
 * Why probe on demand rather than cache at module load
 * ─────────────────────────────────────────────────────
 * The maintainer installs a new agent mid-session. Caching at module
 * load means the cache is stale for the rest of the run. A 5-second
 * per-process cache (`cachedAt`) keeps the common case cheap and the
 * fresh case correct.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { treeKill } from '@wrongstack/core/utils/tree-kill';
import { buildWin32CmdShimInvocation } from '../win32-cmd.js';
import { AGENTS_CATALOG } from './agents.catalog.js';

// Re-exported for backwards compatibility: these two types moved to
// ./contracts.js (the dependency leaf) when ARCH-CYCLE-TYPE-02 was fixed;
// existing consumers import them from here.
export type { ACPAgentVendor, ACPIntegration } from './contracts.js';

import type { ACPAgentDescriptor } from './contracts.js';

export type { ACPAgentDescriptor };

/** A descriptor with its runtime detection result attached. */
export interface DetectedAgent extends ACPAgentDescriptor {
  installed: boolean;
  /** Absolute path to the binary, if discovered. */
  path?: string;
  /** Captured version string, if `probe` produced one. */
  version?: string;
  /**
   * When `installed: false`, a short reason — typically "binary not
   * found", "binary predates ACP", or "probe timed out".
   */
  reason?: string;
}

/** A single probe failure — never thrown, always returned. */
interface ProbeFailure {
  ok: false;
  reason: string;
  /** Wall-clock duration of the failed probe in ms. */
  durationMs: number;
}

interface ProbeSuccess {
  ok: true;
  version: string;
  path?: string;
  durationMs: number;
}

type ProbeResult = ProbeSuccess | ProbeFailure;

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_CACHE_MS = 5_000;
/**
 * Cap on simultaneous catalog probes. Each probe is an external
 * subprocess; an uncapped `Promise.all(catalog.map(probe))` scales
 * with catalog size and is the main cold-start cost when listing
 * available agents. 4 is enough to overlap I/O on a quiet box while
 * staying well under typical fd / process-table limits.
 */
const MAX_PARALLEL_PROBES = 4;

export interface EnsembleRegistryOptions {
  /** Override the catalog (mostly for tests). */
  catalog?: readonly ACPAgentDescriptor[];
  /** Override the probe timeout (ms). */
  probeTimeoutMs?: number;
  /** Inject a custom probe function (used by tests). */
  probeFn?: (descriptor: ACPAgentDescriptor) => Promise<ProbeResult>;
}

/**
 * Run `worker` against each item with at most `limit` in flight at a
 * time. Preserves input order in the output array — every output slot
 * corresponds to the input at the same index. Errors propagate through
 * `Promise.all` semantics (the first rejection rejects the whole call),
 * matching the original `Promise.all(map(worker))` contract that
 * `list()` previously had.
 */
async function probeWithBound<T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const safeLimit = Math.max(1, Math.min(limit, items.length));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(safeLimit, items.length);
  const runners: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    runners.push(
      (async () => {
        while (true) {
          const current = nextIndex++;
          if (current >= items.length) return;
          results[current] = await worker(items[current]!);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return results;
}

/**
 * Probe a single descriptor by running its `probe` argv. Resolves with
 * a structured result rather than throwing — a failed probe is data, not
 * an error.
 */
export async function defaultProbe(
  desc: ACPAgentDescriptor,
  timeoutMs: number,
  spawnProcess: typeof spawn = spawn,
  platform: NodeJS.Platform = process.platform,
): Promise<ProbeResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      try {
        // On the timeout path the probe may still be running; on Windows the
        // tracked child is the cmd.exe shim, so a bare kill() would orphan the
        // real probe grandchild (npx→node, possibly mid package-resolution).
        // treeKill tears down the whole tree. Skip when the child already
        // exited (happy path) so we don't spawn a no-op taskkill per probe.
        // A synchronous spawn() failure leaves `child` undefined, so the
        // property access throws and is swallowed here.
        if (child.exitCode === null && child.signalCode === null) {
          treeKill(child);
        }
      } catch {
        // already dead / never spawned
      }
      resolve(result);
    };

    let child: ChildProcess;
    try {
      const probeArgs = [...(desc.probe.args ?? [])];
      const shim =
        platform === 'win32' ? buildWin32CmdShimInvocation(desc.probe.command, probeArgs) : null;
      child = spawnProcess(shim?.command ?? desc.probe.command, shim?.args ?? probeArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(shim ? { windowsVerbatimArguments: shim.windowsVerbatimArguments } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      finish({ ok: false, reason: `spawn failed: ${msg}`, durationMs: 0 });
      return;
    }

    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'probe timed out', durationMs: Date.now() - start });
    }, timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({
        ok: false,
        reason: `binary not found: ${err.message}`,
        durationMs: Date.now() - start,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const out = (stdout + stderr).trim();

      // With the Windows cmd shim, spawn() never ENOENTs for missing tools:
      // cmd.exe launches, prints "<command> is not recognized", and exits
      // non-zero. Detect that specific shape and treat the binary
      // as not-installed. The literal string is locale-stable for
      // Windows cmd.exe English (the only locale we ship in CI).
      const isWindowsShellMiss =
        platform === 'win32' && out.toLowerCase().includes('is not recognized');

      if (isWindowsShellMiss) {
        finish({
          ok: false,
          reason: 'binary not found',
          durationMs,
        });
        return;
      }

      if (out.length > 0) {
        // The binary ran and produced output. We don't gate on exit
        // code: some agents print version info but exit non-zero; some
        // print to stderr. If we got here without a shell-miss, the
        // binary is installed.
        finish({
          ok: true,
          version: out.split('\n')[0]!.trim(),
          path: desc.probe.command,
          durationMs,
        });
        return;
      }
      // Empty output: the binary didn't behave as a version probe.
      // Treat as not-installed with the exit code as the reason.
      finish({
        ok: false,
        reason: `exit code ${code ?? 'null'}; no output`,
        durationMs,
      });
    });
  });
}

export class EnsembleRegistry {
  private readonly catalog: readonly ACPAgentDescriptor[];
  private readonly timeoutMs: number;
  private readonly probe: (d: ACPAgentDescriptor) => Promise<ProbeResult>;
  private cache: { at: number; result: readonly DetectedAgent[] } | null = null;

  constructor(options: EnsembleRegistryOptions = {}) {
    this.catalog = options.catalog ?? AGENTS_CATALOG;
    this.timeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.probe = options.probeFn ?? ((d) => defaultProbe(d, this.timeoutMs));
  }

  /** Return the full catalog (no probe), in catalog order. */
  listAll(): readonly ACPAgentDescriptor[] {
    return this.catalog;
  }

  /**
   * Probe every catalog entry in parallel and return the detection
   * results. Results are cached for `PROBE_CACHE_MS`.
   *
   * Probes are dispatched with bounded concurrency (`MAX_PARALLEL_PROBES`)
   * so cold-start lists do not spawn `catalog.length` subprocesses at
   * once — which is especially wasteful on Windows shells and on hosts
   * with large agent catalogs. The output order still matches
   * `this.catalog` so callers can index by position.
   */
  async list(): Promise<readonly DetectedAgent[]> {
    if (this.cache && Date.now() - this.cache.at < PROBE_CACHE_MS) {
      return this.cache.result;
    }
    const result = await probeWithBound(this.catalog, (d) => this.detect(d), MAX_PARALLEL_PROBES);
    this.cache = { at: Date.now(), result };
    return result;
  }

  /** Probe a single descriptor. Always returns a `DetectedAgent`. */
  async detect(desc: ACPAgentDescriptor): Promise<DetectedAgent> {
    const result = await this.probe(desc);
    if (result.ok) {
      const detected: DetectedAgent = {
        ...desc,
        installed: true,
        version: result.version,
      };
      if (result.path !== undefined) detected.path = result.path;
      return detected;
    }
    return { ...desc, installed: false, reason: result.reason };
  }

  /** Invalidate the per-process cache. */
  invalidate(): void {
    this.cache = null;
  }

  /** Convenience: just the installed agents. */
  async listInstalled(): Promise<readonly DetectedAgent[]> {
    const all = await this.list();
    return all.filter((a) => a.installed);
  }
}
