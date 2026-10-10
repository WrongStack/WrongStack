import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Mirrored human-readable file under `<projectRoot>/.wrongstack/`. */
export const DOMAIN_TERMS_FILENAME = 'domain-terms.md';

/**
 * Stop-list of common English words that pass the heuristic but are not
 * project jargon. Matched case-insensitive at extraction time. Add words
 * that show up as false positives — never strip projects-specific
 * identifiers from this list.
 */
export const COMMON_WORD_STOPLIST: ReadonlySet<string> = new Set([
  // articles / demonstratives / pronouns
  'the',
  'this',
  'that',
  'these',
  'those',
  'some',
  'any',
  'all',
  'each',
  'every',
  'no',
  // conjunctions / prepositions / common verbs
  'and',
  'or',
  'but',
  'not',
  'with',
  'from',
  'into',
  'onto',
  'over',
  'under',
  'about',
  'after',
  'before',
  'between',
  'without',
  // common model prompts the user might say
  'please',
  'thanks',
  'hello',
  'okay',
  'sorry',
  // common false-positive nouns
  'project',
  'file',
  'files',
  'directory',
  'module',
  'system',
  'service',
  'function',
  'method',
  'class',
  'object',
  'value',
  'result',
  'string',
  'number',
  'boolean',
  'array',
  'list',
  'map',
  'set',
  'tree',
  'graph',
  'node',
  'edge',
  'state',
  'event',
  'task',
  'todo',
  'note',
  'doc',
  'docs',
  'readme',
  'package',
  'version',
]);

/**
 * A single project-specific term extracted from conversation or git
 * history, before it is persisted. `confidence` is 0..1; the
 * persistence layer skips entries with `confidence < minConfidence`.
 */
export interface ExtractedTerm {
  /** The canonical term (e.g. `Mailbox Bridge`, `SddBoardProjector`). */
  term: string;
  /** Short definition, best-effort. May be empty when no hint was found. */
  definition: string;
  /** 0..1 — higher is more likely to be genuine project jargon. */
  confidence: number;
  /**
   * How many times the term was observed across all messages / commits
   * in this extraction pass. Starts at 1 for the first sighting and is
   * accumulated by `mergeTerm`. A post-merge pass folds this into
   * `confidence` via a diminishing-returns bonus so one-off backticked
   * identifiers no longer rank the same as repeatedly-used project
   * terms. See {@link applyFrequencyBonus}.
   */
  mentionCount: number;
  /**
   * Backing evidence: a short excerpt of the source text. The first
   * observation in the array is treated as the canonical excerpt when
   * persisting.
   */
  evidence: string[];
  /**
   * Where the term came from — `'user'`, `'agent'`, `'commit'`,
   * `'file'`. Multiple sources are merged by `mergeTerms`.
   */
  sources: ReadonlyArray<'user' | 'agent' | 'commit' | 'file'>;
}

// ── helpers ─────────────────────────────────────────────────────────

/**
 * Match potential project jargon inside a single conversation message.
 *
 * Two patterns are recognised:
 *
 *   - `<backtick>` `<text>` `</backtick>` — directly back-ticked
 *     identifiers are taken as code/jargon (full match). Bounded
 *     to identifier-shaped text.
 *   - **Bolded runs** `**Foo**` — the user or agent is signalling "this
 *     is a name".
 *   - A run of PascalCase / camelCase tokens of length ≥ 4.
 *
 * Conservative by design: every candidate gets a confidence score
 * and most candidates are filtered out before they leave this
 * function.
 */
