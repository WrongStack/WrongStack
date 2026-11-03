import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * English-leak gate (design brief, Follow-up 12 finding 14; Kanban a649cb10).
 *
 * The catalog-integrity i18n check proves that every *referenced* key exists —
 * it says nothing about views that reference zero keys and hardcode all their
 * copy. The original SessionStoryView shipped 100% hardcoded English and was
 * invisible to that gate. This scanner is the needle: it fails on user-visible
 * English that bypasses the i18n layer, whether or not any key is referenced.
 *
 * Mirrors shadow-boundaries.test.ts / theme-color-boundaries.test.ts:
 * a scanner, a self-test on a fixture, a zero-hit gate over the current tree,
 * an exemption staleness check, and a live regression proof against the
 * pre-i18n session-story revision (git show 670737358:...) — no stale fixture
 * files are kept.
 */
const SRC_ROOT = path.resolve(import.meta.dirname, '../../src/components');

/**
 * JSX text children that read as an English sentence/phrase: a capitalized
 * first word followed by 2+ more letters/digits/punctuation words, sitting
 * directly between tags (allowing surrounding whitespace).
 */
const JSX_TEXT_CHILD = />\s*([A-Z][a-z]+(?:[\s'’-][A-Za-z0-9,.'’…-]+){2,})\s*</;

/**
 * Visible string attributes with quoted (non-interpolated) literal values:
 * aria-label, placeholder, title. Dynamic (`{...}`) values are skipped by
 * construction because the value must be a plain ' or " literal.
 */
const VISIBLE_ATTRIBUTE = /\b(?:aria-label|placeholder|title)=("([^"]*)"|'([^']*)')/g;

type Hit = { file: string; line: number; kind: string; text: string };

/**
 * These files genuinely contain hardcoded English today. Keep this list exact
 * and documented; do not add broad directories or globs. The staleness test
 * below fails if a listed file loses its violations, so an exemption cannot
 * silently outlive the reason it was granted.
 */
const ENGLISH_LEAK_EXEMPTIONS = new Map<string, string>([
  // ---- pre-i18n hardcoded copy backlog (Follow-up 12 finding 14 debt ledger) ----
  // Empty since the final burn-down batch: every previously exempted file was
  // ported to the t() layer. Do not add new entries for new views — route new
  // copy through the i18n catalog. The zero-hit scan below is the ongoing gate.
]);

/** True when a candidate string is a false positive, not real UI copy. */
function isExcluded(candidate: string): boolean {
  const text = candidate.trim();
  // Numbers and symbols only (counts, codes, punctuation).
  if (!/[A-Za-z]/.test(text)) return true;
  // Template interpolation or i18n brace syntax — dynamic, not a literal.
  if (text.includes('{{') || text.includes('${')) return true;
  // i18n keys / dotted message ids ("activity:", "kanban.card.title").
  if (/(?:^|\s)[a-z][a-z0-9-]*:[a-z0-9.\s-]/i.test(text)) return true;
  if (/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/i.test(text)) return true;
  // URLs, file paths, protocol-prefixed content.
  if (/https?:\/\/|www\.|[\w-]+\.(?:tsx?|css|md|json)\b/.test(text)) return true;
  if (text.includes('/') || text.includes('\\')) return true;
  // Short ALL-CAPS labels ("NEW", "TODO — QA", acronyms).
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 2 && text === text.toUpperCase()) return true;
  // CSS/Tailwind class-like content, not prose.
  if (/\b(?:text|bg|border|font|flex|grid|rounded|shadow)-[a-z0-9]/.test(text)) return true;
  // Snake/camel identifiers, not prose (no spaces after lowering guard).
  if (!/\s/.test(text) && /[_a-z]/.test(text) && /[_A-Z]/.test(text)) return true;
  return false;
}

