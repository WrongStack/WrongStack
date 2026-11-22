// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

export type Section =
  | 'Added'
  | 'Changed'
  | 'Deprecated'
  | 'Fixed'
  | 'Removed'
  | 'Security'
  | 'Documentation'
  | 'Maintenance';

export interface ChangelogEntry {
  section: Section;
  text: string;
  origin: 'commit' | 'manual';
  when: string;
}

export const SECTION_ORDER: Section[] = [
  'Added',
  'Changed',
  'Deprecated',
  'Fixed',
  'Removed',
  'Security',
  'Documentation',
  'Maintenance',
];

// ---------------------------------------------------------------------------
// Markdown rendering / merging
// ---------------------------------------------------------------------------

const CHANGELOG_HEADER = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]
`;

export function renderUnreleasedBlock(entries: ChangelogEntry[]): string {
  const bySection = new Map<Section, string[]>();
  for (const e of entries) {
    const list = bySection.get(e.section) ?? [];
    // Dedupe identical lines (same fix recorded from commit + manual).
    if (!list.includes(e.text)) list.push(e.text);
    bySection.set(e.section, list);
  }
  const parts: string[] = [];
  for (const section of SECTION_ORDER) {
    const items = bySection.get(section);
    if (!items || items.length === 0) continue;
    parts.push(`### ${section}`);
    parts.push(...items.map((t) => `- ${t}`));
    parts.push('');
  }
  return parts.join('\n').trimEnd();
}

/**
 * Merge a rendered Unreleased block into existing changelog content:
 * inserted directly under `## [Unreleased]`, merging section headings
 * and deduplicating entries. Creates the standard header when the file
 * has no Unreleased heading.
 */
export function mergeIntoChangelog(existing: string | null, block: string): string {
  if (!existing?.trim()) {
    return `${CHANGELOG_HEADER}\n${block}\n`;
  }
  const unreleasedRe = /^##\s*\[?unreleased\]?.*$/im;
  const m = unreleasedRe.exec(existing);
  if (!m || m.index === undefined) {
    const h1 = /^#\s.*$/m.exec(existing);
    if (h1 && h1.index !== undefined) {
      const insertAt = h1.index + h1[0].length;
      return `${existing.slice(0, insertAt)}\n\n## [Unreleased]\n\n${block}\n${existing.slice(insertAt)}`;
    }
    return `## [Unreleased]\n\n${block}\n\n${existing}`;
  }

  const startIndex = m.index + m[0].length;
  // A link-reference definition (`[Unreleased]: https://…`, the Keep a
  // Changelog footer) also ends the body: with no release below, the footer
  // was otherwise parsed as Unreleased content and glued onto a bullet (F1119).
  const nextSectionMatch = /^(?:##\s+\[?[0-9v]|\[[^\]\n]+\]:\s*\S)/im.exec(
    existing.slice(startIndex),
  );
  const endIndex = nextSectionMatch ? startIndex + nextSectionMatch.index : existing.length;

  const currentUnreleased = existing.slice(startIndex, endIndex);
  const rest = existing.slice(endIndex);

  // Merge structurally WITHOUT dropping what the parser does not model. The
  // old rebuild kept only `### <known section>` headings and top-level `- `
  // bullets, so `*`/`+` bullets, sub-bullets, prose and an unknown section's
  // items (`### Deprecated` was refiled under the previous section) were
  // silently deleted from the user's changelog.
  const current = parseUnreleased(currentUnreleased);
  const incoming = parseUnreleased(block);
  for (const [section, items] of incoming.sections) {
    const target = current.sections.get(section) ?? [];
    // New entries first, as before; exact duplicates collapse.
    current.sections.set(section, [...items, ...target.filter((item) => !items.includes(item))]);
  }
  current.preamble.push(...incoming.preamble.filter((l) => !current.preamble.includes(l)));
  const combinedBlock = renderParsedUnreleased(current);
  const formattedRest = rest.trim() ? `\n\n${rest.trimStart()}` : '\n';

  return `${existing.slice(0, startIndex)}\n\n${combinedBlock}${formattedRest}`;
}

interface ParsedUnreleased {
  /** Prose before the first section heading, verbatim. */
  preamble: string[];
  /** Section name → items; an item keeps its continuation/sub-bullet lines. */
  sections: Map<string, string[]>;
}

/** Parse an Unreleased body into sections, preserving every non-blank line. */
function parseUnreleased(text: string): ParsedUnreleased {
  const preamble: string[] = [];
  const sections = new Map<string, string[]>();
  let section: string | undefined;
  let items: string[] | undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = /^###\s+(.+)$/.exec(trimmed);
    if (heading?.[1]) {
      section = heading[1].trim();
      items = sections.get(section) ?? [];
      sections.set(section, items);
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet && section === undefined) {
      section = 'Changed';
      items = sections.get(section) ?? [];
      sections.set(section, items);
    }
    if (bullet && items) {
      items.push((bullet[1] ?? '').trim());
    } else if (items && items.length > 0) {
      // Indented sub-bullet or wrapped text belongs to the previous item.
      items[items.length - 1] = `${items[items.length - 1]}\n${line.trimEnd()}`;
    } else if (items) {
      items.push(trimmed);
    } else {
      preamble.push(line.trimEnd());
    }
  }
  return { preamble, sections };
}

/** Render known sections in Keep-a-Changelog order, then any others as found. */
function renderParsedUnreleased(parsed: ParsedUnreleased): string {
  const parts: string[] = [];
  if (parsed.preamble.length > 0) parts.push(...parsed.preamble, '');
  const known = new Set<string>(SECTION_ORDER);
  const order = [
    ...SECTION_ORDER.filter((s) => parsed.sections.has(s)),
    ...[...parsed.sections.keys()].filter((s) => !known.has(s)),
  ];
  for (const section of order) {
    const items = parsed.sections.get(section);
    if (!items || items.length === 0) continue;
    parts.push(`### ${section}`, ...items.map((t) => `- ${t}`), '');
  }
  return parts.join('\n').trimEnd();
}
