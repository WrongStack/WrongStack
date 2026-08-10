/**
 * Outcome attribution for captured directives.
 *
 * Capture answers "what did the agent conclude?". This module answers the
 * question the loop was missing: **did that conclusion help?** Without it the
 * environment's reward reached `affinity.json` and stopped there, so a directive
 * that made every task worse was injected forever and could only ever leave the
 * buffer by growing old.
 *
 * The attribution is deliberately cheap and model-free. When a task finishes,
 * its final report is scanned for evidence that each already-stored directive
 * was actually exercised — its anchors (commands, paths, package names, which
 * capture already extracts into `entry.how`) appearing verbatim, or enough of
 * its distinctive wording to be unambiguous. Every directive that was exercised
 * takes the task's outcome onto its own record.
 *
 * This is correlation, not proof: a directive can be mentioned and irrelevant,
 * or decisive and unmentioned. It is used accordingly — to order eviction, to
 * protect proven rules from being overwritten, to retire rules that keep losing,
 * and to tell the distillation pass which directives earned their place. None of
 * those decisions is safe to make on age alone, which is what they used before.
 */

import * as path from 'node:path';
import {
  consolidatedDocumentPath,
  loadProjectAgentConsolidated,
  readRawLearnedEntries,
} from './project-agent-consolidation.js';
import {
  directiveTrials,
  directiveUtility,
  renderLearnedInstructions,
  type StructuredLearnedEntry,
} from './project-agent-learning-structured.js';
import { assertProjectAgentRole, roleDir, writeTextAtomically } from './project-agent-paths.js';
import {
  appendQuarantine,
  hasDirectiveContent,
  scrubRetiredLines,
} from './project-agent-quarantine.js';
import {
  clearProjectSkillAugmentation,
  loadProjectSkillAugmentation,
  projectSkillAugmentationPath,
} from './project-agent-skill-layer.js';

/** Trials a directive must have before a bad record can retire it. */
export const DIRECTIVE_QUARANTINE_MIN_APPLIED = 8;
/** Utility below which a directive with enough trials is retired. */
export const DIRECTIVE_QUARANTINE_MAX_UTILITY = 0.3;

/**
 * Anchors shorter than this match too much prose to be evidence of anything.
 *
 * Six, not four: `pnpm`, `main` and `git` are four characters and appear in
 * almost every report, so a directive whose only anchor was one of those would
 * be credited with every task the role ever ran. A directive left with no
 * usable anchor falls through to the wording test rather than being skipped.
 */
const MIN_ANCHOR_LENGTH = 6;
/** Tokens this long carry enough signal to identify a directive by wording. */
const DISTINCTIVE_TOKEN_LENGTH = 6;
/**
 * Matched tokens required before wording alone attributes a directive.
 *
 * An absolute floor as well as a ratio: a four-word directive that happens to
 * share three words with a report is a coincidence, not evidence, and a ratio
 * on its own cannot tell the two apart.
 */
const MIN_DISTINCTIVE_TOKENS = 5;
/** Fraction of those tokens that must appear in the report. */
const DISTINCTIVE_COVERAGE = 0.6;

function learnedPath(role: string, projectRoot?: string): string {
  return path.join(roleDir(role, projectRoot), 'learned.md');
}

