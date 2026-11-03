export const BUG_HUNT_LIMITS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export type BugHuntLimit = (typeof BUG_HUNT_LIMITS)[number];

export const BUG_HUNT_MODES = [
  'bughunt',
  'sechunt',
  'racehunt',
  'debloat',
  'uipolish',
  'typehunt',
  'testgap',
] as const;

export type BugHuntMode = (typeof BUG_HUNT_MODES)[number];

/**
 * Card and dropdown labels for each Proof-Driven Hunt mode.
 *
 * Kept next to the mode list rather than in the i18n catalog, matching
 * `PERF_RUN_MODE_LABELS` in `perf-run-message.ts`: these are the canonical
 * names of the built-in protocols.
 */
export const BUG_HUNT_MODE_LABELS: Record<BugHuntMode, string> = {
  bughunt: 'Proof-Driven Bug Hunter',
  sechunt: 'Proof-Driven Security Hardener',
  racehunt: 'Proof-Driven Race & Leak Hunter',
  debloat: 'Proof-Driven Dead-Code & Bloat Excisor',
  uipolish: 'Proof-Driven UI & Accessibility Ratchet',
  typehunt: 'Proof-Driven Type & Boundary Guard',
  testgap: 'Proof-Driven Blind-Spot & Invariant Tester',
};

/** Mode → builtin prompt slug in `@wrongstack/core` prompt dataset. */
export const BUG_HUNT_MODE_SLUGS: Record<BugHuntMode, string> = {
  bughunt: 'proof-driven-bug-hunter',
  sechunt: 'proof-driven-security-hardener',
  racehunt: 'proof-driven-race-leak-hunter',
  debloat: 'proof-driven-dead-code-excisor',
  uipolish: 'proof-driven-ui-a11y-ratchet',
  typehunt: 'proof-driven-type-boundary-guard',
  testgap: 'proof-driven-blind-spot-tester',
};

/** One-line card descriptions shown on the WebUI Welcome Screen when a mode is selected. */
export const BUG_HUNT_MODE_DESCRIPTIONS: Record<BugHuntMode, string> = {
  bughunt: 'Find, prove, and fix one real bug, verify it, then stop for review.',
  sechunt: 'Prove one reachable boundary or auth/input flaw locally, harden it, and verify.',
  racehunt:
    'Prove one concurrency race or resource leak with deterministic barriers/counters, fix, and 5x verify.',
  debloat:
    'Prove zero static and dynamic reachability for one dead unit, excise it, and ratchet via build/tests.',
  uipolish:
    'Measure one concrete DOM layout or WCAG accessibility failure, fix with design tokens, and re-measure.',
  typehunt:
    'Prove how malformed runtime data breaches one unsafe cast or boundary, and replace with a sound guard.',
  testgap:
    'Prove existing tests miss one critical invariant or branch, and author a durable regression test.',
};

export interface BugHuntSummary {
  scope: string;
  maxBugs: BugHuntLimit;
  currentRound: number;
  mode?: BugHuntMode | undefined;
}

/** The compact user turn for rounds after the full builtin prompt. */
export function buildBugHuntContinuation(summary: BugHuntSummary): string {
  const scope = summary.scope ? ` Stay within the original scope: ${summary.scope}.` : '';
  return `This is round ${summary.currentRound}/${summary.maxBugs}; we're continuing the bug hunt.${scope}`;
}

const BUG_HUNT_PREFIX = '<!-- wrongstack-bug-hunt';
const BUG_HUNT_PATTERN =
  /^<!-- wrongstack-bug-hunt scope="([^"]*)" max-bugs="(10|[1-9])"(?: round="(\d+)")?(?: mode="([a-z]+)")? -->\n/;

function isBugHuntMode(value: string): value is BugHuntMode {
  return (BUG_HUNT_MODES as readonly string[]).includes(value);
}

/** Adds durable display metadata without changing the instruction sent to the agent. */
export function buildBugHuntMessage(instruction: string, summary: BugHuntSummary): string {
  const modeAttr = summary.mode && summary.mode !== 'bughunt' ? ` mode="${summary.mode}"` : '';
  return `${BUG_HUNT_PREFIX} scope="${encodeURIComponent(summary.scope)}" max-bugs="${summary.maxBugs}" round="${summary.currentRound}"${modeAttr} -->\n${instruction}`;
}

/** Recognizes a persisted Bug Hunter run and recovers its compact display data. */
export function parseBugHuntMessage(content: string): BugHuntSummary | undefined {
  const match = BUG_HUNT_PATTERN.exec(content);
  if (!match) return undefined;
  try {
    const currentRound = Number(match[3] ?? '1');
    if (!Number.isInteger(currentRound) || currentRound < 1) return undefined;
    const rawMode = match[4];
    if (rawMode !== undefined && !isBugHuntMode(rawMode)) return undefined;
    return {
      scope: decodeURIComponent(match[1] ?? ''),
      maxBugs: Number(match[2]) as BugHuntLimit,
      currentRound,
      ...(rawMode && rawMode !== 'bughunt' ? { mode: rawMode } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * The first round's instruction: the builtin protocol followed by the run configuration the
 * client enforces. `client` names who starts the later rounds (the WebUI or the desktop).
 */
export function firstHuntRoundInstruction(
  protocol: string,
  run: { scope: string; maxBugs: BugHuntLimit },
  client: string,
): string {
  const scopeText = run.scope ? `${run.scope} and all of its descendants` : 'the whole project';
  return `${protocol}

## ${client} run configuration (mandatory)
This is round 1/${run.maxBugs}. Investigate at most one proven bug in this round: discovery, proof, fix, verification, and cleanup. If no legitimate proof is possible, report no-proven-bug or blocked without changing production code. Stop after the round report; the ${client} will start another round only after this one finishes successfully and only while below the configured limit. Stay strictly within ${scopeText}.`;
}
