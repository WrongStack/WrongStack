import type { State } from './app-reducer.js';

/**
 * Build the steering preamble that gets prepended to a user's message
 * after they pressed Esc to interrupt the agent. The preamble carries
 * three things the model would otherwise have to infer:
 *
 *   1. Context — exactly what was in flight (tool calls, subagents,
 *      partial assistant text). Without this the model rationalizes
 *      from chat scrollback and often resumes the prior task by
 *      accident.
 *   2. Authority — a short, explicit list of what the model is
 *      allowed to do (abandon the prior plan, respawn fresh
 *      subagents, ask for clarification). Models hedge unless they
 *      believe they have permission to pivot hard.
 *   3. New direction — the user's actual instruction, fenced off.
 *
 * The block is user-role plain text. We deliberately don't use a
 * system role here — the human triggered this, so accountability
 * stays with their turn and the model can challenge / clarify
 * without violating role separation.
 *
 * Exported for the steering test that pins the contract.
 */
export function buildSteeringPreamble(
  snapshot: State['steerSnapshot'],
  newDirection: string,
): string {
  const lines: string[] = ['[STEERING — I pressed Esc to interrupt you mid-task on purpose.', ''];

  // Section 1: what was running. Even an empty list is useful —
  // tells the model "you weren't doing much yet, no work to mourn".
  const ctx: string[] = [];
  if (snapshot?.runningTools && snapshot.runningTools.length > 0) {
    ctx.push(`- in-flight tools (now cancelled): ${snapshot.runningTools.join(', ')}`);
  }
  if (snapshot?.subagentsTerminated && snapshot.subagentsTerminated > 0) {
    const subDetails = snapshot.subagents
      .map(
        (s: { label: string; tool?: string | undefined }) =>
          `${s.label}${s.tool ? ` (was running: ${s.tool})` : ''}`,
      )
      .join(', ');
    ctx.push(
      `- subagents (${snapshot.subagentsTerminated} terminated by me, do NOT await them): ${subDetails}`,
    );
  }
  if (snapshot?.partialAssistantText && snapshot.partialAssistantText.trim().length > 0) {
    const tail = snapshot.partialAssistantText.trim().slice(-300);
    ctx.push(`- your last partial output (truncated, for context only): "${tail}"`);
  }
  if (ctx.length > 0) {
    lines.push('What was happening when I cut you off:');
    lines.push(...ctx);
    lines.push('');
  }

  // Section 2: authority. Explicit grant so the model doesn't hedge.
  lines.push('You have authority to:');
  lines.push('- Abandon the prior plan entirely if the new direction makes it stale.');
  lines.push('- Re-spawn fresh subagents (with different roles or tasks) if needed.');
  lines.push('- Skip a polite "should I continue?" — just pivot.');
  lines.push('- Ask me to clarify if the new direction is genuinely ambiguous.');
  lines.push('');

  // Section 3: the user's instruction, fenced so the model can't
  // mistake it for part of the preamble.
  lines.push('New direction:');
  lines.push('---');
  lines.push(newDirection);
  lines.push('---');
  lines.push(']');

  return lines.join('\n');
}