export function extractCandidatesFromMessage(
  text: string,
  role: 'user' | 'agent',
): ExtractedTerm[] {
  const out: ExtractedTerm[] = [];
  const source: 'user' | 'agent' = role;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return out;

  // The channels below scan the same text, so one occurrence can match
  // several of them (`TaskGraph` is both back-ticked and camelCase). Each
  // emitted candidate counts as a mention in `mergeTerm`, so a later
  // channel must not re-emit the same term from a span an earlier channel
  // already claimed — otherwise a single sighting reads as a repeat.
  const claimed: Array<{ start: number; end: number; key: string }> = [];
  const claim = (match: RegExpMatchArray, term: string): void => {
    const start = match.index ?? 0;
    claimed.push({ start, end: start + match[0].length, key: normalizeTerm(term) });
  };
  const isClaimed = (match: RegExpMatchArray, term: string): boolean => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const key = normalizeTerm(term);
    // Overlap, not containment: a later channel's span may WRAP an earlier
    // claim (`**` + backtick + Term + backtick + `**` — the bold span
    // encloses the backtick span) just as it may sit inside one (bare
    // camelCase inside a claimed backtick span). Containment alone let the
    // nesting case through, so one sighting counted as two mentions.
    return claimed.some((c) => c.key === key && start < c.end && end > c.start);
  };

  // 1) Back-ticked identifiers.
  for (const match of cleaned.matchAll(/`([A-Za-z][A-Za-z0-9_-]{2,80})`/g)) {
    const term = match[1] as string;
    if (isStoplisted(term)) continue;
    claim(match, term);
    out.push({
      term,
      definition: '',
      confidence: 0.7,
      mentionCount: 1,
      evidence: [match[0]],
      sources: [source],
    });
  }

  // 2) **bolded** runs.
  for (const match of cleaned.matchAll(/\*\*([^*\n]{2,80})\*\*/g)) {
    const raw = (match[1] ?? '').trim();
    const term = cleanBoldedCandidate(raw);
    if (!term || isStoplisted(term)) continue;
    if (isClaimed(match, term)) continue;
    claim(match, term);
    out.push({
      term,
      definition: '',
      confidence: 0.65,
      mentionCount: 1,
      evidence: [match[0]],
      sources: [source],
    });
  }

  // 3) PascalCase / camelCase identifiers in body text. We look for
  //    contiguous runs that include at least one lowercase letter
  //    or one boundary, and start with an uppercase ASCII letter.
  //    Examples we want: TaskGraph, SddBoardProjector, MemoryInjectorAgent.
  //    Examples we don't: USA, OK, HTTP — handled by `hasCamelBoundary`.
  for (const match of cleaned.matchAll(/\b([A-Z][A-Za-z0-9]{3,})\b/g)) {
    const term = match[1] as string;
    if (!hasCamelBoundary(term)) continue;
    if (isStoplisted(term)) continue;
    if (isClaimed(match, term)) continue;
    out.push({
      term,
      definition: '',
      confidence: 0.55,
      mentionCount: 1,
      evidence: [match[0]],
      sources: [source],
    });
  }

  // 4) Multi-word proper names ("Mailbox Bridge", "Project Root").
  //    These are rarer, so require an explicit article before them:
  //    "the X Y" or "X Y is/are/has ...".
  for (const match of cleaned.matchAll(
    /\b(?:the\s+|a\s+|an\s+)?((?:[A-Z][a-z]{2,})(?:\s+[A-Z][a-z0-9]{2,}){0,3})\b/g,
  )) {
    const raw = match[0];
    const term = raw.replace(/^(?:the|a|an)\s+/i, '').trim();
    if (term.split(/\s+/).length < 2) continue;
    if (isStoplisted(term)) continue;
    if (isClaimed(match, term)) continue;
    out.push({
      term,
      definition: '',
      confidence: 0.5,
      mentionCount: 1,
      evidence: [raw],
      sources: [source],
    });
  }

  // Attach definition hints ONLY when the term appears at the start of
  // a genuine prose sentence followed by a definitional verb (is / are /
  // means / refers to). Two defects in the previous regex produced the
  // garbage definitions visible in the live domain-terms.md:
  //
  //   - `[^.]*` reached backward across collapsed newlines. Because
  //     `cleaned` flattens all whitespace to single spaces, a diff or
  //     config block without periods let the match span the entire
  //     block, latching onto any later occurrence of the term.
  //   - `\s*:` matched every TypeScript annotation (`span: Span`),
  //     YAML key (`fallbackModels: empty`), and code comment colon —
  //     the primary source of nonsensical definitions like
  //     "fallbackModels — empty" and "requireKanbanGovernance — true".
  //
  // The anchored form requires `(?:^|[.!?]\s+)` before the term (optionally
  // preceded by an article), so only a real sentence start — the message
  // head, or after a period / question mark / exclamation — qualifies.
  // The bare-colon alternative is removed entirely; colons in prose
  // definitions ("Term: a thing") are vanishingly rare in this
  // codebase's conversation/diff text compared to code colons.
  const stream = cleaned.replace(/[`*]/g, '');
  for (const cand of out) {
    if (cand.definition) continue;
    const sentenceRegex = new RegExp(
      `(?:^|[.!?]\\s+)(?:the\\s+|a\\s+|an\\s+)?${escapeRegex(cand.term)}\\b\\s+(?:is|are|means|refers to)\\s+([^.]+)`,
      'i',
    );
    const m = stream.match(sentenceRegex);
    if (m?.[1]) {
      cand.definition = m[1].trim().slice(0, 240);
      cand.confidence = Math.min(1, cand.confidence + 0.1);
    }
  }

  return out;
}

/**
 * Parse a `git log` output blob into per-commit sections. Splits on
 * the `--SUBJECT--` marker we injected in the `git log` `--pretty`
 * template; falls back to per-line splitting when no marker is
 * present.
 */
export function splitCommitSections(stdout: string): string[] {
  if (!stdout) return [];
  if (stdout.includes('--SUBJECT--')) {
    return stdout
      .split('\n--SUBJECT--')
      .map((s) => s.replace(/^\s*--SUBJECT--/, '').trim())
      .filter(Boolean);
  }
  // Fallback: split on empty lines; bounded to keep the extractor
  // cheap.
  return stdout.split(/\n\n+/).slice(0, 250);
}

/**
 * Extract candidate terms from a single commit subject + diff
 * snippet.
 */
export function extractCandidatesFromCommitSection(section: string): ExtractedTerm[] {
  const boundedSection = section.split(/\r?\n/).slice(0, 80).join('\n');
  return extractCandidatesFromMessage(boundedSection, 'agent').map((c) => ({
    ...c,
    sources: ['commit' as const],
    // Slightly lower confidence: commit text is noisier, so require
    // the host (persistence) to confirm.
    confidence: Math.max(0.4, c.confidence - 0.1),
  }));
}

/**
 * Returns true when the term text hits the {@link COMMON_WORD_STOPLIST}.
 * Match is case-insensitive and ignores whitespace.
 */
export function isStoplisted(term: string): boolean {
  const trimmed = term.trim();
  const key = trimmed.toLowerCase();
  if (!key) return true;
  if (COMMON_WORD_STOPLIST.has(key)) return true;
  // Also reject pure-numeric and purely-uppercase acronyms without
  // an internal lowercase boundary (e.g. `URL`, `HTTP`).
  if (/^[A-Z0-9]{2,8}$/.test(trimmed) && !/[a-z].*[A-Z]|[A-Z].*[a-z]/.test(trimmed)) return true;
  return false;
}

/**
 * Returns true when an identifier shows the camelCase boundary that
 * distinguishes project jargon from acronyms like `USA` or `HTTP`.
 */
export function hasCamelBoundary(identifier: string): boolean {
  // Either lowercaseUppsercase (e.g. TaskGraph), low3rd segment with
  // digits, OR length ≥ 6 with mixed case.
  if (/[a-z][A-Z]/.test(identifier)) return true;
  if (/[A-Z][a-z]/.test(identifier) && identifier.length >= 7) return true;
  if (/^[A-Z][a-z]+[A-Z]/.test(identifier)) return true;
  return false;
}

/**
 * Strip non-noun context from a bolded run (e.g. "the Foo" → "Foo").
 */
export function cleanBoldedCandidate(raw: string): string {
  return (
    raw
      // Bolded runs routinely wrap backticked identifiers (`**`git rebase`**`);
      // those backticks are emphasis markup, not part of the term. Strip them
      // so the bold channel never emits a term carrying literal backticks —
      // which additionally could never match the definition-hint `stream`,
      // where backticks are already removed.
      .replace(/`/g, '')
      .replace(/^(?:the|a|an)\s+/i, '')
      .replace(/[.,;:!?]+$/g, '')
      .trim()
  );
}

