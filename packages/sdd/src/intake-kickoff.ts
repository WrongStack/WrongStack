/**
 * Requirements Intake → SDD interview kickoff.
 *
 * Bridges `@wrongstack/requirement-intake` records into the spec-builder
 * interview. The original request stays the interview's intent verbatim;
 * collected high-level facts (goal, outcome, constraints, target users) are
 * folded into the project context the questioning prompt receives. Nothing
 * here rewrites or summarizes the original request — it only routes it.
 */
import type { RequirementIntakeRecord } from '@wrongstack/requirement-intake';
import type { SddInterviewDriver } from './sdd-interview-driver.js';

/** Short, single-line heading derived from a (possibly long) title/request. */
function deriveTitle(value: string): string {
  const firstLine = value
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return 'New SDD Project';
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  return sentence.length <= 64 ? sentence : `${sentence.slice(0, 63).trimEnd()}…`;
}

export interface IntakeInterviewKickoff {
  /** Short interview title (≤ 64 chars, first sentence of the record title). */
  title: string;
  /** Interview intent — the exact original request, verbatim. */
  intent: string;
  /** Extra project context (goal/outcome/constraints/users) for the prompt. */
  projectContext: string;
}

/**
 * Map an intake record to interview kickoff values. `intent` is the exact
 * `originalRequest`; `projectContext` carries the collected high-level fields
 * so the spec interview does not re-ask for already-provided information.
 */
export function intakeToInterviewKickoff(record: RequirementIntakeRecord): IntakeInterviewKickoff {
  const contextLines: string[] = [];
  if (record.businessGoal) contextLines.push(`Business goal: ${record.businessGoal}`);
  if (record.expectedOutcome) contextLines.push(`Expected outcome: ${record.expectedOutcome}`);
  if (record.scopeNotes) contextLines.push(`Scope notes: ${record.scopeNotes}`);
  for (const targetUser of record.targetUsers) contextLines.push(`Target user: ${targetUser}`);
  for (const constraint of record.constraints) contextLines.push(`Constraint: ${constraint}`);
  for (const context of record.providedContext) contextLines.push(`Context: ${context}`);

  return {
    title: deriveTitle(record.title),
    intent: record.originalRequest,
    projectContext: contextLines.length > 0 ? contextLines.join('\n') : '',
  };
}

/**
 * Start a spec-builder interview from an intake record. Returns the first AI
 * prompt (a question kickoff), ready to feed the agent loop. The driver should
 * be constructed with `projectContext: kickoff.projectContext` so the
 * questioning prompt already knows the collected facts.
 */
export function startInterviewFromIntake(
  driver: Pick<SddInterviewDriver, 'start'>,
  record: RequirementIntakeRecord,
): string {
  const kickoff = intakeToInterviewKickoff(record);
  return driver.start(kickoff.title, kickoff.intent);
}
