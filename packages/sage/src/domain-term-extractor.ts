/**
 * SAGE-based automatic domain-glossary engine.
 *
 * Detects project-specific terminology from agent<->user conversations and
 * from git commits, persists each term as a regular `Sage` memory (kind
 * `'fact'`, tags `['domain-term', 'glossary', 'project-jargon']`), keeps a
 * `<projectRoot>/.wrongstack/domain-terms.md` mirror for human readability,
 * and produces a compact `[Project Jargon Dictionary]` block that hosts can
 * splice into the agent system prompt.
 *
 * Architectural rules respected here:
 *
 *   1. In-process consumers reach SAGE through `ProjectSageMemoryPort`
 *      (direct IPC over the per-project socket). The MCP layer is reserved
 *      for external consumers. See {@link
 *      ../../docs/direct-icp-usage.md} for the contract.
 *   2. The extractor is pure with respect to the SAGE schema: nothing here
 *      needs a new `SageKind`, a new IPC op, or a new persistence path.
 *      Terms flow through `searchSage` / `rememberSage` like any other
 *      memory, so hygiene, anchors, audiences, and the existing
 *      retrieval/triage pipeline keep working unchanged.
 *   3. The file mirror (`.wrongstack/domain-terms.md`) is **derived state**.
 *      SAGE is the source of truth; the file is regenerated from it on
 *      every persist. Deleting the file does not lose data.
 *   4. The glossary block in the system prompt is bounded by a max-entries
 *      cap (default 24) and a per-entry char cap (default 96 chars). The
 *      prompt goal is precision over recall: a 6-line dictionary the model
 *      actually reads beats a 200-term dump it ignores.
 *
 * Heuristic detection rules (deliberately conservative — false positives
 * pollute the system prompt):
 *
 *   - **PascalCase / camelCase identifiers** (e.g. `SddBoardProjector`,
 *     `TaskGraph`) — must contain at least 4 characters and start with an
 *     uppercase or lowercase ASCII letter.
 *   - **Multi-word proper names** (e.g. `Mailbox Bridge`, `Project Root`)
 *     — a sequence of capitalized words that the conversation treats as a
 *     single noun phrase (the first mention usually looks like
 *     "`the **Mailbox Bridge** owns the socket`").
 *   - **Kebab-case / slash-case identifiers** that already appear as code
 *     symbols (e.g. `domain-terms.md`, `./wrongstack/domain-terms.md`)
 *     are recognized via git paths and short-circuited to file references.
 *
 *   **Common English words are blocked from the dictionary via a tiny
 *   stop-list baked into {@link COMMON_WORD_STOPLIST}.** Adding to it is
 *   cheaper than fighting an over-eager regex.
 *
 *   Detection NEVER fires for explicit user phrasing such as
 *   "I mean the Mailbox Bridge component". Those phrases are normal
 *   sentences; we treat the *subject* of such sentences as a term
 *   candidate rather than the entire sentence.
 *
 * @module sage/domain-term-extractor
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { MemoryPort } from '@wrongstack/core/types';
import { getSageService, getSageSurface } from './memory-port.js';
import type { Sage } from './types.js';

const execFileAsync = promisify(execFile);

/** Tag every persisted glossary memory with. The first tag is the lookup key. */
export const DOMAIN_TERM_LOOKUP_TAG = 'domain-term';
const GLOSSARY_LOOKUP_TAG = 'glossary';
const PROJECT_JARGON_TAG = 'project-jargon';

/** Mirrored human-readable file under `<projectRoot>/.wrongstack/`. */
export const DOMAIN_TERMS_FILENAME = 'domain-terms.md';

/** Cap entries rendered into the prompt block. */
export const DEFAULT_MAX_GLOSSARY_ENTRIES = 24;
/** Cap the definition text per entry. Keeps the block ≤ ~2 KB. */
export const DEFAULT_GLOSSARY_ENTRY_CHARS = 96;

/**
 * Stop-list of common English words that pass the heuristic but are not
 * project jargon. Matched case-insensitive at extraction time. Add words
 * that show up as false positives — never strip projects-specific
 * identifiers from this list.
 */
