/** Messages rendered at once in a conversation; each "Show earlier" adds this many. */
export const TRANSCRIPT_WINDOW = 150;

/** How many of the oldest messages stay unrendered when `shown` newest ones are rendered. */
export function hiddenMessageCount(total: number, shown: number): number {
  return Math.max(0, total - Math.max(0, shown));
}
