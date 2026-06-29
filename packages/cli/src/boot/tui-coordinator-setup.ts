/**
 * AutonomousCoordinator setup — extracted from the TUI branch of execute().
 *
 * Phase B step 1. The coordinator tracks goals, tasks, knowledge, and
 * consensus across all active sessions in the same project. It is
 * initialized lazily when the Director becomes available so we have
 * access to director.fleet for cross-session events.
 *
 * This module owns:
 *   - The `ensureAutonomousCoordinator()` factory (constructs the
 *     coordinator, wires the LLM provider adapter, populates the
 *     mutable controller with 7 task-management callbacks)
 *   - The Director lifecycle hook (immediate wire if director exists,
 *     or deferred until the first `subagent.spawned` event)
 *
 * Mutations are written to `state.autonomousCoordinator` and
 * `state.coordinatorEvents` (both on the shared TuiRuntimeState).
 */
import * as path from 'node:path';
import {
  AutonomousCoordinator,
  type Context,
  type Director,
  type EventBus,
  type LLMProvider,
  type Mailbox,
} from '@wrongstack/core';
import type { WstackPaths } from '@wrongstack/core';
import type { TuiRuntimeState } from './tui-runtime-state.js';

export interface CoordinatorSetupContext {
  /** The shared mutable runtime state. */
  state: TuiRuntimeState;
  /** The main EventBus — used for the Director lifecycle hook. */
  events: EventBus;
  /** The agent's Context — provides provider, model, session id, transcript path. */
  context: Context;
  /** Resolved WrongStack paths — used for session-dir resolution. */
  wpaths: WstackPaths;
  /** The mailbox — cast to the core Mailbox interface for the coordinator. */
  mailbox: unknown;
  /** The Director (may be null — coordinator waits for lazy spawn). */
  director: Director | null | undefined;
  /** Optional getter for a lazily-created Director. */
  getDirector: (() => Director | null | undefined) | undefined;
  /** The mutable controller object slash commands read/write. */
  coordinatorController: Record<string, unknown> | undefined;
  /** Set by this module so execute()'s finally block can stop the coordinator. */
  onCoordinatorStopSetter: (fn: (() => void) | undefined) => void;
}

export interface CoordinatorSetupResult {
  /** The ensureAutonomousCoordinator function (idempotent). */
  ensure: () => AutonomousCoordinator | null;
  /** Call to remove the Director lifecycle listener (for TUI cleanup). */
  cleanup: () => void;
}

/**
 * Wire the AutonomousCoordinator and its Director lifecycle hook.
 *
 * Returns the `ensure` function (idempotent — returns the existing
 * coordinator if already created) and a `cleanup` function that removes
 * the event listener.
 */