function scanSource(relativePath: string, source: string): Hit[] {
  const hits: Hit[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const textMatch = JSX_TEXT_CHILD.exec(line);
    if (textMatch && !isExcluded(textMatch[1])) {
      hits.push({ file: relativePath, line: i + 1, kind: 'JSX text', text: textMatch[1].trim() });
    }
    VISIBLE_ATTRIBUTE.lastIndex = 0;
    for (const attrMatch of line.matchAll(VISIBLE_ATTRIBUTE)) {
      const value = (attrMatch[2] ?? attrMatch[3] ?? '').trim();
      const words = value.split(/\s+/).filter(Boolean);
      if (words.length >= 3 && /^[A-Za-z]/.test(value) && !isExcluded(value)) {
        hits.push({ file: relativePath, line: i + 1, kind: 'attribute', text: value });
      }
    }
  }
  return hits;
}

function componentFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      componentFiles(full, files);
      continue;
    }
    if (/\.tsx$/.test(entry) && !/\.test\./.test(entry)) files.push(full);
  }
  return files;
}

function scanTree(): Hit[] {
  return componentFiles(SRC_ROOT).flatMap((file) => {
    const relative = path.relative(SRC_ROOT, file).replaceAll('\\', '/');
    if (ENGLISH_LEAK_EXEMPTIONS.has(relative)) return [];
    return scanSource(relative, readFileSync(file, 'utf8'));
  });
}

describe('English-leak boundaries', () => {
  it('detects hardcoded English in a fixture and ignores legal content (gate self-test)', () => {
    const fixture = [
      '<h2 className="font-semibold">Event evidence</h2>', // 2 words: legal
      '<p>Loading session replay timeline, please wait…</p>', // hit
      '<span aria-label="Session dashboard sections">', // hit (attribute)
      '<input placeholder="Search agents" />', // 2 words: legal
      '<code>packages/webui/src/components/Terminal.tsx</code>', // path: legal
      '<span title={t(`activity: ${id}`)}>', // dynamic: legal
      '<kbd>Ctrl+K</kbd>', // symbols: legal
      '<h3>TODO — QA REVIEW</h3>', // ALL-CAPS <=2 words: legal
    ].join('\n');
    const hits = scanSource('fixture.tsx', fixture);
    expect(hits.map((h) => h.text)).toEqual([
      'Loading session replay timeline, please wait…',
      'Session dashboard sections',
    ]);
  });

  it('keeps English-leak exemptions valid, necessary, and pointed at real files', () => {
    const missing = [...ENGLISH_LEAK_EXEMPTIONS.keys()].filter(
      (key) => !statSync(path.join(SRC_ROOT, key), { throwIfNoEntry: false }),
    );
    const unnecessary = [...ENGLISH_LEAK_EXEMPTIONS.keys()].filter((key) => {
      const full = path.join(SRC_ROOT, key);
      return (
        statSync(full, { throwIfNoEntry: false }) !== undefined &&
        scanSource(key, readFileSync(full, 'utf8')).length === 0
      );
    });
    expect(missing).toEqual([]);
    expect(unnecessary).toEqual([]);
  });

  it('keeps component views free of hardcoded user-visible English', () => {
    const hits = scanTree();
    const report = hits.map((h) => `${h.file}:${h.line} [${h.kind}] — ${h.text}`).join('\n');
    expect(
      report,
      `Hardcoded English bypasses the i18n layer (Follow-up 12 finding 14): route user-visible copy through the catalog/t() layer instead. If a file genuinely needs an exemption, add a documented entry to ENGLISH_LEAK_EXEMPTIONS in tests/lib/english-leak-boundaries.test.ts.\n${report}`,
    ).toBe('');
  });

  it('catches the pre-i18n session-story regression (needle proof)', () => {
    const preI18n = execFileSync(
      'git',
      ['show', '670737358:packages/webui/src/components/SessionStoryView.tsx'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    const oldHits = scanSource('SessionStoryView.tsx (pre-i18n 670737358)', preI18n);
    expect(oldHits.length).toBeGreaterThan(0);

    // The view lives in the shared project-surfaces package; the WebUI path re-exports it.
    const current = readFileSync(
      path.resolve(SRC_ROOT, '../../../project-surfaces/src/story/SessionStoryView.tsx'),
      'utf8',
    );
    expect(scanSource('SessionStoryView.tsx', current)).toEqual([]);
  });
});
