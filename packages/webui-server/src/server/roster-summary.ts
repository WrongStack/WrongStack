/**
 * The one-line summary a roster card shows for a role without a project profile.
 *
 * Role prompts are hard-wrapped, so the first long line usually stops mid-sentence ("Your job
 * is requirement analysis: turn a"). The summary is the first prose paragraph instead, its
 * wrapped lines joined, skipping headings and rules; a very long paragraph ends at a word
 * boundary with an ellipsis.
 */
const SUMMARY_LIMIT = 280;

export function rosterPromptSummary(prompt: string | undefined): string {
  if (!prompt) return '';
  for (const block of prompt.split(/\n\s*\n/)) {
    const text = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !/^(#|---|\*\*\*|```)/.test(line))
      .join(' ');
    if (text.length <= 20) continue;
    if (text.length <= SUMMARY_LIMIT) return text;
    const cut = text.slice(0, SUMMARY_LIMIT);
    const space = cut.lastIndexOf(' ');
    return `${(space > SUMMARY_LIMIT / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return '';
}
