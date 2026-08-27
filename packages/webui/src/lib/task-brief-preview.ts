/** One-line preview length — chimera briefs are multi-KB and must not enter chrome. */
export const TASK_PREVIEW_CHARS = 140;

/** Collapse whitespace and clip so pinned chrome never lays out the full brief. */
export function taskBriefPreview(description: string, maxChars = TASK_PREVIEW_CHARS): string {
  const oneLine = description.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, maxChars).trimEnd()}…`;
}
