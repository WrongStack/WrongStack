import {
  splitLearnedEntries,
  tokenOverlap,
} from './project-agent-learning-entries.js';
import {
  classifyLearnedEntry,
  type LearnedEntryCategory,
  MIN_INSTRUCTIVE_LENGTH,
  normalizeForComparison,
} from './project-agent-learning-normalize.js';

/**
 * Parsed representation of a single buffered entry — the structured shape
 * that every capture merges into.
 */
export interface StructuredLearnedEntry {
  /** Injective content identity: normalized token signature for dedup. */
  key: string;
  /** Category bucket (convention / pattern / warning / fact). */
  category: LearnedEntryCategory;
  /** The directive itself — what the agent should do. */
  what: string;
  /** Why this directive exists — derived from category and directive signals. */
  why: string;
  /**
   * Concrete, runnable anchors — commands, file paths, package names.
   * One anchor per line, WITHOUT any list marker: the renderer owns the
   * markup. Storing markup here is what produced the `- *How:*   - *How:*`
   * nesting that compounded on every capture.
   */
  how: string;
  /** ISO timestamp of when this entry was originally captured. */
  capturedAt: string;
  /**
   * Skill this directive develops, when capture could route it. Entries with a
   * skill are distilled into `.wrongstack/agents/<role>/skills/<skill>.md` by
   * the optimization pass; unrouted entries stay role-level.
   */
  skill?: string | undefined;
}

export function parseLearnedEntryStamp(entry: string): {
  capturedAt: string;
  category: LearnedEntryCategory | null;
} {
  const structuredMatch = entry.match(
    /<!--\s*learned-stamp:\s*category=([\w-]+);\s*capturedAt=([^;]+?)\s*-->/,
  );
  if (structuredMatch) {
    const rawCategory = structuredMatch[1];
    const candidate = parseLearnedCategory(rawCategory);
    return {
      capturedAt: typeof structuredMatch[2] === 'string' ? structuredMatch[2].trim() : '',
      category: candidate ?? null,
    };
  }
  const stampMatch = entry.match(/^>\s*(?:\[\s*([\w-]+)\s*\]\s+)?(?:Captured|Taught)\s+(\S+)/m);
  if (!stampMatch) {
    return { capturedAt: '', category: null };
  }
  return {
    capturedAt: typeof stampMatch[2] === 'string' ? stampMatch[2] : '',
    category: parseLearnedCategory(stampMatch[1]) ?? null,
  };
}

function parseLearnedCategory(value: string | undefined): LearnedEntryCategory | undefined {
  return value === 'convention' || value === 'pattern' || value === 'warning' || value === 'fact'
    ? value
    : undefined;
}

function stripStamp(entry: string): string {
  return entry
    .replace(/<!--\s*learned-stamp:[\s\S]*?-->/g, '')
    .replace(/^>\s*(?:\[[\w-]+\]\s+)?(?:Captured|Taught)\s+.+$/m, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function directiveKey(text: string): string {
  return normalizeForComparison(text);
}

export function decomposeLearnedEntry(
  text: string,
  category: LearnedEntryCategory,
): { what: string; why: string; how: string } {
  const what = text;
  const why = deriveWhy(category, text);
  const how = extractHow(text);
  return { what, why, how };
}

const WHY_BY_CATEGORY: Record<LearnedEntryCategory, string> = {
  convention:
    'Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.',
  pattern:
    "This project's chosen approach — alternatives were considered and either conflict with existing architecture or were rejected for known reasons.",
  warning:
    'Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.',
  fact: 'Current state of the project — assumed by other conventions, build steps, or peers, so acting on a stale assumption wastes a cycle.',
};

function deriveWhy(category: LearnedEntryCategory, text: string): string {
  const base = WHY_BY_CATEGORY[category];
  const signals: string[] = [];
  const lower = text.toLowerCase();
  if (/\bbefore\s+(?:merge|commit|deploy|release|shipping|publishing)\b/.test(lower))
    signals.push('guard before shipping');
  if (/\bto\s+avoid\b/.test(lower)) {
    const m = text.match(/to avoid ([^.!?]+)/i);
    if (m?.[1]) signals.push(`avoid ${m[1].trim()}`);
  }
  if (/\bso\s+(?:that|we|the project)\b/.test(lower)) {
    const m = text.match(/so (?:that |we |the project )?([^.!?]+)/i);
    if (m?.[1]) signals.push(`so ${m[1].trim()}`);
  }
  if (signals.length === 0) return base;
  return `${base} Project signals: ${signals.join('; ')}.`;
}

function extractHow(text: string): string {
  const anchors = new Set<string>();
  const backticked = text.match(/`([^`]+)`/g) ?? [];
  for (const raw of backticked) {
    const inner = raw.replace(/`/g, '').trim();
    if (inner.length > 0 && inner.length <= 120) anchors.add(inner);
  }
  // Extension alternation is longest-first. Regex alternation is first-match,
  // so listing `js` before `json` truncated every `foo.json` anchor to
  // `foo.js` — a path that does not exist, handed to the agent as guidance.
  const pathMatches =
    text.match(
      /(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.(?:tsx|jsonc|json|jsx|yaml|mjs|cjs|yml|ts|js|md)\b/g,
    ) ?? [];
  for (const p of pathMatches) anchors.add(p);
  const scoped = text.match(/@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*/gi) ?? [];
  for (const p of scoped) anchors.add(p);
  if (anchors.size === 0) return '';
  return [...anchors].map((anchor) => `\`${anchor}\``).join('\n');
}

