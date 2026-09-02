/**
 * `/goal <description>` preamble — the "no force can stop this" mode.
 *
 * Unlike STEERING (which redirects mid-flight), GOAL is a contract:
 * the user hands over a problem, the agent commits to verifiably
 * finishing it, and every iteration re-reads this preamble from the
 * conversation history. The hardening is entirely prompt-level —
 * the system has already removed implicit budget caps, so this
 * preamble's job is to remove the MODEL's tendency to hedge, ask
 * permission, or declare premature success.
 *
 * The four sections are intentional:
 *   1. AUTHORITY — explicit grant of unbounded fan-out + model
 *      switching. Without this the model self-throttles ("I shouldn't
 *      spawn too many…") even when budgets are unlimited.
 *   2. DONE — concrete bar for completion. Forces a verifiable
 *      artifact (test passing, file written, bug re-run clean).
 *      Without this the model returns "I believe it's fixed" and
 *      counts that as done.
 *   3. NOT DONE — explicit anti-patterns. Each item is something we
 *      saw real agents do as a "completion" that wasn't.
 *   4. PERSISTENCE — three-angle rule for blockers. Stops the model
 *      from giving up on the first tool failure.
 *
 * Located in @wrongstack/core (rather than @wrongstack/tui) so headless
 * callers and the WebUI can issue `/goal set` without dragging the TUI
 * package in. The tui re-exports this for backward compatibility.
 */
import {
  readBundledInstructionText,
  renderInstructionTemplate,
} from '../utils/instruction-file.js';

export function buildGoalPreamble(goal: string, deliverables?: string[]): string {
  const deliverableBlock =
    deliverables && deliverables.length > 0
      ? [
          'CONCRETE DELIVERABLES (check these off as you go):',
          ...deliverables.map((d, i) => `  ${i + 1}. ${d}`),
          '',
          'After EACH iteration, estimate your completion percentage (0–100)',
          'against this deliverable list. Output it as:',
          '  [PROGRESS: N%] — <1-sentence status>',
          'The eternal engine reads this to update the progress bar.',
        ].join('\n')
      : '';

  return renderInstructionTemplate(readBundledInstructionText('autonomy/goal-preamble.md'), {
    goal,
    deliverables: deliverableBlock,
  });
}
