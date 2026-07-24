/**
 * Ensemble runner — fan a single task out to multiple ACP agents in parallel.
 *
 * This is the engine behind both:
 *  - `wstack acp parallel <csv> <task>`  (CLI subcommand)
 *  - `/ensemble <csv> <task>`            (TUI slash command)
 *
 * The CLI wraps `runEnsemble` with a plain-text renderer. The TUI can
 * call it directly and format the result however it likes (text dump,
 * per-agent tabbed panels, etc.).
 *
 * Design notes
 * ────────────
 *  - Skipping is up-front. We probe the registry once, then run only
 *    the installed agents. This keeps the "no installed agents" path
 *    cheap (no spawn attempts) and the error message clear.
 *  - All agents run concurrently via `Promise.allSettled`. A single
 *    failed agent doesn't kill the others; the call returns once every
 *    agent has either completed or crashed.
 *  - Per-agent errors are captured as structured `{kind, message}`
 *    objects, not thrown. The aggregated result is one `EnsembleResult`
 *    with per-agent outcomes. Callers can render it as they please.
 *  - The `signal` option propagates as the parent AbortSignal for each
 *    `SubagentRunner`. Aborting cancels all in-flight agents.
 *  - Idempotent cleanup: each agent's `stop()` is called in a
 *    `finally`, so a throw in the body still tears the child down.
 */

import { SubagentBudget } from '@wrongstack/core/coordination';
import type { ACPProgressEvent } from '../client/acp-session.js';
import { defaultPermissionPolicy } from '../client/permission.js';
import { type DetectedAgent, EnsembleRegistry } from '../registry/ensemble-registry.js';
import {
  type ACPSubagentRunnerOptions,
  makeACPSubagentRunnerWithStop,
  resolveAcpAgentCommand,
} from './acp-subagent-runner.js';

/** Live per-agent progress callback for an ensemble run. */
export type EnsembleProgressHandler = (agentId: string, event: ACPProgressEvent) => void;

/**
 * Per-agent outcome from an ensemble run.
 * `status === 'skipped'` carries a `reason`; the other statuses carry
 * either a result or an error envelope.
 */
export interface EnsembleAgentResult {
  agentId: string;
  status: 'success' | 'failed' | 'skipped' | 'cancelled';
  /** The agent's text result. Present for `status === 'success'`. */
  result?: string | undefined;
  /** Structured error. Present for `status === 'failed' | 'cancelled'`. */
  error?: { kind: string; message: string } | undefined;
  /** Why the agent was skipped (not installed, unknown id, etc.). */
  reason?: string | undefined;
  /** Wall-clock time spent on this agent. 0 for skipped. */
  durationMs: number;
  /** Agent-reported iteration count (1 per ACP turn). */
  iterations: number;
  /** Agent-reported tool call count (currently 0 for ACP). */
  toolCalls: number;
}

/** Aggregate result of one ensemble run. */
export interface EnsembleResult {
  /** The task that was dispatched. */
  task: string;
  /** Agent ids as the user provided them, after dedup. */
  requested: string[];
  /** Per-agent outcomes, in the order they were requested. */
  results: EnsembleAgentResult[];
  /** Roll-up of the per-agent statuses. */
  summary: {
    succeeded: number;
    failed: number;
    skipped: number;
    cancelled: number;
  };
  /** Total wall-clock time of the run (longest agent). */
  totalDurationMs: number;
}

/** Sync command resolver: id → command, or null if unknown. */
export type EnsembleCmdResolver = (id: string) => ACPSubagentRunnerOptions | null;

export interface EnsembleRunnerOptions {
  /**
   * Comma-separated agent ids. Whitespace, empty entries, and
   * duplicates are filtered out. Order is preserved.
   */
  agentIds: string;
  /** The task description forwarded verbatim to each agent. */
  task: string;
  /**
   * Per-agent hard timeout in ms. Defaults to 5 minutes; the
   * `SubagentRunner` itself layers a turn-level timeout under this.
   */
  timeoutMs?: number;
  /**
   * Override the registry used for the install probe. Defaults to
   * `new EnsembleRegistry()`. Useful for tests.
   */
  registry?: EnsembleRegistry;
  /**
   * Override the command resolver. Defaults to
   * `defaultEnsembleCmdResolver` (legacy `ACP_AGENT_COMMANDS` map
   * with catalog fallback via `findAgentDescriptor`). Useful for
   * tests that don't want the real `makeACPSubagentRunnerWithStop`.
   */
  resolveCmd?: EnsembleCmdResolver;
  /**
   * Cancellation signal. Aborting stops all in-flight agents via the
   * `SubagentRunContext.signal` they receive.
   */
  signal?: AbortSignal | undefined;
  /**
   * Live progress callback. Invoked for every streamed update from every
   * agent, tagged with the agent id so the caller can render interleaved
   * progress (e.g. `[gemini-cli] edit foo.ts`).
   */
  onProgress?: EnsembleProgressHandler | undefined;
  /**
   * Maximum number of agents to launch concurrently. Defaults to
   * `DEFAULT_MAX_CONCURRENCY` (4). Set to 1 for serial execution;
   * values larger than the runnable count are clamped down. Bounded
   * fan-out keeps simultaneous ACP subprocess / WebSocket counts
   * manageable when an ensemble has many members.
   */
  maxConcurrency?: number | undefined;
}

