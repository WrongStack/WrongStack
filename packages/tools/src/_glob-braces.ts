/**
 * Brace ALTERNATION (`*.{ts,tsx}`, `{src,lib}/**`) for path globs.
 *
 * core's `compilePathGlob` treats `{`/`}` as literal characters — on purpose:
 * it also matches trust patterns, where alternation would widen approvals. A
 * file-finding glob is different: `**\/*.{ts,tsx}` is the everyday spelling,
 * and reading it literally answered "no such files" instead of the files.
 *
 * Only a group containing a comma alternates; `{id}` stays literal, since both
 * braces are legal in file names. Nested groups expand outermost first so a
 * sibling branch is not repeated for every nested alternative. The expansion
 * is capped so a hostile pattern stays a handful of globs.
 */
const MAX_ALTERNATIVES = 64;

interface AlternationGroup {
  start: number;
  end: number;
  commas: number[];
}

function findAlternationGroup(pattern: string): AlternationGroup | undefined {
  const stack: { start: number; commas: number[] }[] = [];
  let group: AlternationGroup | undefined;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '{') {
      stack.push({ start: i, commas: [] });
    } else if (char === ',') {
      stack.at(-1)?.commas.push(i);
    } else if (char === '}') {
      const frame = stack.pop();
      // Prefer the enclosing alternation to any already-seen inner group.
      // A comma-less wrapper stays literal, but its inner group can expand.
      if (frame && frame.commas.length > 0 && (!group || frame.start < group.start)) {
        group = { ...frame, end: i };
      }
    }
  }
  return group;
}

export function expandBraceAlternation(pattern: string, limit = MAX_ALTERNATIVES): string[] {
  const group = findAlternationGroup(pattern);
  if (!group) return [pattern];
  const head = pattern.slice(0, group.start);
  const tail = pattern.slice(group.end + 1);
  const out: string[] = [];
  let start = group.start + 1;
  for (const end of [...group.commas, group.end]) {
    const alt = pattern.slice(start, end);
    start = end + 1;
    for (const p of expandBraceAlternation(head + alt + tail, limit - out.length)) {
      out.push(p);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
