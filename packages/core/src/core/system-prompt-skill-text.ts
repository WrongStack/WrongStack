import { SKILL_LIMITS } from '../skills/limits.js';

/** Strip YAML frontmatter from a SKILL.md file, returning only the body. */
export function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return raw;
  // Skip past the closing `---` and the following newline
  let body = raw.slice(end + 4);
  if (body.startsWith('\n')) body = body.slice(1);
  return body;
}

/**
 * Cap a skill body at `SKILL_LIMITS.MAX_SKILL_BODY_CHARS`, truncating at a
 * paragraph boundary when possible to preserve readability. Appends an
 * ellipsis marker when truncated so the model can detect the cap.
 */
export function capSkillBody(body: string): string {
  const max = SKILL_LIMITS.MAX_SKILL_BODY_CHARS;
  if (body.length <= max) return body;
  // Try to cut at the last paragraph break (`\n\n`) within the
  // budget so the truncated body ends cleanly. Fall back to a
  // hard cut if no paragraph break exists.
  const budget = max - 1; // reserve 1 char for ellipsis
  const cut = body.lastIndexOf('\n\n', budget);
  const truncated = cut > budget / 2 ? body.slice(0, cut) : body.slice(0, budget);
  return truncated + '…';
}

/**
 * Compact a skill trigger description into a short label.
 * "Use this skill when scanning source code for bugs..."
 * -> "scanning source code for bugs, anti-patterns, code smells"
 */
export function compactTrigger(trigger: string): string {
  // Strip common prefixes
  let s = trigger
    .replace(/^Use this skill when /i, '')
    .replace(/^Use this skill for /i, '')
    .replace(/^Use when /i, '')
    .replace(/\.$/, '');
  // Truncate to ~72 chars at a word boundary
  if (s.length > 72) {
    const cut = s.lastIndexOf(' ', 68);
    s = cut > 50 ? s.slice(0, cut) + '…' : s.slice(0, 68) + '…';
  }
  return s;
}
