/**
 * SAGE-based automatic domain-glossary engine.
 *
 * Detects project-specific terminology from agent<->user conversations and
 * from git commits, and keeps a `<projectRoot>/.wrongstack/domain-terms.md`
 * mirror for human readability.
 *
 * Memory persistence is intentionally disabled
 * --------------------------------------------
 * The extractor used to persist each term as a regular `Sage` memory with
 * `tags: ['domain-term', 'glossary', 'project-jargon']`. That tagging
 * polluted the SAGE corpus with entries that were indistinguishable from
 * genuine project facts in search and triage. Persisting is now a
 * no-op: `persistVia` returns a `skipped` report for every term, and the
 * file mirror is regenerated from the in-memory `ExtractedTerm[]` of
 * the current pass rather than from SAGE state.
 *
 * What still runs:
 *
 *   - `extractFromConversation` / `extractFromCommits` — heuristic
 *     detection of project jargon from text.
 *   - `writeDomainTermsFile(projectRoot, terms)` — writes the
 *     `.wrongstack/domain-terms.md` mirror from the in-memory terms.
 *   - `persistViaAndMirror` — chains the no-op `persistVia` with the
 *     file mirror write so call sites that previously persisted
 *     terms and refreshed the mirror keep the same control flow.
 *
 * The lookup tags `domain-term` / `glossary` / `project-jargon` are
 * preserved as exported constants (see {@link DOMAIN_TERM_LOOKUP_TAG})
 * so the one-off `/memory purge-domain-terms` migration can still
 * identify and remove any historical entries that were tagged before
 * this change. New entries are never written.
 *
 * The system prompt glossary (`renderDomainGlossary` in
 * `packages/core/src/core/system-prompt-glossary.ts`) will now return
 * an empty string by construction, because no live SAGE memory will
 * carry the `domain-term` tag once the migration runs. The function
 * itself is left intact — hosts that still wire it continue to
 * receive a clean empty result, not a runtime error.
 *
 * Architectural rules respected here:
 *
 *   1. In-process consumers reach SAGE through `ProjectSageMemoryPort`
 *      (direct IPC over the per-project socket). The MCP layer is
 *      reserved for external consumers. See
 *      `../../docs/direct-icp-usage.md` for the contract.
 *   2. The file mirror (`.wrongstack/domain-terms.md`) is **derived
 *      state** regenerated from in-memory terms on every extraction
 *      pass. Deleting the file does not lose data — the next
 *      extraction overwrites it.
 *   3. The mirror is bounded by the per-call cap and a per-entry char
 *      cap (default 96 chars). The prompt goal is precision over
 *      recall: a 6-line dictionary the model actually reads beats a
 *      200-term dump it ignores.
 *
 * Heuristic detection rules (deliberately conservative — false positives
 * pollute the mirror):
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

const execFileAsync = promisify(execFile);

/**
 * Historical lookup tag. The extractor no longer writes memories with
 * this tag, but the constant is kept exported so the
 * `/memory purge-domain-terms` migration and any external tooling
 * (debugging, search filters) can still reference the canonical
 * tag name.
 */
export const DOMAIN_TERM_LOOKUP_TAG = 'domain-term';
/** Companion tag from the old `['domain-term', 'glossary', 'project-jargon']`
 *  trio. Kept exported for the same reason as {@link DOMAIN_TERM_LOOKUP_TAG}. */
export const GLOSSARY_LOOKUP_TAG = 'glossary';
/** Companion tag from the old trio. Kept exported for the same reason. */
export const PROJECT_JARGON_TAG = 'project-jargon';

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
 * Detect and render the project's domain glossary.
 *
 * The class is intentionally stateless — every method consumes
 * already-gathered inputs. The extractor used to round-trip terms
 * through SAGE; persistence is now disabled, so the only durable
 * artefact is the `<projectRoot>/.wrongstack/domain-terms.md` mirror
 * regenerated from in-memory `ExtractedTerm[]` on every pass. A
 * caller can therefore construct a single extractor at boot and
 * call it from many turns without leaking state.
 */