export function setupAutonomousCoordinator(
  ctx: CoordinatorSetupContext,
): CoordinatorSetupResult {
  const { state, events, context, wpaths, mailbox, director, getDirector, coordinatorController, onCoordinatorStopSetter } = ctx;

  const ensure = (): AutonomousCoordinator | null => {
    if (state.autonomousCoordinator) return state.autonomousCoordinator;
    const currentDirector = getDirector?.() ?? director;
    if (!currentDirector) return null;

    // Resolve the session dir from the transcript path (e.g.
    // "~/.wrongstack/.../sessions/<date>/sess_<ULID>.jsonl" → parent dir). Fall back
    // to the global project dir when the writer is in-memory.
    const transcript = context.session.transcriptPath;
    const sessionDir = transcript
      ? path.dirname(transcript)
      : wpaths.projectDir;

    // Adapt Context.provider (Wire provider) to AutonomousBrain.LLMProvider
    // (one-method LLM call). The brain calls decide(prompt) → option+rationale.
    const llmProvider: LLMProvider = {
      decide: async (prompt) => {
        const sysPrompt = [
          {
            type: 'text' as const,
            text: 'You are the autonomous brain of a multi-agent coordination system. '
              + 'Pick the best option for the decision described and reply with JSON: '
              + '{"optionId":"<id>","rationale":"<short why>"}.',
          },
        ];
        const userPrompt = {
          type: 'text' as const,
          text: `Decision: ${prompt.question}\n\n`
            + `Context: ${JSON.stringify(prompt.context)}\n\n`
            + `Options:\n${prompt.options
              .map((o, i) => `  ${i + 1}. [${o.id}] ${o.label}${o.consequence ? ` — ${o.consequence}` : ''}`)
              .join('\n')}\n\n`
            + `Risk: ${prompt.risk}\n\n`
            + 'Reply with ONLY the JSON object.',
        };
        const resp = await context.provider.complete(
          {
            model: context.model,
            system: sysPrompt,
            messages: [
              {
                role: 'user',
                content: [userPrompt],
              },
            ],
            maxTokens: 1024,
            temperature: 0,
          },
          { signal: context.signal },
        );
        const text = resp.content
          .filter((b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        // Parse the JSON, tolerate code fences.
        const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
        try {
          const parsed = JSON.parse(cleaned) as { optionId?: string; rationale?: string };
          const optId = parsed.optionId ?? prompt.options[0]?.id ?? '';
          return { optionId: optId, rationale: parsed.rationale ?? '' };
        } catch {
          // Fallback: pick the first option.
          return { optionId: prompt.options[0]?.id ?? '', rationale: text };
        }
      },
    };

    state.autonomousCoordinator = new AutonomousCoordinator({
      sessionDir,
      fleet: currentDirector.fleet,
      fleetManager: currentDirector.fleetManager,
      director: currentDirector,
      mailbox: mailbox as never as Mailbox,
      selfAgentId: `leader@${context.session.id ?? 'unknown'}`,
      selfAgentName: 'Leader',
      llmProvider,
      onCoordinatorEvent: (event) => {
        for (const fn of state.coordinatorEvents) fn(event);
      },
    });

    // Wire the stop call so execute()'s finally block can cleanly shut down
    // the coordinator when the TUI exits (Ctrl+C, /exit, or session end).
    onCoordinatorStopSetter(() => state.autonomousCoordinator?.dispose());

    // Populate the mutable controller so slash commands (built before
    // execute() was called) can reach the coordinator callbacks.
    if (coordinatorController) {
      coordinatorController['onCoordinatorStart'] = (goal?: string) => {
        const coordinator = state.autonomousCoordinator;
        if (!coordinator) return;
        coordinator.run({ goal: goal ?? 'Improve the codebase', runUntilComplete: true })
          .then(() => undefined)
          .catch((err: unknown) => console.error('[coordinator] run() failed:', err));
      };
      coordinatorController['onCoordinatorStop'] = () => state.autonomousCoordinator?.stop();
      coordinatorController['onCoordinatorTasks'] = async () => {
        if (!state.autonomousCoordinator) return null;
        await state.autonomousCoordinator.graph.load();
        return state.autonomousCoordinator.auction
          .getPendingTasks()
          .map((task) => ({ id: task.id, title: task.title, priority: task.priority, tags: task.tags }));
      };
      coordinatorController['onCoordinatorClaim'] = async (taskId: string) => {
        if (!state.autonomousCoordinator) return 'No coordinator is active.';
        await state.autonomousCoordinator.graph.load();
        const goal = state.autonomousCoordinator.graph.get(taskId) as import('@wrongstack/core').GoalNode | undefined;
        if (goal?.type !== 'goal') return `Task ${taskId.slice(0, 8)} not found.`;
        if (goal.status !== 'pending') return `Task ${taskId.slice(0, 8)} is ${goal.status}, not claimable.`;
        const ok = await state.autonomousCoordinator.auction.claim(
          taskId, `terminal@${context.session.id ?? 'unknown'}`, 'Terminal worker',
        );
        if (!ok) return `Task ${taskId.slice(0, 8)} could not be claimed.`;
        return { description: goal.description };
      };
      coordinatorController['onCoordinatorComplete'] = async (taskId: string, result?: string) => {
        if (!state.autonomousCoordinator) return 'No coordinator is active.';
        await state.autonomousCoordinator.graph.load();
        const goal = state.autonomousCoordinator.graph.get(taskId) as import('@wrongstack/core').GoalNode | undefined;
        if (goal?.type !== 'goal') return `Task ${taskId.slice(0, 8)} not found.`;
        if (goal.status !== 'in_progress') return `Task ${taskId.slice(0, 8)} is ${goal.status}, cannot complete.`;
        await state.autonomousCoordinator.reportTaskCompletion(taskId, result ?? 'Terminal worker completed the task');
        return null;
      };
      coordinatorController['onCoordinatorFail'] = async (taskId: string, error: string) => {
        if (!state.autonomousCoordinator) return 'No coordinator is active.';
        await state.autonomousCoordinator.graph.load();
        const goal = state.autonomousCoordinator.graph.get(taskId) as import('@wrongstack/core').GoalNode | undefined;
        if (goal?.type !== 'goal') return `Task ${taskId.slice(0, 8)} not found.`;
        if (goal.status !== 'in_progress') return `Task ${taskId.slice(0, 8)} is ${goal.status}, cannot fail.`;
        await state.autonomousCoordinator.reportTaskFailure(taskId, error);
        return null;
      };
      coordinatorController['onCoordinatorStatus'] = async () => {
        if (!state.autonomousCoordinator) return null;
        await state.autonomousCoordinator.syncFromGraph();
        const stats = state.autonomousCoordinator.getStats();
        return {
          goals: { total: stats.goals.total, done: stats.goals.done, pending: stats.goals.pending, failed: stats.goals.failed },
          dag: { running: stats.dag.running, ready: stats.dag.ready, done: stats.dag.done, failed: stats.dag.failed },
          auction: { pending: stats.auction.pending, inProgress: stats.auction.in_progress },
        };
      };
    }

    return state.autonomousCoordinator;
  };

  // Hook into Director lifecycle: Director is created lazily on first subagent.spawned.
  // If it already exists, wire immediately; otherwise wait for the spawn event.
  if (director) ensure();
  const offDirectorSpawned = events.onPattern('subagent.spawned', () => {
    if (ensure()) offDirectorSpawned();
  });

  return {
    ensure,
    cleanup: () => offDirectorSpawned(),
  };
}
