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
  /** Concrete, runnable anchor — commands, file paths, package names. */
  how: string;
  /** ISO timestamp of when this entry was originally captured. */
  capturedAt: string;
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
  const pathMatches =
    text.match(
      /(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yaml|yml)/g,
    ) ?? [];
  for (const p of pathMatches) anchors.add(p);
  const scoped = text.match(/@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*/gi) ?? [];
  for (const p of scoped) anchors.add(p);
  if (anchors.size === 0) return '';
  return [...anchors].map((a) => `- \`${a}\``).join('\n');
}

export function parseStructuredLearnedEntriesFromContent(
  raw: string,
  legacyEntries: string[] = splitLearnedEntries(raw),
): StructuredLearnedEntry[] {
  if (!raw) return [];
  const structured: StructuredLearnedEntry[] = [];
  const entryPattern =
    /<!--\s*learned-stamp:\s*category=([\w-]+);\s*capturedAt=([^;]+?)\s*-->\s*\n-\s+\*\*(.+?)\*\*(?:\s*\n\s+-\s+\*Why:\*\s+(.+?))?(?:\s*\n\s+-\s+\*How:\*\s+(.+?))?(?=\n(?:<!--|##|---|\n|$))/gs;
  for (const m of raw.matchAll(entryPattern)) {
    const category = parseLearnedCategory(m[1]) ?? 'fact';
    const capturedAt = (m[2] ?? '').trim();
    const what = (m[3] ?? '').trim();
    const why = (m[4] ?? '').trim();
    const howRaw = (m[5] ?? '').trim();
    if (what.length < MIN_INSTRUCTIVE_LENGTH) continue;
    structured.push({
      key: directiveKey(what),
      category,
      what,
      why: why || WHY_BY_CATEGORY[category],
      how: howRaw,
      capturedAt,
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
  fresh: { text: string; category: LearnedEntryCategory; capturedAt: string },
): StructuredLearnedEntry[] {
  const { what, why, how } = decomposeLearnedEntry(fresh.text, fresh.category);
  const freshEntry: StructuredLearnedEntry = {
    key: directiveKey(fresh.text),
    category: fresh.category,
    what,
    why,
    how,
    capturedAt: fresh.capturedAt,
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
      const stamp = `<!-- learned-stamp: category=${entry.category}; capturedAt=${entry.capturedAt} -->`;
      sections.push(stamp);
      sections.push(`- **${entry.what}**`);
      sections.push(`  - *Why:* ${entry.why}`);
      if (entry.how) {
        for (const line of entry.how.split('\n'))
          sections.push(`  - *How:* ${line.replace(/^- /, '')}`);
      }
      sections.push('');
    }
  }

  const footer = ['---', `*Last capture: ${capturedAt} · ${entries.length} entries*`, ''];
  return [...headerLines, ...sections, ...footer].join('\n');
}
