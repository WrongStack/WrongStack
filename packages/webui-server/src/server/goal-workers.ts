import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger, Usage } from '@wrongstack/contracts/types';
import { type AgentFactory, assignNickname } from '@wrongstack/coordination';
import type { Agent, Context } from '@wrongstack/core/agent';
import { toErrorMessage } from '@wrongstack/core/utils';
import { GoalAssessor, type GoalAssessResult, type PhaseNode } from '@wrongstack/goal';
import type { WebSocket } from 'ws';
import { sendSerialized } from './ws-utils.js';

export interface GoalWorkerHost {
  readonly usedNicknames: Set<string>;
  broadcastState(activePhaseId?: string): void;
  readonly abort: AbortController | null;
  readonly taskAgentFactory: AgentFactory | undefined;
  readonly context: Context;
  readonly agent: Agent;
  readonly projectRoot: string | undefined;
  readonly logger: Logger;
  assessAbort: AbortController | null;
  assessSeq: number;
}

export async function executeGoalTask(
  host: GoalWorkerHost,
  task: import('@wrongstack/contracts/types').TaskNode,
  phaseId: string,
  env?: { cwd?: string | undefined; branch?: string | undefined },
  signal?: AbortSignal | undefined,
  onUsage?: ((usage: Usage) => void) | undefined,
): Promise<unknown> {
  /** Reports the provider usage of this task's agent run (Goal token budgets). */
  // Embedders' factories may omit the bus despite the type; such a task is simply not metered.
  const meter = (events: EventBus | undefined) =>
    onUsage && typeof events?.on === 'function'
      ? events.on('provider.response', (event) => {
          try {
            onUsage(event.usage);
          } catch {
            // A budget observer must not break the task run.
          }
        })
      : () => {};
  // Give the task a human worker identity (reuse a manual assignment if one
  // exists) so the board shows who is running it; reflect it on the node and
  // push a live state update before the (long) run begins.
  if (!task.assignee) {
    const nick = assignNickname('executor', host.usedNicknames);
    host.usedNicknames.add(nick.key);
    task.assignee = nick.display.replace(/\s*\([^)]*\)\s*$/, '');
    task.updatedAt = Date.now();
    host.broadcastState();
  }

  const prompt = `Execute task: ${task.title}\n\nDescription: ${task.description}\nPhase: ${phaseId}\nPriority: ${task.priority}\nType: ${task.type}`;
  // Combine the orchestrator's per-task signal (fired by stop() or the
  // task timeout) with the run-wide abort so either cancels the agent run.
  const runSignal =
    signal && host.abort?.signal
      ? AbortSignal.any([host.abort.signal, signal])
      : (signal ?? host.abort?.signal ?? new AbortController().signal);
  if (host.taskAgentFactory) {
    const built = await host.taskAgentFactory({
      name: `goal-${task.assignee ?? 'executor'}`.slice(0, 48),
      role: 'executor',
      cwd: env?.cwd,
      allowedCapabilities: [
        'fs.read',
        'fs.write',
        'shell.restricted',
        'shell.exec',
        'net.outbound',
        'package.install',
      ],
    });
    const unmeter = meter(built.events);
    try {
      const result = (await built.agent.run(prompt, { signal: runSignal })) as {
        status?: string | undefined;
        finalText?: string | undefined;
        error?: { message?: string | undefined } | undefined;
      };
      if (result.status !== 'done') {
        throw new Error(
          result.error?.message ?? `Goal task ended with status "${result.status ?? 'unknown'}"`,
        );
      }
      return result.finalText ?? '';
    } finally {
      unmeter();
      await built.dispose?.();
    }
  }

  // Backward-compatible fallback for embedders that have not supplied a
  // factory. Sequential execution makes this cwd swap safe, but first-party
  // CLI/standalone hosts always inject isolated workers.
  const prevCwd = host.context.cwd;
  if (env?.cwd) host.context.cwd = env.cwd;
  const unmeter = meter(host.agent.events);
  try {
    const result = (await host.agent.run(prompt, { signal: runSignal })) as {
      status?: string | undefined;
      finalText?: string | undefined;
      error?: { message?: string | undefined } | undefined;
    };
    if (result.status !== 'done') {
      throw new Error(
        result.error?.message ?? `Goal task ended with status "${result.status ?? 'unknown'}"`,
      );
    }
    return result.finalText ?? '';
  } finally {
    unmeter();
    host.context.cwd = prevCwd;
  }
}