/** Default cap on simultaneously-running agents in an ensemble. */
const DEFAULT_MAX_CONCURRENCY = 4;

/**
 * Map each input through `worker` with at most `limit` tasks in flight.
 * The output array preserves input order. Each worker is expected to
 * resolve (not throw) — `runEnsemble`'s runnable workers wrap their
 * own logic so they never reject, matching the original
 * `Promise.allSettled` semantics where rejection was effectively
 * impossible. Bounded concurrency caps simultaneous ACP subprocess /
 * WebSocket counts in large ensembles.
 */
async function mapBound<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;
  const safeLimit = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;
  const workerCount = Math.min(safeLimit, items.length);
  const runners: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    runners.push(
      (async () => {
        while (true) {
          const current = nextIndex++;
          if (current >= items.length) return;
          results[current] = await worker(items[current]!, current);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return results;
}

/**
 * Default command resolver — delegates to `resolveAcpAgentCommand`, so the
 * catalog's corrected invocations win over the stale legacy map (the legacy
 * map is now only a last-resort fallback). Returns `null` for unknown ids.
 */
export const defaultEnsembleCmdResolver: EnsembleCmdResolver = (id) => resolveAcpAgentCommand(id);

/**
 * Update one result in-place. Keeps the array order stable so callers
 * can render results in the same order they were requested.
 */
function setResult(
  results: EnsembleAgentResult[],
  agentId: string,
  patch: Partial<EnsembleAgentResult>,
): void {
  const i = results.findIndex((r) => r.agentId === agentId);
  if (i < 0) return;
  const current = results[i]!;
  results[i] = { ...current, ...patch };
}

/**
 * Run a single agent and return its structured outcome. Always
 * resolves (never throws) — errors are encoded in the returned
 * `EnsembleAgentResult.status`.
 */
async function runOne(
  agentId: string,
  cmd: ACPSubagentRunnerOptions,
  task: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onProgress: EnsembleProgressHandler | undefined,
): Promise<Omit<EnsembleAgentResult, 'agentId'>> {
  const startedAt = Date.now();
  try {
    const { runner, stop } = await makeACPSubagentRunnerWithStop({
      ...cmd,
      timeoutMs,
      // CLI /acp parallel and Director fan-out are trusted local agents — grant write/execute access.
      // The session default is read-only for untrusted agents (acp-session.ts:221).
      permissionPolicy: defaultPermissionPolicy,
      ...(onProgress ? { onProgress: (event) => onProgress(agentId, event) } : {}),
    });
    try {
      // SubagentRunner signature: (task, ctx) => Promise<{result, iterations, toolCalls}>.
      // The budget is required by the context type but the runner never
      // invokes it for a single ACP turn. We construct a real one so the
      // cast stays clean and the context satisfies the type system.
      const budget = new SubagentBudget({
        timeoutMs,
        maxIterations: 2000,
        maxToolCalls: 5000,
      });
      const result = await runner(
        { id: `ensemble-${agentId}`, description: task },
        {
          subagentId: agentId,
          config: {
            id: agentId,
            name: agentId,
            role: agentId,
            provider: 'acp',
            prompt: '',
          },
          budget,
          signal: signal ?? new AbortController().signal,
          bridge: null,
        },
      );
      return {
        status: 'success',
        result: result.result == null ? '' : String(result.result),
        durationMs: Date.now() - startedAt,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
      };
    } finally {
      try {
        stop();
      } catch {
        /* best-effort */
      }
    }
  } catch (err) {
    const e = err as { kind?: string; message?: string; name?: string };
    const isAbort =
      e?.name === 'AbortError' ||
      e?.kind === 'aborted' ||
      e?.kind === 'aborted_by_parent' ||
      e?.message?.toLowerCase().includes('aborted');
    return {
      status: isAbort ? 'cancelled' : 'failed',
      error: {
        kind: e?.kind ?? (isAbort ? 'aborted' : 'unknown'),
        message: e?.message ?? (err instanceof Error ? err.message : String(err)),
      },
      durationMs: Date.now() - startedAt,
      iterations: 0,
      toolCalls: 0,
    };
  }
}

/**
 * Fan a task out to multiple ACP agents concurrently.
 *
 * Returns once every requested agent has either completed, failed, or
 * been cancelled. Skipped agents (not installed, unknown id) are
 * reported with `status: 'skipped'` and don't block the result.
 *
 * The function is a pure orchestrator — it does NOT render output. The
 * caller decides how to format the `EnsembleResult`.
 */
export async function runEnsemble(opts: EnsembleRunnerOptions): Promise<EnsembleResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const registry = opts.registry ?? new EnsembleRegistry();
  const resolveCmd = opts.resolveCmd ?? defaultEnsembleCmdResolver;

  // 1. Parse + dedup the comma list, preserving order.
  const seen = new Set<string>();
  const requested: string[] = [];
  for (const raw of opts.agentIds.split(',')) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    requested.push(id);
  }

  const results: EnsembleAgentResult[] = requested.map((agentId) => ({
    agentId,
    status: 'skipped',
    durationMs: 0,
    iterations: 0,
    toolCalls: 0,
  }));
  const startMs = Date.now();

  if (requested.length === 0) {
    return {
      task: opts.task,
      requested,
      results,
      summary: { succeeded: 0, failed: 0, skipped: 0, cancelled: 0 },
      totalDurationMs: 0,
    };
  }

  // 2. Probe the registry to classify each id as installed / not.
  const detected = await registry.list();
  const detectedById = new Map(detected.map((a: DetectedAgent) => [a.id, a]));

  // 3. Build the runnable set. Agents that aren't installed stay
  //    'skipped' in the result; agents with no command resolver get
  //    'failed' (unknown_agent).
  const runnable: { id: string; cmd: ACPSubagentRunnerOptions }[] = [];
  for (const id of requested) {
    const det = detectedById.get(id);
    if (!det?.installed) {
      setResult(results, id, {
        status: 'skipped',
        reason: det?.reason ?? 'not in catalog',
      });
      continue;
    }
    const cmd = resolveCmd(id);
    if (!cmd) {
      setResult(results, id, {
        status: 'failed',
        error: { kind: 'unknown_agent', message: `Unknown ACP agent: ${id}` },
        durationMs: 0,
      });
      continue;
    }
    runnable.push({ id, cmd });
  }

  // 4. Fan out the runnable set with bounded concurrency so a large
  //    ensemble does not spawn `runnable.length` ACP subprocesses at
  //    once. `runOne` already catches every error internally and
  //    resolves, so `Promise.all` semantics are correct here —
  //    identical to the original `Promise.allSettled` contract because
  //    no worker ever rejects.
  const concurrency = Math.max(1, opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  await mapBound(
    runnable,
    async ({ id, cmd }) => {
      // Honor parent abort BEFORE doing anything expensive.
      if (opts.signal?.aborted) {
        setResult(results, id, {
          status: 'cancelled',
          error: { kind: 'aborted', message: 'aborted by parent' },
          durationMs: 0,
        });
        return;
      }
      const outcome = await runOne(id, cmd, opts.task, timeoutMs, opts.signal, opts.onProgress);
      setResult(results, id, outcome);
    },
    concurrency,
  );

  // 5. Build the summary.
  const summary = { succeeded: 0, failed: 0, skipped: 0, cancelled: 0 };
  for (const r of results) {
    if (r.status === 'success') summary.succeeded++;
    else if (r.status === 'failed') summary.failed++;
    else if (r.status === 'cancelled') summary.cancelled++;
    else summary.skipped++;
  }

  return {
    task: opts.task,
    requested,
    results,
    summary,
    totalDurationMs: Date.now() - startMs,
  };
}

/**
 * Render an `EnsembleResult` as a plain-text block. Useful as the
 * default for the CLI; the TUI can call this or build a richer view.
 *
 * The format mirrors the output the `wstack acp parallel` subcommand
 * emits, so existing scripts that parse the CLI's output keep working.
 */
export function renderEnsembleText(result: EnsembleResult): string {
  const lines: string[] = [];
  if (result.requested.length === 0) {
    lines.push('No agent ids provided.');
    return lines.join('\n');
  }
  for (const r of result.results) {
    lines.push(`\n=== ${r.agentId} ===`);
    switch (r.status) {
      case 'success':
        lines.push(r.result && r.result.length > 0 ? r.result : '(no result)');
        lines.push(
          `[${r.agentId}] success  ${r.durationMs}ms  iterations=${r.iterations} toolCalls=${r.toolCalls}`,
        );
        break;
      case 'failed':
        lines.push(`[${r.error?.kind ?? 'unknown'}] ${r.error?.message ?? 'failed'}`);
        lines.push(`[${r.agentId}] failed  ${r.durationMs}ms`);
        break;
      case 'cancelled':
        lines.push(`[${r.error?.kind ?? 'aborted'}] ${r.error?.message ?? 'cancelled'}`);
        lines.push(`[${r.agentId}] cancelled  ${r.durationMs}ms`);
        break;
      case 'skipped':
        lines.push(`(skipped — ${r.reason ?? 'not installed'})`);
        break;
    }
  }
  const { succeeded, failed, skipped, cancelled } = result.summary;
  lines.push(
    `\nEnsemble summary: ${succeeded} succeeded, ${failed} failed, ${cancelled} cancelled, ${skipped} skipped. (${result.totalDurationMs}ms total)`,
  );
  return lines.join('\n');
}

/** Direct-module test seam; not re-exported by the package barrel. */
export const ensembleRunnerCoverage = { mapBound, setResult };
