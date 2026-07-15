export interface FileMention {
  start: number;
  query: string;
}

/** Find an unfinished `@file` token immediately before the cursor. */
export function detectFileMention(input: string, cursor: number): FileMention | null {
  const safeCursor = Math.max(0, Math.min(cursor, input.length));
  const beforeCursor = input.slice(0, safeCursor);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(beforeCursor);
  if (!match) return null;
  const query = match[1] ?? '';
  return { start: safeCursor - query.length - 1, query };
}

/** Remove the partial `@query`; the selected path is represented by a chip. */
export function removeFileMention(input: string, mention: FileMention): string {
  const before = input.slice(0, mention.start);
  const after = input.slice(mention.start + mention.query.length + 1);
  return `${before}${after}`.replace(/[ \t]{2,}/g, ' ').trim();
}

/** Match the canonical Full WebUI wire convention for whole-file references. */
export function composePromptWithFileReferences(content: string, paths: readonly string[]): string {
  const references = [...new Set(paths)].map((path) => `@${path}`).join('\n');
  return [content.trim(), references].filter(Boolean).join('\n\n');
}

export function fileBasename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}
