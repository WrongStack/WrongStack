/**
 * `#` mentions of the project's GitHub pull requests and issues, shared by
 * the WebUI and VibeUI composers. A pick inserts the item's github.com URL: it names the repository,
 * the kind and the number unambiguously, `gh pr view <url>` / `gh issue view
 * <url>` accept it as is, and nothing a third party wrote enters the prompt.
 */

export interface GitHubMention {
  start: number;
  end: number;
  query: string;
}

export interface GitHubMentionCandidate {
  kind: 'pull' | 'issue';
  number: number;
  title: string;
  author: string | null;
  url: string;
  draft?: boolean;
}

function proseOnly(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`]*(?:`|$)/g, (value) =>
    ' '.repeat(value.length),
  );
}

/** The `#query` the caret sits in, outside code and shell (`!`) input; else null. */
export function detectGitHubMention(text: string, cursor: number): GitHubMention | null {
  const caret = Math.max(0, Math.min(cursor, text.length));
  if (text.trimStart().startsWith('!')) return null;
  const match = /(?:^|[\s(])#([A-Za-z0-9-]*)$/.exec(proseOnly(text).slice(0, caret));
  if (!match) return null;
  const query = match[1] ?? '';
  const suffix = /^[A-Za-z0-9-]*/.exec(text.slice(caret))?.[0] ?? '';
  const end = caret + suffix.length;
  // `#tag#more`, `#x/y` or `#x.y` is something else.
  if (/[#/_.:]/.test(text[end] ?? ' ')) return null;
  return { start: caret - query.length - 1, end, query };
}

/** Number prefix first (`#12` → 12, 120…), else words of the title or author; list order otherwise. */
export function matchGitHubMentions<T extends GitHubMentionCandidate>(
  items: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  if (/^\d+$/.test(q)) {
    const exact = items.filter((item) => String(item.number) === q);
    const prefix = items.filter(
      (item) => String(item.number).startsWith(q) && String(item.number) !== q,
    );
    return [...exact, ...prefix];
  }
  const words = q.split('-').filter(Boolean);
  return items.filter((item) => {
    const haystack = `${item.title} ${item.author ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function insertGitHubMention(
  text: string,
  mention: GitHubMention,
  url: string,
): { text: string; cursor: number } {
  const start = Math.max(0, Math.min(mention.start, text.length));
  const end = Math.max(start, Math.min(mention.end, text.length));
  const inserted = `${url} `;
  const after = text.slice(end).replace(/^[ \t]+/, '');
  return { text: text.slice(0, start) + inserted + after, cursor: start + inserted.length };
}