/**
 * Escape a literal for `RegExp`.
 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reduce two `ExtractedTerm` records with the same canonical key into
 * one. The merged record keeps the longer / more confident of the two;
 * sources are unioned; evidence is concatenated.
 */
export function mergeTerm(byKey: Map<string, ExtractedTerm>, cand: ExtractedTerm): void {
  const key = normalizeTerm(cand.term);
  const existing = byKey.get(key);
  if (!existing) {
    byKey.set(key, { ...cand, sources: [...cand.sources] });
    return;
  }
  const definition = pickBetter(existing.definition, cand.definition);
  const confidence = Math.max(existing.confidence, cand.confidence);
  const evidence = [...new Set([...existing.evidence, ...cand.evidence])].slice(0, 6);
  const sources = [...new Set([...existing.sources, ...cand.sources])];
  const mentionCount = existing.mentionCount + cand.mentionCount;
  byKey.set(key, { term: existing.term, definition, confidence, mentionCount, evidence, sources });
}

/**
 * Fold `mentionCount` into `confidence` with a diminishing-returns curve.
 *
 * Repeated mentions strengthen the signal that a term is genuine project
 * jargon, but the effect saturates: the 10th sighting adds less than the
 * 2nd. Uses `log2(count) * 0.05` capped at +0.15 so the bonus is:
 *   1 mention  → +0.00 (baseline — no boost for single sightings)
 *   2 mentions → +0.05
 *   3 mentions → +0.08
 *   5 mentions → +0.12
 *   8+         → +0.15 (capped)
 *
 * Applied AFTER the merge loop so it is order-independent. Channel-based
 * confidence (backtick 0.70, bold 0.65, etc.) remains the primary signal;
 * the frequency bonus only separates one-off noise from repeated usage
 * within the same confidence band.
 */