/**
 * Strip any accumulated list/label markup from a stored `How` line.
 *
 * Older buffers were written with the `- *How:* ` label baked into the stored
 * value, so each re-render prefixed it again and produced
 * `- *How:*   - *How:*   - *How:* …`. Cleaning on read means the next capture
 * silently repairs an already-corrupted file.
 */
function cleanHowLine(line: string): string {
  let value = line.trim();
  let previous: string;
  do {
    previous = value;
    value = value
      .replace(/^[-*]\s+/, '')
      .replace(/^\*How:\*\s*/i, '')
      .trim();
  } while (value !== previous);
  return value;
}

/** `category=warning; capturedAt=...; skill=testing` → a lookup map. */
function parseStampAttributes(body: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const part of body.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) attributes[key] = value;
  }
  return attributes;
}

/**
 * Parse one rendered entry body (everything between its stamp and the next
 * stamp / section heading) into what / why / how.
 *
 * Line-oriented on purpose: the previous single mega-regex captured every
 * `*How:*` line into one group with the dotAll flag, so re-rendering wrapped
 * the already-labelled text in another label on every capture.
 */
function parseEntryBody(body: string): { what: string; why: string; how: string } | undefined {
  const lines: string[] = [];
  for (const line of body.split('\n')) {
    // Stop at the next section boundary; the footer and headings are not part
    // of any entry.
    if (/^##\s/.test(line) || /^---\s*$/.test(line) || /^<!--/.test(line)) break;
    lines.push(line);
  }
  const text = lines.join('\n');
  const what = /^-\s+\*\*([\s\S]+?)\*\*\s*$/m.exec(text)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  if (!what) return undefined;
  const why = /^\s+-\s+\*Why:\*\s+(.+)$/m.exec(text)?.[1]?.trim() ?? '';
  const how = lines
    .filter((line) => /^\s+-\s+\*How:\*/i.test(line))
    .map((line) => cleanHowLine(line))
    .filter(Boolean)
    .join('\n');
  return { what, why, how };
}

export function parseStructuredLearnedEntriesFromContent(
  raw: string,
  legacyEntries: string[] = splitLearnedEntries(raw),
): StructuredLearnedEntry[] {
  if (!raw) return [];
  const structured: StructuredLearnedEntry[] = [];
  const stampPattern = /<!--\s*learned-stamp:\s*([^>]*?)\s*-->/g;
  const stamps = [...raw.matchAll(stampPattern)];
  for (const [index, stamp] of stamps.entries()) {
    const attributes = parseStampAttributes(stamp[1] ?? '');
    const category = parseLearnedCategory(attributes['category']) ?? 'fact';
    const capturedAt = attributes['capturedAt'] ?? '';
    const skill = attributes['skill'];
    const start = (stamp.index ?? 0) + stamp[0].length;
    const end = stamps[index + 1]?.index ?? raw.length;
    const parsed = parseEntryBody(raw.slice(start, end));
    if (!parsed || parsed.what.length < MIN_INSTRUCTIVE_LENGTH) continue;
    structured.push({
      key: directiveKey(parsed.what),
      category,
      what: parsed.what,
      why: parsed.why || WHY_BY_CATEGORY[category],
      how: parsed.how,
      capturedAt,
      ...(skill ? { skill } : {}),
    });
  }
  if (structured.length === 0) {
    for (const chunk of legacyEntries) {
      const stamp = parseLearnedEntryStamp(chunk);
      const directive = stamp.capturedAt || stamp.category ? stripStamp(chunk) : chunk;
      if (directive.length < MIN_INSTRUCTIVE_LENGTH) continue;
      const category = stamp.category ?? classifyLearnedEntry(directive);
      const { what, why, how } = decomposeLearnedEntry(directive, category);
      structured.push({
        key: directiveKey(directive),
        category,
        what,
        why,
        how,
        capturedAt: stamp.capturedAt,
      });
    }
  }
  return structured;
}

export function mergeStructuredEntries(
  existing: StructuredLearnedEntry[],
  fresh: {
    text: string;
    category: LearnedEntryCategory;
    capturedAt: string;
    skill?: string | undefined;
  },
): StructuredLearnedEntry[] {
  const { what, why, how } = decomposeLearnedEntry(fresh.text, fresh.category);
  const freshEntry: StructuredLearnedEntry = {
    key: directiveKey(fresh.text),
    category: fresh.category,
    what,
    why,
    how,
    capturedAt: fresh.capturedAt,
    ...(fresh.skill ? { skill: fresh.skill } : {}),
  };
  const merged = existing.filter((entry) => tokenOverlap(entry.key, freshEntry.key) < 0.55);
  merged.push(freshEntry);
  const order: Record<LearnedEntryCategory, number> = {
    warning: 0,
    convention: 1,
    pattern: 2,
    fact: 3,
  };
  merged.sort((a, b) => {
    const cmp = order[a.category] - order[b.category];
    if (cmp !== 0) return cmp;
    return a.what.localeCompare(b.what);
  });
  return merged;
}

const SECTION_TITLE: Record<LearnedEntryCategory, string> = {
  warning: '## What to avoid',
  convention: '## What to do',
  pattern: '## Patterns to follow',
  fact: '## Project facts',
};

export function renderLearnedInstructions(
  role: string,
  entries: StructuredLearnedEntry[],
  capturedAt: string,
): string {
  const headerLines = [
    `# Learned instructions for \`${role}\``,
    '',
    '> Project-specific learning data for the `' +
      role +
      '` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.',
    '',
  ];

  if (entries.length === 0) {
    return (
      headerLines.join('\n') +
      [
        '_No learned entries yet._',
        '',
        '---',
        `*Last capture: ${capturedAt} · 0 entries*`,
        '',
      ].join('\n')
    );
  }

  const buckets: Record<LearnedEntryCategory, StructuredLearnedEntry[]> = {
    warning: [],
    convention: [],
    pattern: [],
    fact: [],
  };
  for (const entry of entries) buckets[entry.category].push(entry);

  const sections: string[] = [];
  for (const category of ['warning', 'convention', 'pattern', 'fact'] as LearnedEntryCategory[]) {
    const list = buckets[category];
    if (list.length === 0) continue;
    sections.push(SECTION_TITLE[category]);
    sections.push('');
    for (const entry of list) {
      const attributes = [
        `category=${entry.category}`,
        `capturedAt=${entry.capturedAt}`,
        ...(entry.skill ? [`skill=${entry.skill}`] : []),
      ].join('; ');
      sections.push(`<!-- learned-stamp: ${attributes} -->`);
      sections.push(`- **${entry.what}**`);
      sections.push(`  - *Why:* ${entry.why}`);
      // `entry.how` holds bare anchors, one per line. The label is applied
      // exactly once, here, so a parse→render round-trip is a fixed point.
      for (const line of entry.how.split('\n').map(cleanHowLine).filter(Boolean)) {
        sections.push(`  - *How:* ${line}`);
      }
      sections.push('');
    }
  }

  const footer = ['---', `*Last capture: ${capturedAt} · ${entries.length} entries*`, ''];
  return [...headerLines, ...sections, ...footer].join('\n');
}

/** Drop order when the buffer must shrink: cheapest knowledge goes first. */
const DROP_PRIORITY: Record<LearnedEntryCategory, number> = {
  fact: 0,
  pattern: 1,
  convention: 2,
  warning: 3,
};

/**
 * Keep the rendered buffer within `maxBytes` by evicting the least valuable
 * entries — oldest first, plain facts before hard-won warnings.
 *
 * This replaces the old "block every automatic capture once the file passes
 * 8 KB" gate. That gate had no way to ever clear itself (consolidation wrote a
 * separate file and never touched the raw buffer), so the roles that had
 * learned the most were exactly the roles that had permanently stopped
 * learning. Bounding the buffer is the same protection without the deadlock.
 */
export function enforceLearnedBudget(
  entries: readonly StructuredLearnedEntry[],
  capturedAt: string,
  maxBytes: number,
  role = 'agent',
): { kept: StructuredLearnedEntry[]; dropped: StructuredLearnedEntry[] } {
  const kept = [...entries];
  const dropped: StructuredLearnedEntry[] = [];
  const size = (list: StructuredLearnedEntry[]): number =>
    Buffer.byteLength(renderLearnedInstructions(role, list, capturedAt), 'utf8');
  while (kept.length > 1 && size(kept) > maxBytes) {
    let victimIndex = 0;
    for (let i = 1; i < kept.length; i++) {
      const a = kept[i] as StructuredLearnedEntry;
      const b = kept[victimIndex] as StructuredLearnedEntry;
      const byPriority = DROP_PRIORITY[a.category] - DROP_PRIORITY[b.category];
      if (byPriority < 0 || (byPriority === 0 && a.capturedAt < b.capturedAt)) victimIndex = i;
    }
    dropped.push(...kept.splice(victimIndex, 1));
  }
  return { kept, dropped };
}
