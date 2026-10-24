import type { ExtractedTerm } from './domain-term-candidates.js';
import {
  applyFrequencyBonus,
  extractCandidatesFromCommitSection,
  extractCandidatesFromMessage,
  mergeTerm,
  renderDomainTermsMarkdown,
  splitCommitSections,
} from './domain-term-candidates.js';

export type { ExtractedTerm } from './domain-term-candidates.js';
export { DOMAIN_TERMS_FILENAME, normalizeTerm } from './domain-term-candidates.js';

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
import { promisify } from 'node:util';
import type { MemoryPort } from '@wrongstack/contracts/types';

const execFileAsync = promisify(execFile);

/**
 * Historical lookup tag. The extractor no longer writes memories with
 * this tag, but the constant is kept exported so the
 * `/memory purge-domain-terms` migration and any external tooling
 * (debugging, search filters) can still reference the canonical
 * tag name.
 */
export const DOMAIN_TERM_LOOKUP_TAG = 'domain-term';

/** Cap entries rendered into the prompt block. */
export const DEFAULT_MAX_GLOSSARY_ENTRIES = 24;
/** Cap the definition text per entry. Keeps the block ≤ ~2 KB. */
export const DEFAULT_GLOSSARY_ENTRY_CHARS = 96;

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
        // `log -p` runs the textconv / external diff command a repository's
        // own config assigns through `.gitattributes`.
        '--no-textconv',
        '--no-ext-diff',
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
