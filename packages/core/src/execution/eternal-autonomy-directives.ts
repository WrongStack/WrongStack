import { gitIsolationEnv } from '@wrongstack/primitives';
import type { GoalFile, JournalEntry } from '../storage/goal-store.js';

import { toErrorMessage } from '../utils/error.js';

import { BRAINSTORM_DONE, execFileP } from './eternal-autonomy-directives-types.js';
import type { EternalAutonomyOptions } from './eternal-autonomy-types.js';
export interface EternalAutonomyDirectivesHost {
  opts: EternalAutonomyOptions;
  readGitStatus: () => Promise<string>;
  logError: (msg: string, ctx?: Record<string, unknown>) => void;
}
export async function pickGitTask(host: EternalAutonomyDirectivesHost): Promise<string | null> {
  let out: string;
  try {
    out = await (host.opts.gitStatusReader?.() ?? host.readGitStatus());
  } catch {
    return null;
  }
  const dirty = out.trim();
  if (!dirty) return null;
  // Surface a concise prompt — the agent will look at the diff itself.
  const lines = dirty.split('\n').slice(0, 8);
  const preview = lines.join(', ');
  return `Inspect the dirty working tree and either finish the in-progress work or revert it. Files: ${preview}`;
}

export async function readGitStatus(host: EternalAutonomyDirectivesHost): Promise<string> {
  // The repository's config names programs `status` runs (fsmonitor,
  // `.gitattributes` filters); when they cannot be switched off, git does not run.
  const isolation = await gitIsolationEnv(host.opts.projectRoot, { timeoutMs: 5_000 });
  if (!isolation)
    throw new Error('git isolation unavailable: the repository config could not be read');
  const { stdout } = await execFileP('git', ['status', '--porcelain'], {
    cwd: host.opts.projectRoot,
    env: { ...process.env, ...isolation },
    timeout: 5_000,
  });
  return stdout;
}

export async function brainstormTask(
  host: EternalAutonomyDirectivesHost,
  goal: GoalFile,
): Promise<string | null | typeof BRAINSTORM_DONE> {
  const lastFew = goal.journal
    .slice(-5)
    .map((e) => `  - [${e.status}] ${e.task}`)
    .join('\n');
  const directive = [
    'You are deciding the next action in an autonomous loop pursuing a long-running goal.',
    '',
    `Goal: ${goal.goal}`,
    '',
    lastFew ? `Recent iterations:\n${lastFew}` : 'No prior iterations yet.',
    '',
    'Output ONE concrete, immediately-actionable task that advances the goal.',
    'Constraints:',
    '- One sentence, imperative form, under 200 chars.',
    '- No preamble, no explanation, no markdown — just the task line.',
    '- If recent iterations show repeated failures on the same target, pivot.',
    '- If the goal appears fully accomplished AND you can name a concrete',
    '  artifact / test / output that proves it, output exactly: DONE',
    '- Once all deliverables of the goal are verified, output DONE immediately',
    '  rather than inventing nice-to-have polish or extra iterations.',
    '- Be conservative with DONE when unresolved failures remain: if the latest',
    '  journal entries show an unfixed failure or abort, the goal is NOT done.',
  ].join('\n');

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const result = await host.opts.agent.run([{ type: 'text' as const, text: directive }], {
        signal: ctrl.signal,
        maxIterations: 1,
      });
      if (result.status !== 'done') return null;
      const text = (result.finalText ?? '').trim();
      if (!text) return null;
      // Distinct sentinel for DONE so the caller can count consecutive
      // DONE answers toward a real stop. The old `return null` path
      // conflated "no work" with "engine failure" and looped forever.
      if (/^DONE\.?$/i.test(text)) return BRAINSTORM_DONE;
      // Take the first non-empty line and clip to 240 chars.
      const firstLine = text
        .split('\n')
        .find((l) => l.trim().length > 0)
        ?.trim();
      if (!firstLine) return null;
      if (/^DONE\.?$/i.test(firstLine)) return BRAINSTORM_DONE;
      return firstLine.slice(0, 240);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    host.logError('Brainstorm failed', {
      event: 'autonomy.brainstorm_failed',
      message: toErrorMessage(err),
      context: { goal: goal.goal.slice(0, 100) },
    });
    return null;
  }
}

/** End a journal-note cut on a code-point boundary (never emit half a surrogate pair). */
function clipNote(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

export function buildDirective(
  _host: EternalAutonomyDirectivesHost,
  goal: GoalFile,
  source: JournalEntry['source'],
  task: string,
): string {
  const recentJournal = goal.journal
    .slice(-5)
    .map(
      (e) =>
        `  #${e.iteration} [${e.status}] ${e.task}${e.note ? ` — ${clipNote(e.note, 80)}` : ''}`,
    )
    .join('\n');
  return [
    '═══ ETERNAL AUTONOMY — iteration directive ═══',
    '',
    `Mission: ${goal.goal}`,
    `Iteration: #${goal.iterations + 1}`,
    `Source: ${source}`,
    `Task: ${task}`,
    '',
    recentJournal ? `Recent journal (last 5):\n${recentJournal}` : 'No prior iterations.',
    '',
    '── EXECUTION PROTOCOL ──',
    'You are inside a long-running autonomous loop. Each iteration you',
    'execute ONE concrete task that advances the Mission. No user is',
    'available to clarify — make defensible decisions and move forward.',
    '',
    '1. EXECUTE END-TO-END',
    '   • Use multiple tool calls freely. Emit `[continue]` on its own line',
    '     to chain to the next internal step without returning.',
    "   • When this iteration's Task is finished (real artifact / passing",
    '     test / applied diff / clean output), emit `[done]` on its own line.',
    '   • Do not stop on the first obstacle — try at least 3 distinct',
    '     approaches before giving up. YOLO is active unless an explicit',
    '     deny rule blocks the call.',
    '',
    '2. UPDATE TODO STATE (when Source is `todo`)',
    '   • Mark this todo `in_progress` via the todos tool before tool work.',
    '   • Mark it `completed` on success, with a one-line outcome note.',
    '   • If you cannot make progress after 2 distinct attempts, mark it',
    '     `cancelled` with the obstacle. The loop will skip it next time.',
    '',
    '3. MISSION-COMPLETE PROTOCOL',
    '   • If — and ONLY if — the OVERALL Mission (not just this Task) is',
    '     verifiably accomplished, emit on its own line:',
    '         [GOAL_COMPLETE]',
    '     followed by a one-paragraph verification recipe (artifact path,',
    '     test command, or 10-second reproduction). This halts the loop.',
    '   • NEVER emit [GOAL_COMPLETE] on optimism, partial progress, or',
    '     "looks fine". Required: a concrete artifact that proves it AND',
    '     no unresolved journal failures contradicting completion.',
    '   • Once all required deliverables of the Mission are verified, emit',
    '     `[GOAL_COMPLETE]` immediately — do not invent extra polish rounds.',
    '   • If unsure, emit `[done]` instead and let the next iteration',
    '     decide. The loop is patient; false completion is not.',
    '',
    '4. NO INTERACTIVITY',
    '   • Do not ask questions, do not request confirmation, do not propose',
    '     options. Pick the best path and execute. The user is asleep.',
  ].join('\n');
}