export function applyFrequencyBonus(terms: ExtractedTerm[]): void {
  for (const t of terms) {
    if (t.mentionCount <= 1) continue;
    const bonus = Math.min(0.15, Math.log2(t.mentionCount) * 0.05);
    t.confidence = Math.min(0.99, t.confidence + bonus);
  }
}

export function pickBetter(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a.length >= b.length ? a : b;
}

/**
 * Canonicalise a term for use as a duplicate-detection key.
 *
 *   - lowercased
 *   - collapsed whitespace
 *   - trailing/leading punctuation stripped
 */
export function normalizeTerm(term: string): string {
  return term
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Render the `<projectRoot>/.wrongstack/domain-terms.md` file from
 * the supplied in-memory `ExtractedTerm[]` and return its absolute
 * path. The caller is responsible for IO error handling
 * (`persistViaAndMirror` swallows it so the extraction pass is
 * not aborted by a transient filesystem failure).
 *
 * Sort: confidence desc, then term asc (deterministic, not driven
 * by persisted timestamps since the mirror is regenerated from
 * in-memory state on every call).
 */
export async function renderDomainTermsMarkdown(
  projectRoot: string,
  terms: ReadonlyArray<ExtractedTerm>,
): Promise<string> {
  const dir = path.join(projectRoot, '.wrongstack');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, DOMAIN_TERMS_FILENAME);
  const lines: string[] = [
    '# Project Domain Glossary',
    '',
    '> Maintained automatically by SageDomainTermExtractor (in-memory pass).',
    '> SAGE persistence is disabled; the mirror is the only persisted view.',
    '> Do not edit by hand: re-run the extractor to regenerate.',
    '',
    `Last regenerated: ${new Date().toISOString()}`,
    '',
  ];
  const sorted = [...terms].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.term.localeCompare(b.term);
  });
  if (sorted.length === 0) {
    lines.push('_No project-specific terms detected yet._');
    lines.push('');
  } else {
    lines.push('| Term | Definition | Confidence |');
    lines.push('| --- | --- | --- |');
    for (const t of sorted) {
      const safeTerm = t.term.replace(/\|/g, '\\|');
      const safeDef = (t.definition || '_pending_').replace(/\|/g, '\\|');
      lines.push(`| \`${safeTerm}\` | ${safeDef} | ${t.confidence.toFixed(2)} |`);
    }
    lines.push('');
  }
  await fs.writeFile(filePath, lines.join('\n'), 'utf8');
  return filePath;
}
