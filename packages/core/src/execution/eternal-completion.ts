import {
  appendJournal,
  type GoalFile,
  type JournalEntry,
  saveGoal,
} from '../storage/goal-store.js';
import { formatDecisionSummary } from './autonomy-brain.js';

export interface EternalCompletionHost {
  loadGoal: () => Promise<import('../storage/goal-store.js').GoalFile | null>;
  goalPath: string;
  opts: import('./eternal-autonomy-types.js').EternalAutonomyOptions;
  appendIterationEntry: (
    entry: Omit<import('../storage/goal-store.js').JournalEntry, 'iteration' | 'at'>,
  ) => Promise<void>;
  consecutiveBrainstormDone: number;
}

/** End a journal-field cut on a code-point boundary (never emit half a surrogate pair). */
function clipJournalText(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

export async function markGoalCompleted(
  this: EternalCompletionHost,
  action: { source: JournalEntry['source']; task: string; directive: string },
  note: string,
): Promise<void> {
  const current = await this.loadGoal();
  if (!current) return;
  if (current.goalState === 'completed') return;
  const withFlag: GoalFile = { ...current, goalState: 'completed' };
  const withEntry = appendJournal(withFlag, {
    source: action.source,
    task: clipJournalText(`MISSION COMPLETE — ${action.task}`, 240),
    status: 'success',
    note: clipJournalText(note, 240),
  });
  await saveGoal(this.goalPath, withEntry, this.opts.events);
  // Remove the goal file so it doesn't persist as stale state.
  // A completed goal should be gone — the user creates a new one
  // with `/goal set` when they want to work on something else.
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(this.goalPath);
  } catch {
    // best-effort — file may already be gone
  }
  // Fire stop callbacks so the REPL knows to exit eternal mode
  // and show a goal-completion banner. Without this the engine
  // stops internally but the REPL keeps spinning in the eternal loop.
  this.opts.onEternalStop?.();
}

export async function clearGoalManually(this: EternalCompletionHost, note: string): Promise<void> {
  const current = await this.loadGoal();
  if (current) {
    const abandoned: GoalFile = { ...current, goalState: 'abandoned' };
    await saveGoal(this.goalPath, abandoned, this.opts.events);
  }
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(this.goalPath);
  } catch {
    // best-effort — file may already be gone
  }
  this.opts.onEternalStop?.();
  // Best-effort journal write — a Windows EPERM/ENOENT on the goal file
  // during /goal clear must not surface as an unhandled rejection.
  void this.appendIterationEntry({
    source: 'manual',
    task: 'goal cleared',
    status: 'success',
    note: clipJournalText(note, 240),
  }).catch(() => {});
}

export async function consultBrainForDone(
  this: EternalCompletionHost,
  goal: GoalFile,
): Promise<boolean> {
  if (!this.opts.brain) return true; // No brain — trust the heuristic

  const deliverablesStatus = goal.deliverables?.length
    ? `\nDeliverables: ${goal.deliverables.length} total, progress ${goal.progress ?? 'unknown'}%`
    : '';
  const recentJournal = goal.journal
    .slice(-5)
    .map((e) => `  #${e.iteration} [${e.status}] ${e.task}`)
    .join('\n');

  try {
    const decision = await this.opts.brain.decide({
      id: `goal-done-${goal.iterations}`,
      sessionId: this.opts.agent.ctx.session?.id,
      source: 'system',
      question: `Brainstorm returned DONE ${this.consecutiveBrainstormDone}x. Is the goal truly complete?`,
      context: [
        `Goal: ${goal.goal}`,
        `Iterations: ${goal.iterations}`,
        `Progress: ${goal.progress ?? 'unknown'}%`,
        deliverablesStatus,
        recentJournal ? `\nRecent work:\n${recentJournal}` : '',
      ].join('\n'),
      risk: 'high',
      fallback: 'continue',
      // Structured verdict — completion is control-plane input, decided by
      // exact option id rather than sniffing prose for "done"/"complete".
      options: [
        {
          id: 'goal_complete',
          label: 'The goal is complete — stop the eternal run',
          consequence: 'The engine stops and the goal file is archived.',
          risk: 'high',
        },
        {
          id: 'keep_working',
          label: 'Not complete yet — keep working',
          consequence: 'The engine continues iterating on the goal.',
          risk: 'low',
        },
      ],
    });

    // Log the brain decision into the journal
    const summary = formatDecisionSummary(decision, {
      id: `goal-done-${goal.iterations}`,
      source: 'system',
      question: 'Is the goal complete?',
      risk: 'high',
      fallback: 'continue',
    });
    const rationale = 'rationale' in decision ? decision.rationale : undefined;
    await this.appendIterationEntry({
      source: 'brainstorm',
      task: summary,
      status: 'success',
      note: rationale,
    });

    if (decision.type === 'deny') {
      return false;
    }
    if (decision.type === 'answer') {
      // Exact option id only. An answer that names neither option (e.g. a
      // policy fallback "continue") conservatively keeps the run alive —
      // never stop on prose.
      return decision.optionId === 'goal_complete';
    }
    return false;
  } catch {
    return false;
  }
}