export async function repairGoalPhase(
  host: GoalWorkerHost,
  phase: PhaseNode,
  failure: string,
  attempt: number,
  env?: { cwd?: string | undefined; branch?: string | undefined },
): Promise<void> {
  const cwd = env?.cwd ?? host.projectRoot ?? host.context.cwd;
  const prompt = `Fix the verification failures in the project at ${cwd}. Verifier output:\n\n${failure.slice(0, 4000)}\n\nRun the project's configured typecheck/lint scripts to verify the fix. Output the fixed file paths.`;
  host.logger.info(`[Goal] Repair attempt ${attempt} for phase "${phase.name}" in ${cwd}`);
  if (host.taskAgentFactory) {
    const built = await host.taskAgentFactory({
      name: `goal-repair-${phase.name}`.slice(0, 48),
      role: 'executor',
      cwd,
      allowedCapabilities: [
        'fs.read',
        'fs.write',
        'shell.restricted',
        'shell.exec',
        'net.outbound',
        'package.install',
      ],
    });
    try {
      const result = (await built.agent.run(prompt, { signal: host.abort?.signal })) as {
        status?: string | undefined;
        error?: { message?: string | undefined } | undefined;
      };
      if (result.status !== 'done') {
        throw new Error(
          result.error?.message ?? `Goal repair ended with status "${result.status}"`,
        );
      }
    } finally {
      await built.dispose?.();
    }
    return;
  }

  // Compatibility path for embedders without a worker factory.
  const previousCwd = host.context.cwd;
  host.context.cwd = cwd;
  try {
    const result = (await host.agent.run(prompt, { signal: host.abort?.signal })) as {
      status?: string | undefined;
      error?: { message?: string | undefined } | undefined;
    };
    if (result.status !== 'done') {
      throw new Error(result.error?.message ?? `Goal repair ended with status "${result.status}"`);
    }
  } finally {
    host.context.cwd = previousCwd;
  }
}

export async function assessGoal(
  host: GoalWorkerHost,
  ws: WebSocket,
  payload?: Record<string, unknown>,
): Promise<void> {
  const goal = (payload?.goal as string) || '';
  const seq = (payload?.seq as number) ?? 0;

  // Abort any prior assessment so its LLM call stops and frees the Agent's
  // single-flight guard (_runInProgress), allowing this new assessment to
  // start without waiting. The stale-seq guard below still catches any
  // race between abort and the new seq being set.
  host.assessAbort?.abort();
  host.assessAbort = new AbortController();
  const signal = host.assessAbort.signal;

  const mySeq = ++host.assessSeq;

  const sendResult = (result: GoalAssessResult) => {
    // Stale guard: if a newer assessment arrived while this one was running,
    // discard the response. The client also has its own reqSeq guard.
    if (mySeq !== host.assessSeq) return;
    sendSerialized(
      ws,
      JSON.stringify({
        type: 'goal.assess.result',
        payload: { ...result, reqSeq: seq },
      }),
    );
  };

  if (!goal.trim()) {
    sendResult({
      realistic: true,
      durationClaimed: null,
      explanation: '',
      recommendedDuration: null,
      concerns: [],
      raw: '',
      parseFailed: false,
    });
    return;
  }

  try {
    const assessor = new GoalAssessor({
      goal,
      runOnce: async (prompt: string) => {
        const result = (await host.agent.run(prompt, { signal })) as {
          status: string;
          finalText?: string | undefined;
        };
        return result.status === 'done' ? (result.finalText ?? '') : '';
      },
    });
    const result = await assessor.assess();
    sendResult(result);
  } catch (err: unknown) {
    // Stale guard: skip logging+response if superseded.
    if (mySeq !== host.assessSeq) return;
    host.logger.error(`[Goal] Assessment failed: ${toErrorMessage(err)}`);
    sendResult({
      realistic: true,
      durationClaimed: null,
      explanation: '',
      recommendedDuration: null,
      concerns: [],
      raw: '',
      parseFailed: true,
      parseError: `Assessment error: ${toErrorMessage(err)}`,
    });
  }
}
