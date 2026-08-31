export interface BugHuntSummary {
  scope: string;
  maxBugs: 1 | 2 | 3;
}

const BUG_HUNT_PREFIX = '<!-- wrongstack-bug-hunt';
const BUG_HUNT_PATTERN = /^<!-- wrongstack-bug-hunt scope="([^"]*)" max-bugs="([123])" -->\n/;

/** Adds durable display metadata without changing the instruction sent to the agent. */
export function buildBugHuntMessage(instruction: string, summary: BugHuntSummary): string {
  return `${BUG_HUNT_PREFIX} scope="${encodeURIComponent(summary.scope)}" max-bugs="${summary.maxBugs}" -->\n${instruction}`;
}

/** Recognizes a persisted Bug Hunter run and recovers its compact display data. */
export function parseBugHuntMessage(content: string): BugHuntSummary | undefined {
  const match = BUG_HUNT_PATTERN.exec(content);
  if (!match) return undefined;
  try {
    return { scope: decodeURIComponent(match[1] ?? ''), maxBugs: Number(match[2]) as 1 | 2 | 3 };
  } catch {
    return undefined;
  }
}