export class SageDomainTermExtractor {
  /**
   * Detect candidate terms from a recent conversation.
   *
   * The result is *candidate* data: callers should pass it through
   * {@link persistViaAndMirror} (or {@link writeDomainTermsFile}
   * directly) to refresh the on-disk mirror. Detection never deletes
   * or alters project state.
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

    const merged = [...byKey.values()];
    applyFrequencyBonus(merged);
    return merged.sort((a, b) => b.confidence - a.confidence).slice(0, limit);
  }

  /**
   * Detect candidate terms from `git log` output. Reads commit
   * subjects + at most the first 80 lines of each commit's diff.
   *
   * Returns `[]` if the project is not a git repo or `git` is not on
   * PATH — never throws. Like {@link extractFromConversation}, the
   * result is *candidate* data: pass it to
   * {@link persistViaAndMirror} (or {@link writeDomainTermsFile}
   * directly) to refresh the on-disk mirror.
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

    const merged = [...byKey.values()];
    applyFrequencyBonus(merged);
    return merged.sort((a, b) => b.confidence - a.confidence).slice(0, limit);
  }

  /**
   * Persist terms through the supplied `MemoryPort`. The port is
   * intentionally ignored — the extractor no longer writes to SAGE.
   *
   * The method remains on the public API so that existing call sites
   * (turn middleware, session-end commit extractor, tests, embedders)
   * keep their control flow: they call `persistVia` / `persistViaAndMirror`
   * and get back a meaningful `PersistReport` without having to know
   * that persistence is disabled. Every term is reported as `skipped`
   * with the same reason so the report shape stays stable for tests
   * and dashboards.
   *
   * The `options` argument is accepted for source compatibility only;
   * `minConfidence`, `overwriteExisting`, and `sourceRefs` are no longer
   * consulted.
   */
  async persistVia(
    _port: MemoryPort,
    terms: ReadonlyArray<ExtractedTerm>,
    _options: PersistOptions = {},
  ): Promise<PersistReport> {
    return {
      added: 0,
      updated: 0,
      skipped: terms.length,
      outcomes: terms.map((t) => ({
        term: t.term,
        action: 'skipped' as const,
        reason: 'memory persistence disabled (domain-term tagging removed)',
      })),
    };
  }

  /**
   * Render the glossary file under `<projectRoot>/.wrongstack/`. The
   * file is regenerated from the supplied in-memory `ExtractedTerm[]`;
   * no SAGE lookup is performed, so the mirror is always a faithful
   * snapshot of the caller's terms.
   *
   * Returns the absolute path of the written file. When `terms` is
   * empty, the file is written with the standard "no terms detected"
   * placeholder so the path always exists for downstream readers.
   */
  async writeDomainTermsFile(
    projectRoot: string,
    terms: ReadonlyArray<ExtractedTerm>,
  ): Promise<string> {
    return renderDomainTermsMarkdown(projectRoot, terms);
  }

  /**
   * Persist terms and, when `projectRoot` is provided, refresh the
   * human-readable mirror file at `<projectRoot>/.wrongstack/domain-terms.md`.
   *
   * The mirror is **derived state** (see module-level rule #2): it
   * is regenerated atomically on every extraction pass from the
   * in-memory terms, independent of SAGE. Hosts that want a
   * guaranteed fresh mirror after a batched extraction pipeline
   * should call this rather than `persistVia` followed by
   * `writeDomainTermsFile` separately — it avoids the "extract
   * ran but mirror write was skipped" window.
   *
   * Behaviour:
   *   - Always returns the underlying `PersistReport`
   *     (added/updated/skipped). With persistence disabled, every
   *     term is reported as `skipped` with the canonical reason.
   *   - When `projectRoot` is `undefined`, performs the no-op
   *     persist only and returns the report unchanged.
   *     `mirrorPath` is `null`.
   *   - When `projectRoot` is provided, calls `writeDomainTermsFile`
   *     with the in-memory `terms`. If the mirror write throws, the
   *     error is **swallowed** and `mirrorPath` is `null` — the host
   *     can retry the mirror on a later extraction pass.
   *
   * Never throws on a working filesystem for mirror IO errors.
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
      const mirrorPath = await this.writeDomainTermsFile(options.projectRoot, terms);
      return { report, mirrorPath };
    } catch {
      // Mirror is derived state; the next extraction pass will
      // overwrite the file. Surface the path as null so callers can
      // detect and retry.
      return { report, mirrorPath: null };
    }
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
        mentionCount: 1,
        evidence: [raw],
        sources: [source],
      });
    }
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
function applyFrequencyBonus(terms: ExtractedTerm[]): void {
  for (const t of terms) {
    if (t.mentionCount <= 1) continue;
    const bonus = Math.min(0.15, Math.log2(t.mentionCount) * 0.05);
    t.confidence = Math.min(0.99, t.confidence + bonus);
  }
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
async function renderDomainTermsMarkdown(
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
