import type { Logger } from '@wrongstack/contracts/types/logger';
import type { TaskResult, TaskSpec } from '@wrongstack/contracts/types/multi-agent';
import type { SessionEvent } from '@wrongstack/contracts/types/session-events';
import type { DirectorStateCheckpoint } from '../storage/director-state.js';
import { safeStringify } from '../utils/safe-json.js';
import type { DirectorTaskRegistry } from './director/director-task-registry.js';
import type { DirectorOptions } from './director-options.js';
import type { FleetUsageAggregator } from './fleet-bus.js';
import type { FleetManager } from './fleet-manager.js';
import type { ManifestEntry } from './fleet-spawn.js';

interface DirectorCompletionHost {
  tasks: DirectorTaskRegistry;
  subagentIdleDelayMs: Map<string, number | undefined>;
  subagentIdleTimeoutMs: number | undefined;
  taskResultNotifier: DirectorOptions['taskResultNotifier'];
  manifestEntries: Map<string, unknown>;
  logger: Logger | undefined;
  stateCheckpoint: DirectorStateCheckpoint | null;
  usage: FleetUsageAggregator;
  fleetManager: FleetManager | undefined;
  retireSubagentOnTaskComplete: boolean;
  armSubagentIdleRetirement(id: string, delay: number | undefined): void;
  appendSessionEvent(event: SessionEvent): Promise<void>;
  scheduleManifest(): void;
}

export function completeDirectorTask(
  host: DirectorCompletionHost,
  payload: { task: TaskSpec; result: TaskResult },
): void {
  const r = payload.result;
  const settled = host.tasks.settle(r);
  if (settled.internal) {
    // Internal tasks (background probes, shadow passes) are exempt from
    // retire-on-complete — that policy is for the leader-visible one-shot
    // surface. But exemption must not mean "no bound": arm the subagent's
    // OWN idle window (spawn-time override or Director-wide default) so an
    // internal-only resident (e.g. the resident `explore-companion`) is
    // reaped after that window instead of living forever. Never retire-0
    // here — that would kill the resident mid-session, the opposite of
    // the exemption's intent.
    host.armSubagentIdleRetirement(
      r.subagentId,
      host.subagentIdleDelayMs.get(r.subagentId) ?? host.subagentIdleTimeoutMs,
    );
    return;
  }
  const title = host.tasks.descriptionFor(r.taskId, payload.task.description ?? r.taskId);
  if (!settled.consumedInBand && host.taskResultNotifier) {
    const resultText =
      typeof r.result === 'string'
        ? r.result
        : r.result !== undefined
          ? safeStringify(r.result)
          : undefined;
    try {
      void Promise.resolve(
        host.taskResultNotifier({
          taskId: r.taskId,
          title,
          status: r.status,
          subagentId: r.subagentId,
          subagentName: (host.manifestEntries.get(r.subagentId) as ManifestEntry | undefined)?.name,
          resultText,
          errorText: r.error ? `${r.error.kind}: ${r.error.message}` : undefined,
          partialText: r.partial?.text,
          report: r.report,
          iterations: r.iterations,
          toolCalls: r.toolCalls,
          durationMs: r.durationMs,
        }),
      ).catch(() => {});
    } catch (err) {
      // Sync throws from taskResultNotifier land here. Async throws are
      // swallowed by the inner .catch(() => {}) — acceptable degradation.
      // Sync throws must not be silently discarded: surface them as warnings.
      host.logger?.warn('[director] taskResultNotifier sync error', { err });
    }
  }
  const failed = r.status !== 'success';
  const errorString = r.error ? `${r.error.kind}: ${r.error.message}` : undefined;
  host.stateCheckpoint?.recordTaskStatus(r.taskId, {
    status: failed ? (r.status as 'failed' | 'timeout' | 'stopped') : 'completed',
    completedAt: new Date().toISOString(),
    iterations: r.iterations,
    toolCalls: r.toolCalls,
    durationMs: r.durationMs,
    error: errorString,
  });
  host.stateCheckpoint?.setUsage(host.usage.snapshot());
  void host.appendSessionEvent(
    failed
      ? {
          type: 'task_failed',
          ts: new Date().toISOString(),
          taskId: r.taskId,
          title,
          error: errorString ?? r.status,
        }
      : {
          type: 'task_completed',
          ts: new Date().toISOString(),
          taskId: r.taskId,
          title,
        },
  );
  if (failed) {
    void host.appendSessionEvent({
      type: 'agent_error',
      ts: new Date().toISOString(),
      agentId: r.subagentId,
      error: errorString ?? r.status,
    });
  }
  if (host.fleetManager) {
    void host.fleetManager.flushManifest();
  } else {
    host.scheduleManifest();
  }
  host.armSubagentIdleRetirement(
    r.subagentId,
    host.retireSubagentOnTaskComplete
      ? 0
      : (host.subagentIdleDelayMs.get(r.subagentId) ?? host.subagentIdleTimeoutMs),
  );
}