/** Bare anchors (backticks already stripped) that are long enough to match on. */
function directiveAnchors(entry: StructuredLearnedEntry): string[] {
  return entry.how
    .split('\n')
    .map((line) => line.replace(/`/g, '').trim().toLowerCase())
    .filter((anchor) => anchor.length >= MIN_ANCHOR_LENGTH);
}

function distinctiveTokens(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        // `.`, `/` and `-` survive inside a token so `foo.ts` and
        // `packages/core` stay whole, but a sentence-final period is not part
        // of the word: leaving it attached meant `defect.` never matched a
        // report that said `defect,`.
        .replace(/[^\w\s./@-]/g, ' ')
        .split(/\s+/)
        .map((token) => token.replace(/^[./@-]+/, '').replace(/[./@-]+$/, ''))
        .filter((token) => token.length >= DISTINCTIVE_TOKEN_LENGTH),
    ),
  ];
}

/**
 * Whether `report` shows this directive was exercised.
 *
 * One anchor is enough: anchors are exact commands, paths and package names, so
 * their appearance in a report is a direct statement that the thing the
 * directive is about was touched. Directives with no anchors fall back to
 * wording, which needs a high bar because generic prose overlaps easily.
 */
export function directiveWasApplied(entry: StructuredLearnedEntry, report: string): boolean {
  const haystack = report.toLowerCase();
  if (!haystack) return false;
  const anchors = directiveAnchors(entry);
  if (anchors.length > 0) {
    return anchors.some((anchor) => haystack.includes(anchor));
  }
  const tokens = distinctiveTokens(entry.what);
  if (tokens.length < MIN_DISTINCTIVE_TOKENS) return false;
  const hits = tokens.filter((token) => haystack.includes(token)).length;
  return hits >= MIN_DISTINCTIVE_TOKENS && hits / tokens.length >= DISTINCTIVE_COVERAGE;
}

export interface DirectiveOutcomeResult {
  role: string;
  /** Directives credited with this task's outcome. */
  attributed: number;
  /** Directives retired into `quarantine.md` by this update. */
  quarantined: string[];
}

/**
 * Fold one completed task's outcome into the record of every directive it
 * exercised, then retire the ones whose record has become bad enough.
 *
 * Must run **before** the same output is captured: a directive written by this
 * task has not been tested by this task, and crediting it here would let every
 * new directive vouch for itself.
 *
 * Can throw on an invalid role or an unwritable role directory. Callers on the
 * task-completion path must swallow it: a lost outcome costs ranking quality,
 * which is never worth failing a completed task over.
 */
export function recordDirectiveOutcomes(
  role: string,
  report: string,
  succeeded: boolean,
  projectRoot?: string,
): DirectiveOutcomeResult {
  const normalizedRole = assertProjectAgentRole(role);
  const empty: DirectiveOutcomeResult = { role: normalizedRole, attributed: 0, quarantined: [] };
  if (!report.trim()) return empty;

  const entries = readRawLearnedEntries(normalizedRole, projectRoot);
  if (entries.length === 0) return empty;

  const updated: StructuredLearnedEntry[] = [];
  const retired: StructuredLearnedEntry[] = [];
  let attributed = 0;

  for (const entry of entries) {
    if (!directiveWasApplied(entry, report)) {
      updated.push(entry);
      continue;
    }
    attributed++;
    const trials = directiveTrials(entry);
    const next: StructuredLearnedEntry = {
      ...entry,
      applied: trials.applied + 1,
      wins: trials.wins + (succeeded ? 1 : 0),
    };
    if (
      directiveTrials(next).applied >= DIRECTIVE_QUARANTINE_MIN_APPLIED &&
      directiveUtility(next) < DIRECTIVE_QUARANTINE_MAX_UTILITY
    ) {
      retired.push(next);
      continue;
    }
    updated.push(next);
  }

  if (attributed === 0) return empty;

  const at = new Date().toISOString();
  // Render under the newest entry's own timestamp: the document footer reads
  // "Last capture", and an outcome update is not a capture. Bumping it would
  // also inflate the raw byte count the consolidation freshness gate compares
  // against. The budget is deliberately not re-enforced here — eviction is
  // capture's job, and an outcome update only ever adds a few bytes of counter
  // per entry, which the next capture trims.
  const newest =
    updated
      .map((entry) => entry.capturedAt)
      .filter(Boolean)
      .sort()
      .pop() ?? at;
  writeTextAtomically(
    learnedPath(normalizedRole, projectRoot),
    renderLearnedInstructions(normalizedRole, updated, newest),
  );
  if (retired.length > 0) {
    appendQuarantine(normalizedRole, retired, at, projectRoot);
    scrubRetiredFromInjectedDocuments(normalizedRole, retired, projectRoot);
  }
  return {
    role: normalizedRole,
    attributed,
    quarantined: retired.map((entry) => entry.what),
  };
}

/**
 * Take a retired directive out of the two documents that are injected but not
 * rebuilt on retirement: the skill addendum it was distilled into, and the
 * role-level consolidated document.
 *
 * Removing it from the capture buffer alone was not enough — by the time a
 * directive has been exercised eight times it has almost certainly been through
 * a distillation pass, and the next one is up to a cooldown away. Until then
 * the agent kept reading the retired rule as part of its own skill, which is
 * the most authoritative place it could possibly appear.
 */
function scrubRetiredFromInjectedDocuments(
  role: string,
  retired: readonly StructuredLearnedEntry[],
  projectRoot?: string,
): void {
  const texts = retired.map((entry) => entry.what);

  for (const skill of new Set(retired.map((entry) => entry.skill).filter(Boolean) as string[])) {
    try {
      const current = loadProjectSkillAugmentation(role, skill, projectRoot);
      if (!current) continue;
      const scrubbed = scrubRetiredLines(current, texts);
      if (scrubbed === current.trim()) continue;
      // An addendum whose every rule was retired is not an addendum any more.
      // Deleting it is honest: this project no longer has practice to add, and
      // the skill goes back to being ranked on its bundled body alone.
      if (!hasDirectiveContent(scrubbed)) {
        clearProjectSkillAugmentation(role, skill, projectRoot);
        continue;
      }
      writeTextAtomically(projectSkillAugmentationPath(role, skill, projectRoot), `${scrubbed}\n`);
    } catch {
      // Best effort: a failed scrub must not fail the task that triggered it.
    }
  }

  try {
    const consolidated = loadProjectAgentConsolidated(role, projectRoot);
    if (!consolidated) return;
    const scrubbed = scrubRetiredLines(consolidated, texts);
    // Leave an emptied role document alone rather than writing a husk; the next
    // optimization pass rebuilds it from the buffer.
    if (scrubbed === consolidated.trim() || !hasDirectiveContent(scrubbed)) return;
    writeTextAtomically(consolidatedDocumentPath(role, projectRoot), scrubbed);
  } catch {
    // Same: best effort.
  }
}
