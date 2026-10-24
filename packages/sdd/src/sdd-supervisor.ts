// SddSupervisor — a decision agent over an SDD parallel run.
//
// When a task has exhausted its retries and is about to go terminal, the
// SddParallelRun consults `superviseFailure` (see SddParallelRunOptions). This
// supervisor answers that consult by asking a BrainArbiter (policy → LLM →
// human, reused from the coordination layer) whether to retry, reassign to a
// different model, split the task into sub-tasks, or give up. The goal is the
// user's: a run should "decide" rather than dead-end — never silently get stuck.
//
// Safe by default: with the conservative DefaultBrainArbiter (no LLM) the
// `fallback: 'continue'` policy resolves to a plain retry, so wiring a supervisor
// never makes a run worse — it only adds intelligence when an LLM brain is wired.

import type { TaskNode } from '@wrongstack/contracts/types';
import { parseModelRef } from '@wrongstack/core/agent';
import type { BrainArbiter } from '@wrongstack/core/coordination';
import type { SddSubtaskSpec, SddSupervisorVerdict } from './sdd-parallel-run.js';

export interface SddSupervisorOptions {
  /** Decision authority (policy/LLM/human). Reuse the session's TOKENS.BrainArbiter. */
  brain: BrainArbiter;
  /** Session that started this run, retained when another tab becomes foreground. */
  sessionId?: string | undefined;
  /**
   * Models to rotate through on a `reassign` verdict (e.g. the run's fallback
   * chain). Omit to drop the reassign option entirely.
   */
  reassignModels?: string[] | undefined;
  /**
   * Optional sub-task generator for a `split` verdict — typically an LLM call
   * that decomposes the failing task into smaller pieces. Omit to drop the split
   * option. Returning an empty array degrades the split into a retry.
   */
  generateSubtasks?:
    | ((info: { task: TaskNode; error: string }) => Promise<SddSubtaskSpec[]>)
    | undefined;
  /**
   * Let the tiered brain's LLM layer actually pick the verdict.
   *
   * Default (false) requests `fallback: 'continue'`, which the policy layer
   * answers immediately (a bounded retry) — the LLM never runs, so `reassign`/
   * `split` can't be chosen. Set true to request `fallback: 'ask_human'`, which
   * makes the policy escalate so the autonomous (LLM) layer decides.
   *
   * ONLY enable this when the supplied `brain` will NOT block on a human prompt
   * for an unresolved decision (i.e. it has an autonomous layer and is NOT
   * wrapped in `HumanEscalatingBrainArbiter`). When the LLM can't decide (no
   * autonomous layer / over the risk ceiling / LLM down) the brain returns
   * `ask_human`, which the supervisor degrades to a **bounded retry** (never a
   * block, never a dead-end). A human-escalating brain would instead block
   * inside `decide()` and wedge the run — keep this false there.
   */
  requestLlmVerdict?: boolean | undefined;
}

export class SddSupervisor {
  constructor(private readonly opts: SddSupervisorOptions) {}

  /**
   * Bind this as `SddParallelRunOptions.superviseFailure`. Returns a verdict the
   * run applies, or `undefined`/`{action:'fail'}` to let the task terminal-fail.
   */
  readonly superviseFailure = async (info: {
    task: TaskNode;
    error: string;
    attempts: number;
  }): Promise<SddSupervisorVerdict | undefined> => {
    const { task, error, attempts } = info;
    const canReassign = (this.opts.reassignModels?.length ?? 0) > 0;
    const canSplit = Boolean(this.opts.generateSubtasks);

    const decision = await this.opts.brain.decide({
      id: `sdd-supervisor-${task.id}-${attempts}`,
      sessionId: this.opts.sessionId,
      source: 'system',
      question: `SDD task "${task.title}" exhausted its retries. How should the run proceed?`,
      context: `Error: ${error}\nSupervisor rescues already used: ${attempts}`,
      options: [
        { id: 'retry', label: 'Retry the task as-is', recommended: true },
        ...(canReassign ? [{ id: 'reassign', label: 'Reassign to a different model' }] : []),
        ...(canSplit ? [{ id: 'split', label: 'Split into smaller sub-tasks' }] : []),
        { id: 'fail', label: 'Give up and mark the task failed' },
      ],
      // Higher risk once we've already rescued it once — pushes a wired LLM/human
      // toward a decisive verdict instead of looping retries.
      risk: attempts >= 1 ? 'high' : 'medium',
      // `continue` → policy answers in place (bounded retry, LLM never runs).
      // `ask_human` → policy escalates so the autonomous LLM layer can actually
      // pick reassign/split (see requestLlmVerdict's safety contract).
      fallback: this.opts.requestLlmVerdict ? 'ask_human' : 'continue',
    });

    // A hard deny is a decisive "give up" → terminal fail. An unresolved
    // escalation (`ask_human`: the LLM declined / was unavailable / over the
    // ceiling) degrades to a bounded retry so the run keeps moving rather than
    // dead-ending — the never-stuck invariant. (A human-escalating brain would
    // have blocked inside decide() already; requestLlmVerdict forbids that.)
    if (decision.type === 'deny') return { action: 'fail' };
    if (decision.type !== 'answer') return { action: 'retry' };
    // DefaultBrainArbiter's 'continue' answer carries no optionId → retry.
    const choice = decision.optionId ?? 'retry';

    if (choice === 'fail') return { action: 'fail' };
    if (choice === 'reassign' && canReassign) {
      const models = this.opts.reassignModels as string[];
      // Rotate through the chain by rescue count; a `provider/model` entry sets
      // both fields so the worker dispatches on the right provider (a bare model
      // keeps the task's current provider).
      const ref = models[attempts % models.length];
      const parsed = ref ? parseModelRef(ref) : undefined;
      return { action: 'reassign', model: parsed?.model, provider: parsed?.provider };
    }
    if (choice === 'split' && this.opts.generateSubtasks) {
      const subtasks = await this.opts
        .generateSubtasks({ task, error })
        .catch(() => [] as SddSubtaskSpec[]);
      return subtasks.length ? { action: 'split', subtasks } : { action: 'retry' };
    }
    return { action: 'retry' };
  };
}
