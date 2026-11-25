/** Browser-safe skill mention syntax shared by all composers and the runtime. */
export interface SkillMention {
  start: number;
  end: number;
  query: string;
}

export interface SkillMentionCandidate {
  name: string;
  description: string;
}

function proseOnly(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`]*(?:`|$)/g, (value) =>
    ' '.repeat(value.length),
  );
}

export function detectSkillMention(text: string, cursor: number): SkillMention | null {
  const caret = Math.max(0, Math.min(cursor, text.length));
  const before = proseOnly(text).slice(0, caret);
  const match = /(?:^|[\s(])\$([a-z0-9-]*)$/.exec(before);
  if (!match || text.trimStart().startsWith('!')) return null;
  const query = match[1] ?? '';
  const start = caret - query.length - 1;
  const suffix = /^[a-z0-9-]*/.exec(text.slice(caret))?.[0] ?? '';
  const end = caret + suffix.length;
  if (/[A-Za-z0-9_:/$-]/.test(text[end] ?? ' ') || /^\.[A-Za-z0-9_/]/.test(text.slice(end)))
    return null;
  return { start, end, query };
}

export function extractSkillMentions(text: string): string[] {
  if (text.trimStart().startsWith('!')) return [];
  const prose = proseOnly(text);
  return [
    ...new Set(
      [...prose.matchAll(/(?:^|[\s(])\$([a-z0-9]+(?:-[a-z0-9]+)*)(?![A-Za-z0-9_:/$-])/g)]
        .filter(
          (match) => !/^\.[A-Za-z0-9_/]/.test(prose.slice((match.index ?? 0) + match[0].length)),
        )
        .map((match) => match[1]!),
    ),
  ];
}

export function insertSkillMention(
  text: string,
  mention: SkillMention,
  name: string,
): { text: string; cursor: number } {
  const start = Number.isFinite(mention.start)
    ? Math.max(0, Math.min(Math.trunc(mention.start), text.length))
    : 0;
  const end = Number.isFinite(mention.end)
    ? Math.max(start, Math.min(Math.trunc(mention.end), text.length))
    : start;
  const inserted = `$${name} `;
  const after = text.slice(end).replace(/^[ \t]+/, '');
  return {
    text: text.slice(0, start) + inserted + after,
    cursor: start + inserted.length,
  };
}

export function matchSkillMentions<T extends SkillMentionCandidate>(
  skills: readonly T[],
  query: string,
): T[] {
  const q = query.toLowerCase();
  return skills
    .filter((skill) => skill.name.includes(q) || skill.description.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Number(b.name.startsWith(q)) - Number(a.name.startsWith(q)) || a.name.localeCompare(b.name),
    );
}

/** A wording refiner must not silently discard the user's explicit selections. */
export function preserveSkillMentions(original: string, rewritten: string): string {
  const present = new Set(extractSkillMentions(rewritten));
  const missing = extractSkillMentions(original).filter((name) => !present.has(name));
  return missing.length
    ? `${missing.map((name) => `$${name}`).join(' ')}\n\n${rewritten}`
    : rewritten;
}