const COMMON_WORD_STOPLIST: ReadonlySet<string> = new Set([
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

/** Options accepted by {@link SageDomainTermExtractor#extractFromConversation}. */
export interface ExtractFromConversationOptions {
  /**
   * Messages exchanged in the conversation. Each message is the raw text
   * (already stripped of any tool-result / metadata noise). `role` is
   * `'user' | 'agent'`.
   */
  messages: Array<{ role: 'user' | 'agent'; text: string }>;
  /**
   * Minimum confidence to keep a candidate. Default `0.55`. Lower
   * yields more terms but pollutes the dictionary.
   */
  minConfidence?: number | undefined;
  /** Max terms returned (sorted by confidence desc). Default 16. */
  limit?: number | undefined;
}

/** Narrow process seam used by commit extraction and its tests. */
export type DomainTermGitExec = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

/** Options accepted by {@link SageDomainTermExtractor#extractFromCommits}. */
export interface ExtractFromCommitsOptions {
  /** Absolute project root — used to spawn `git log`. Required. */
  projectRoot: string;
  /**
   * ISO timestamp: only commits newer than this are scanned. Default
   * `undefined` (entire history).
   */
  since?: string | undefined;
  /**
   * Maximum commits scanned. Default 200. Bounded to keep the
   * extractor fast on large monorepos.
   */
  maxCommits?: number | undefined;
  /**
   * Maximum terms returned. Default 12. Commit-derived candidates
   * are capped tighter than conversation-derived ones because the
   * commit-message signal is noisier.
   */
  limit?: number | undefined;
  /**
   * Minimum confidence to keep a candidate. Default `0.45` (slightly
   * lower than conversation extraction: commit subjects/diffs are
   * noisier, so the threshold is lower and the cap is tighter).
   */
  minConfidence?: number | undefined;
  /**
   * Allow tests / embedders to inject a custom exec. Defaults to a
   * real `git` invocation.
   */
  exec?: DomainTermGitExec | undefined;
}

/** Per-entry outcome returned by {@link SageDomainTermExtractor#persistVia}. */
export interface PersistOutcome {
  /** Term that was processed. */
  term: string;
  /** `added` — new memory created; `updated` — existing memory patched;
   *  `skipped` — `minConfidence` below threshold, or no-op (already
   *  matches exactly). */
  action: 'added' | 'updated' | 'skipped';
  /** The resulting Sage id, when `added` or `updated`. */
  memoryId?: string | undefined;
  /** Human-readable reason when `skipped`. */
  reason?: string | undefined;
}

/** Result of persisting a batch of terms. */
export interface PersistReport {
  added: number;
  updated: number;
  skipped: number;
  outcomes: PersistOutcome[];
}

/** Options accepted by {@link SageDomainTermExtractor#persistVia}. */
export interface PersistOptions {
  /** Skip entries below this confidence. Default 0.55. */
  minConfidence?: number | undefined;
  /**
   * When `true`, an existing term memory is *updated* in place (text
   * and confidence replaced; tags and anchors preserved). When `false`
   * (default), a stricter duplicate check keeps the higher-confidence
   * version.
   */
  overwriteExisting?: boolean | undefined;
  /**
   * Source citations to stamp on every persisted memory. The
   * extractor normally calls this with `[{ type: 'user' }]` /
   * `[{ type: 'file', path }]` / etc. Defaults to `[]` (unattributed).
   */
  sourceRefs?: import('./types.js').MemorySourceRef[] | undefined;
}

/**
 * Options accepted by {@link SageDomainTermExtractor#persistViaAndMirror}.
 *
 * Extends {@link PersistOptions} with the `projectRoot` that gates
 * mirror-file refresh. When `projectRoot` is omitted, the helper runs
 * `persistVia` only and returns the same report the underlying call
 * would produce.
 */
export interface PersistViaAndMirrorOptions extends PersistOptions {
  /**
   * Absolute project root whose `.wrongstack/domain-terms.md` should be
   * refreshed after the persist. When `undefined`, the mirror is
   * not rewritten — the call is equivalent to `persistVia`.
   */
  projectRoot?: string | undefined;
}

/** Result returned by {@link SageDomainTermExtractor#persistViaAndMirror}. */
export interface PersistViaAndMirrorReport {
  /** The underlying persist report (added/updated/skipped/outcomes). */
  report: PersistReport;
  /**
   * Absolute path of the refreshed mirror file, or `null` when no
   * `projectRoot` was supplied *or* the mirror write failed. SAGE
   * state is authoritative regardless of this value.
   */
  mirrorPath: string | null;
}

/**
 * Detect, persist, and render the project's domain glossary.
 *
 * The class is intentionally stateless — every method consumes
 * already-gathered inputs and talks to a `MemoryPort` only via the
 * typed capability helpers (`getSageService`, `getSageSurface`). A
 * caller can therefore construct a single extractor at boot and call
 * it from many turns.
 */
export class SageDomainTermExtractor {
  /**
   * Detect candidate terms from a recent conversation.
   *
   * The result is *candidate* data: callers should pass it through
   * {@link persistVia} (or the legacy `MemoryStore`-only path) before
   * relying on it. Detection never deletes or alters project state.
   */
  extractFromConversation(opts: ExtractFromConversationOptions): ExtractedTerm[] {
    const minConfidence = opts.minConfidence ?? 0.55;
    const limit = opts.limit ?? 16;

    const byKey = new Map<string, ExtractedTerm>();
    for (const msg of opts.messages) {
      const candidates = extractCandidatesFromMessage(msg.text, msg.role);
      for (const cand of candidates) {
        if (cand.confidence < minConfidence) continue;
        mergeTerm(byKey, cand);
      }
    }

    return [...byKey.values()].sort((a, b) => b.confidence - a.confidence).slice(0, limit);
  }

  /**
   * Detect candidate terms from `git log` output. Reads commit
   * subjects + at most the first 80 lines of each commit's diff.
   *
   * Returns `[]` if the project is not a git repo or `git` is not on
   * PATH — never throws.
   */
  async extractFromCommits(opts: ExtractFromCommitsOptions): Promise<ExtractedTerm[]> {
    const minConfidence = opts.minConfidence ?? 0.45;
    const limit = opts.limit ?? 12;
    const maxCommits = opts.maxCommits ?? 200;
    const exec: DomainTermGitExec =
      opts.exec ??
      ((file, args) =>
        execFileAsync(file, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) as Promise<{
          stdout: string;
          stderr: string;
        }>);

    let stdout: string;
    try {
      // `--no-pager` avoids waiting on a tty when the project repo is
      // unusually configured. We bound the diff with `-U8` (a few
      // lines around each hunk) and cap output via `wc -l` on the
      // caller side via `maxCommits`.
      const result = await exec('git', [
        '-C',
        opts.projectRoot,
        '--no-pager',
        'log',
        '--no-decorate',
        '-n',
        String(maxCommits),
        ...(opts.since ? [`--since=${opts.since}`] : []),
        '--pretty=format:--SUBJECT--%n%s%n%b',
        '-p',
        '-U8',
        '--no-color',
      ]);
      stdout = result.stdout ?? '';
    } catch {
      // Not a git repo, git not installed, no commits in range — all
      // non-fatal. A real git error would still be logged via the
      // host's stderr capture in `result.stderr`; we deliberately do
      // not surface it because extraction is advisory.
      return [];
    }

    const byKey = new Map<string, ExtractedTerm>();
    for (const section of splitCommitSections(stdout)) {
      for (const cand of extractCandidatesFromCommitSection(section)) {
        if (cand.confidence < minConfidence) continue;
        mergeTerm(byKey, cand);
      }
    }

    return [...byKey.values()].sort((a, b) => b.confidence - a.confidence).slice(0, limit);
  }

  /**
   * Persist terms through the supplied `MemoryPort`. The port MUST be
   * a SAGE port — the method goes through `getSageService` / `getSageSurface`
   * and falls back to the legacy `MemoryStore` shape only when those
   * capabilities are absent (no-op). In-process callers always have a
   * SAGE port here, so the fallback is a no-op (the design contract).
   */
  async persistVia(
    port: MemoryPort,
    terms: ReadonlyArray<ExtractedTerm>,
    options: PersistOptions = {},
  ): Promise<PersistReport> {
    const minConfidence = options.minConfidence ?? 0.55;
    const overwriteExisting = options.overwriteExisting ?? false;
    const sourceRefs = options.sourceRefs ?? [];

    // Use the SAGE surface if available. Plain `MemoryStore`-shaped
    // ports (none in production) are skipped: the architectural rule
    // requires in-process consumers to use `ProjectSageMemoryPort`.
    const surface = getSageSurface(port);
    if (!surface) {
      return {
        added: 0,
        updated: 0,
        skipped: terms.length,
        outcomes: terms.map((t) => ({
          term: t.term,
          action: 'skipped',
          reason: 'MemoryPort has no SAGE surface capability; pass a ProjectSageMemoryPort.',
        })),
      };
    }

    const outcomes: PersistOutcome[] = [];
    let added = 0;
    let updated = 0;
    let skipped = 0;

    // Pre-fetch the existing term memories so duplicate detection
    // does NOT require a full scan per term.
    const existing = await listExistingTermMemories(surface);
    const existingByName = new Map(
      existing.map((mem) => [normalizeTerm(mem.text.split(' — ')[0] ?? mem.text), mem]),
    );

    for (const term of terms) {
      if (term.confidence < minConfidence) {
        outcomes.push({ term: term.term, action: 'skipped', reason: 'below minConfidence' });
        skipped++;
        continue;
      }

      const lookupKey = normalizeTerm(term.term);
      const match = existingByName.get(lookupKey);
      const persistedText = composeMemoryText(term);

      if (!match) {
        const saved = await surface.rememberSage({
          text: persistedText,
          kind: 'fact',
          scope: 'project',
          tags: [DOMAIN_TERM_LOOKUP_TAG, GLOSSARY_LOOKUP_TAG, PROJECT_JARGON_TAG],
          confidence: term.confidence,
          importance: Math.max(0.5, term.confidence),
          anchors: [],
          sources: sourceRefs.length > 0 ? sourceRefs : [{ type: 'user' }],
        });
        added++;
        outcomes.push({ term: term.term, action: 'added', memoryId: saved.id });
        continue;
      }

      // Already exists. Compare canonicalised texts.
      const sameText = persistedText.trim() === match.text.trim();
      if (sameText && !overwriteExisting) {
        outcomes.push({ term: term.term, action: 'skipped', reason: 'already present' });
        skipped++;
        continue;
      }

      const patched = await surface.updateSage(match.id, {
        text: persistedText,
        tags: [...new Set([...match.tags, GLOSSARY_LOOKUP_TAG, PROJECT_JARGON_TAG])],
        kind: 'fact',
        confidence: Math.max(term.confidence, match.confidence),
        importance: Math.max(0.5, Math.max(term.confidence, match.importance)),
      });
      updated++;
      outcomes.push({ term: term.term, action: 'updated', memoryId: patched.id });
    }

    return { added, updated, skipped, outcomes };
  }

  /**
   * Render the glossary file under `<projectRoot>/.wrongstack/`. The
   * file is regenerated from the existing SAGE memories; no separate
   * state is held.
   *
   * Returns the absolute path of the written file.
   */
  async writeDomainTermsFile(projectRoot: string, port: MemoryPort): Promise<string> {
    const terms = await fetchActiveTermsForGlossary(port);
    const filePath = await renderDomainTermsMarkdown(projectRoot, terms);
    return filePath;
  }

  /**
   * Persist terms and, when `projectRoot` is provided, refresh the
   * human-readable mirror file at `<projectRoot>/.wrongstack/domain-terms.md`.
   *
   * The mirror is **derived state** (see module-level rule #3): SAGE
   * is the source of truth, the file is regenerated atomically on
   * every persist. Hosts that want a guaranteed fresh mirror after a
   * batched extraction pipeline should call this rather than
   * `persistVia` followed by `writeDomainTermsFile` separately — it
   * avoids the "persist succeeded but mirror write failed" window.
   *
   * Behaviour:
   *   - Always returns the underlying `PersistReport` (added/updated/skipped).
   *   - When `projectRoot` is `undefined`, performs the persist only
   *     and returns the report unchanged. `mirrorPath` is `null`.
   *   - When `projectRoot` is provided, calls `writeDomainTermsFile`
   *     after the persist succeeds. If the mirror write throws, the
   *     error is **swallowed** and `mirrorPath` is `null` — the
   *     authoritative SAGE state is already correct, and the host can
   *     retry the mirror on a later persist. The original exception
   *     is re-thrown only when the underlying persist itself failed.
   *
   * Never throws on a working SAGE port for mirror IO errors.
   */
  async persistViaAndMirror(
    port: MemoryPort,
    terms: ReadonlyArray<ExtractedTerm>,
    options: PersistViaAndMirrorOptions = {},
  ): Promise<PersistViaAndMirrorReport> {
    const report = await this.persistVia(port, terms, options);
    if (options.projectRoot === undefined) {
      return { report, mirrorPath: null };
    }
    try {
      const mirrorPath = await this.writeDomainTermsFile(options.projectRoot, port);
      return { report, mirrorPath };
    } catch {
      // Mirror is derived state; SAGE persist already succeeded.
      // Surface the path as null so callers can detect and retry.
      return { report, mirrorPath: null };
    }
  }

  /**
   * Build the compact `[Project Jargon Dictionary]` block. Returns
   * `''` when no glossary memories are present so callers can
   * unconditionally append.
   */
  async formatGlossaryBlock(
    port: MemoryPort,
    options: {
      /** Maximum entries. Default {@link DEFAULT_MAX_GLOSSARY_ENTRIES}. */
      maxEntries?: number | undefined;
      /** Max characters per entry. Default {@link DEFAULT_GLOSSARY_ENTRY_CHARS}. */
      maxEntryChars?: number | undefined;
    } = {},
  ): Promise<string> {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_GLOSSARY_ENTRIES;
    const maxEntryChars = options.maxEntryChars ?? DEFAULT_GLOSSARY_ENTRY_CHARS;
    const terms = await fetchActiveTermsForGlossary(port, maxEntries * 2);
    if (terms.length === 0) return '';

    const lines: string[] = ['# Project Jargon Dictionary', ''];
    lines.push('Compact definitions maintained from conversation history and commits.');
    lines.push('Each entry is a SAGE fact (tags: domain-term, glossary). Stay terse;');
    lines.push('use the terms verbatim when the user does.');
    lines.push('');

    const rendered: { term: string; entry: string }[] = [];
    for (const term of terms.slice(0, maxEntries)) {
      const safeTerm = term.term.replace(/[`*_]/g, (c) => `\\${c}`);
      const safeDef = (term.definition || '(no definition yet)').slice(0, maxEntryChars);
      const safeDefEsc = safeDef.replace(/[`*_]/g, (c) => `\\${c}`);
      rendered.push({ term: term.term, entry: `- **${safeTerm}** — ${safeDefEsc}` });
    }

    lines.push(...rendered.map((r) => r.entry));
    return lines.join('\n');
  }
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
function extractCandidatesFromMessage(text: string, role: 'user' | 'agent'): ExtractedTerm[] {
  const out: ExtractedTerm[] = [];
  const source: 'user' | 'agent' = role;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return out;

  // 1) Back-ticked identifiers.
  for (const match of cleaned.matchAll(/`([A-Za-z][A-Za-z0-9_-]{2,80})`/g)) {
    const term = match[1] as string;
    if (isStoplisted(term)) continue;
    out.push({
      term,
      definition: '',
      confidence: 0.7,
      evidence: [match[0]],
      sources: [source],
    });
  }

  // 2) **bolded** runs.
  for (const match of cleaned.matchAll(/\*\*([^*\n]{2,80})\*\*/g)) {
    const raw = (match[1] ?? '').trim();
    const term = cleanBoldedCandidate(raw);
    if (!term || isStoplisted(term)) continue;
    out.push({
      term,
      definition: '',
      confidence: 0.65,
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
    out.push({
      term,
      definition: '',
      confidence: 0.55,
      evidence: [match[0]],
      sources: [source],
    });
  }

  // 4) Multi-word proper names ("Mailbox Bridge", "Project Root").
  //    These are rarer, so require an explicit article before them:
  //    "the X Y" or "X Y is/are/has ...".
  const multiWord = cleaned.match(
    /\b(?:the\s+|a\s+|an\s+)?((?:[A-Z][a-z]{2,})(?:\s+[A-Z][a-z0-9]{2,}){0,3})\b/g,
  );
  if (multiWord) {
    for (const raw of multiWord) {
      const term = raw.replace(/^(?:the|a|an)\s+/i, '').trim();
      if (term.split(/\s+/).length < 2) continue;
      if (isStoplisted(term)) continue;
      out.push({
        term,
        definition: '',
        confidence: 0.5,
        evidence: [raw],
        sources: [source],
      });
    }
  }

  // Attach rough definition hints: when the term sits inside a
  // "TERM is/means/refers to DEFINITION" sentence, capture the
  // definition. We strip surrounding backticks / asterisks from the
  // sentence stream first because the term's source text often sits
  // inside backticks (`SddBoardProjector is ...`), and `\\b` does
  // not match across the punctuation.
  const stream = cleaned.replace(/[`*]/g, '');
  for (const cand of out) {
    if (cand.definition) continue;
    const sentenceRegex = new RegExp(
      `[^.]*\\b${escapeRegex(cand.term)}\\b(?:\\s+is|\\s+means|\\s+refers to|\\s*:)\\s+([^.]+)`,
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
function splitCommitSections(stdout: string): string[] {
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
function extractCandidatesFromCommitSection(section: string): ExtractedTerm[] {
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
 * Format a term memory's `text` field. Splitting on the em-dash lets
 * the persistence layer find an existing term record without an exact
 * text match — `extractExisting(text.split(' — ')[0])` recovers the
 * canonical term from either side of the dash.
 */
function composeMemoryText(term: ExtractedTerm): string {
  if (!term.definition) return term.term;
  return `${term.term} — ${term.definition.slice(0, 200)}`;
}

/**
 * Returns true when the term text hits the {@link COMMON_WORD_STOPLIST}.
 * Match is case-insensitive and ignores whitespace.
 */
function isStoplisted(term: string): boolean {
  const key = term.trim().toLowerCase();
  if (!key) return true;
  if (COMMON_WORD_STOPLIST.has(key)) return true;
  // Also reject pure-numeric and purely-uppercase acronyms without
  // an internal lowercase boundary (e.g. `URL`, `HTTP`).
  if (/^[A-Z0-9]{2,8}$/.test(key) && !/[a-z].*[A-Z]|[A-Z].*[a-z]/.test(key)) return true;
  return false;
}

/**
 * Returns true when an identifier shows the camelCase boundary that
 * distinguishes project jargon from acronyms like `USA` or `HTTP`.
 */
function hasCamelBoundary(identifier: string): boolean {
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
function cleanBoldedCandidate(raw: string): string {
  return raw
    .replace(/^(?:the|a|an)\s+/i, '')
    .replace(/[.,;:!?]+$/g, '')
    .trim();
}

/**
 * Escape a literal for `RegExp`.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reduce two `ExtractedTerm` records with the same canonical key into
 * one. The merged record keeps the longer / more confident of the two;
 * sources are unioned; evidence is concatenated.
 */
function mergeTerm(byKey: Map<string, ExtractedTerm>, cand: ExtractedTerm): void {
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
  byKey.set(key, { term: existing.term, definition, confidence, evidence, sources });
}

function pickBetter(a: string, b: string): string {
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
 * Active glossary memories, sorted by confidence desc then most
 * recent first. Filters by tag and `status === 'active'`.
 */
async function fetchActiveTermsForGlossary(port: MemoryPort, limit = 64): Promise<ExtractedTerm[]> {
  const surface = getSageSurface(port) ?? getSageService(port);
  if (!surface) return [];

  // `searchSage` returns Sage records; we filter by the
  // `domain-term` tag and shape each result into an `ExtractedTerm`
  // for rendering. The `safeSearchTagged` helper accepts the structural
  // `SageSurface` shape so we coerce via `unknown` first.
  const hits = await safeSearchTagged(
    surface as unknown as SageSurface & Record<string, unknown>,
    limit * 4,
  );

  return hits
    .filter((m) => m.tags.includes(DOMAIN_TERM_LOOKUP_TAG))
    .filter((m) => m.status === 'active' || m.status === 'stale')
    .sort((a, b) => {
      if (b.importance !== a.importance) return b.importance - a.importance;
      return b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, limit)
    .map((m) => parsePersistedTerm(m));
}

/**
 * Try several search shapes from the surface/service interfaces so
 * the extractor works whether the host passed the canonical SAGE
 * surface, the legacy facade, or a custom store. Never throws.
 */
async function safeSearchTagged(
  surface: SageSurface & Record<string, unknown>,
  limit: number,
): Promise<Sage[]> {
  for (const shape of ['searchSage', 'unifiedSearchService', 'search'] as const) {
    const fn = surface[shape] as unknown;
    if (typeof fn !== 'function') continue;
    try {
      const result = await (fn as (q: string, opts: unknown) => Promise<unknown>)(
        DOMAIN_TERM_LOOKUP_TAG,
        {
          limit,
          tags: [DOMAIN_TERM_LOOKUP_TAG],
          requireAllTerms: true,
        },
      );
      if (Array.isArray(result)) return result as Sage[];
      // `unifiedSearchService` returns `{ hits }`.
      const hits = (result as { hits?: Sage[] }).hits;
      if (Array.isArray(hits)) return hits;
    } catch {
      // try the next shape
    }
  }
  return [];
}

/**
 * Recover an `ExtractedTerm` from a persisted `Sage` memory's `text`
 * field (`Term — definition` or just `Term`).
 */
function parsePersistedTerm(memory: Sage): ExtractedTerm {
  const [termPart, ...rest] = memory.text.split(' — ');
  const definition = rest.length > 0 ? rest.join(' — ').trim() : '';
  return {
    term: (termPart ?? memory.text).trim(),
    definition,
    confidence: memory.confidence,
    evidence: [],
    sources: ['file'],
  };
}

interface SageSurface {
  searchSage?: (query: string, opts?: { limit?: number; tags?: string[] }) => Promise<Sage[]>;
  unifiedSearchService?: (
    q: string,
    opts?: { limit?: number; tags?: string[] },
  ) => Promise<{ hits?: Sage[]; totalCandidates?: number }>;
  search?: (q: string, scope?: string, limit?: number) => Promise<Sage[]>;
}

/**
 * List existing domain-term memories for duplicate detection. Uses
 * `searchSage` directly; if the surface is missing, returns [].
 */
async function listExistingTermMemories(surface: SageSurface): Promise<Sage[]> {
  if (typeof surface.searchSage === 'function') {
    try {
      const hits = await surface.searchSage(DOMAIN_TERM_LOOKUP_TAG, {
        limit: 256,
      });
      return hits;
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Render the `<projectRoot>/.wrongstack/domain-terms.md` file and
 * return its absolute path. Caller is responsible for IO errors.
 */
async function renderDomainTermsMarkdown(
  projectRoot: string,
  terms: ExtractedTerm[],
): Promise<string> {
  const dir = path.join(projectRoot, '.wrongstack');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, DOMAIN_TERMS_FILENAME);
  const lines: string[] = [
    '# Project Domain Glossary',
    '',
    '> Maintained automatically by SageDomainTermExtractor.',
    '> Source-of-truth: SAGE memories tagged `domain-term` + `glossary`.',
    '> Do not edit by hand: re-run the extractor to regenerate.',
    '',
    `Last regenerated: ${new Date().toISOString()}`,
    '',
  ];
  if (terms.length === 0) {
    lines.push('_No project-specific terms detected yet._');
    lines.push('');
  } else {
    lines.push('| Term | Definition | Confidence |');
    lines.push('| --- | --- | --- |');
    for (const t of terms) {
      const safeTerm = t.term.replace(/\|/g, '\\|');
      const safeDef = (t.definition || '_pending_').replace(/\|/g, '\\|');
      lines.push(`| \`${safeTerm}\` | ${safeDef} | ${t.confidence.toFixed(2)} |`);
    }
    lines.push('');
  }
  await fs.writeFile(filePath, lines.join('\n'), 'utf8');
  return filePath;
}
