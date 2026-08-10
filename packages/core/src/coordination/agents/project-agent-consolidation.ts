import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { splitLearnedEntries } from './project-agent-learning-entries.js';
import {
  directiveTrials,
  parseStructuredLearnedEntriesFromContent,
  renderLearnedInstructions,
  type StructuredLearnedEntry,
} from './project-agent-learning-structured.js';
import { assertProjectAgentRole, roleDir, writeTextAtomically } from './project-agent-paths.js';
import { retiredDirectivesToWarnAbout } from './project-agent-quarantine.js';

export interface ConsolidationMetadata {
  /** ISO timestamp of the last consolidation. */
  consolidatedAt: string;
  /**
   * Number of raw `learned.md` **directives** that were synthesized.
   *
   * Counted with the structured parser. It used to be counted with
   * `splitLearnedEntries`, which returns 2 for any structured buffer, so the
   * freshness comparison in `buildProjectContextualizedPrompt` compared 2
   * against 2 forever and the delta-injection branch was unreachable.
   */
  sourceEntryCount: number;
  /** Byte size of the raw learned.md at consolidation time. */
  sourceBytes: number;
  /** Byte size of the resulting consolidated.md. */
  consolidatedBytes: number;
  /** Whether the consolidation was user-triggered or automatic. */
  trigger: 'manual' | 'automatic';
  /** Optional model that produced the consolidation. */
  model?: string | undefined;
  /** Whether the raw buffer was archived and reset after synthesis. */
  pruned?: boolean | undefined;
  /** Archive file holding the pre-prune raw buffer, when pruned. */
  archivePath?: string | undefined;
  /** Skill addenda refreshed by this pass. */
  skills?: string[] | undefined;
}

function learnedPath(role: string, projectRoot?: string): string {
  return path.join(roleDir(role, projectRoot), 'learned.md');
}

function loadProjectAgentLearnedText(role: string, projectRoot?: string): string {
  try {
    return readFileSync(learnedPath(role, projectRoot), 'utf8').trim();
  } catch {
    return '';
  }
}

/** Structured directives in the raw buffer, with legacy-format fallback. */
export function readRawLearnedEntries(
  role: string,
  projectRoot?: string,
): StructuredLearnedEntry[] {
  const raw = loadProjectAgentLearnedText(role, projectRoot);
  return parseStructuredLearnedEntriesFromContent(raw, splitLearnedEntries(raw));
}

function consolidationPath(role: string, projectRoot?: string): string {
  return path.join(roleDir(role, projectRoot), 'consolidated.md');
}

/**
 * The role document's path, for callers that need to rewrite it in place
 * without going through the full save-and-record-metadata pass.
 */
export function consolidatedDocumentPath(role: string, projectRoot?: string): string {
  return consolidationPath(assertProjectAgentRole(role), projectRoot);
}

function consolidationMetaPath(role: string, projectRoot?: string): string {
  return path.join(roleDir(role, projectRoot), 'consolidation.json');
}

function archivePath(role: string, at: string, projectRoot?: string): string {
  return path.join(roleDir(role, projectRoot), 'archive', `learned-${at.replace(/[:.]/g, '-')}.md`);
}

export function loadProjectAgentConsolidated(role: string, projectRoot?: string): string {
  try {
    return readFileSync(consolidationPath(role, projectRoot), 'utf8').trim();
  } catch {
    return '';
  }
}

export function loadConsolidationMetadata(
  role: string,
  projectRoot?: string,
): ConsolidationMetadata | undefined {
  try {
    const raw = readFileSync(consolidationMetaPath(role, projectRoot), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as ConsolidationMetadata).consolidatedAt === 'string' &&
      typeof (parsed as ConsolidationMetadata).sourceEntryCount === 'number'
    ) {
      return parsed as ConsolidationMetadata;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function isConsolidated(role: string, projectRoot?: string): boolean {
  return existsSync(consolidationMetaPath(role, projectRoot));
}

export interface SaveConsolidationOptions extends Partial<ConsolidationMetadata> {
  /**
   * Archive the raw buffer and reset it to an empty structured document.
   *
   * Consolidation used to leave `learned.md` untouched, so a role whose buffer
   * had crossed the soft limit stayed over it forever and never captured
   * again. Pruning is what actually closes the optimize→learn loop; the
   * pre-prune buffer is kept under `archive/` for audit.
   */
  prune?: boolean | undefined;
}

export function saveProjectAgentConsolidated(
  role: string,
  content: string,
  projectRoot?: string,
  options?: SaveConsolidationOptions,
): string {
  const normalizedRole = assertProjectAgentRole(role);
  if (!content.trim()) return consolidationPath(normalizedRole, projectRoot);
  const dir = roleDir(normalizedRole, projectRoot);
  mkdirSync(dir, { recursive: true });
  const fp = consolidationPath(normalizedRole, projectRoot);
  writeTextAtomically(fp, content);

  const consolidatedAt = new Date().toISOString();
  let archived: string | undefined;
  if (options?.prune) {
    const rawText = loadProjectAgentLearnedText(normalizedRole, projectRoot);
    if (rawText) {
      archived = archivePath(normalizedRole, consolidatedAt, projectRoot);
      writeTextAtomically(archived, rawText);
    }
    // Reset the active buffer. Every directive it held is now represented in
    // consolidated.md (and in the per-skill addenda), so the next capture
    // starts from a clean, well under-budget document.
    writeTextAtomically(
      learnedPath(normalizedRole, projectRoot),
      renderLearnedInstructions(normalizedRole, [], consolidatedAt),
    );
  }

  // Snapshot the buffer state *after* any prune so the freshness gate in
  // `buildProjectContextualizedPrompt` compares like with like.
  const rawEntries = readRawLearnedEntries(normalizedRole, projectRoot);
  const rawBytes = Buffer.byteLength(
    loadProjectAgentLearnedText(normalizedRole, projectRoot),
    'utf8',
  );
  const meta: ConsolidationMetadata = {
    consolidatedAt,
    sourceEntryCount: rawEntries.length,
    sourceBytes: rawBytes,
    consolidatedBytes: Buffer.byteLength(content, 'utf8'),
    trigger: options?.trigger ?? 'manual',
    ...(options?.model ? { model: options.model } : {}),
    ...(options?.prune ? { pruned: true } : {}),
    ...(archived ? { archivePath: archived } : {}),
    ...(options?.skills?.length ? { skills: [...options.skills] } : {}),
  };
  writeTextAtomically(
    consolidationMetaPath(normalizedRole, projectRoot),
    `${JSON.stringify(meta, null, 2)}\n`,
  );
  return fp;
}

export function clearProjectAgentConsolidated(role: string, projectRoot?: string): void {
  const normalizedRole = assertProjectAgentRole(role);
  for (const file of [
    consolidationPath(normalizedRole, projectRoot),
    consolidationMetaPath(normalizedRole, projectRoot),
  ]) {
    try {
      rmSync(file, { force: true });
    } catch {
      // already absent
    }
  }
}

export function buildConsolidationInstruction(
  role: string,
  projectRoot?: string,
): {
  instruction: string;
  rawEntries: string[];
  hasExistingConsolidation: boolean;
} {
  const normalizedRole = assertProjectAgentRole(role);
  const entries = readRawLearnedEntries(normalizedRole, projectRoot);
  const rawEntries = entries.map((entry) => {
    const lines = [entry.what];
    if (entry.how) lines.push(`   Anchors: ${entry.how.split('\n').join(', ')}`);
    const { applied, wins } = directiveTrials(entry);
    // The track record is the only signal here that did not come from the same
    // agent that wrote the directive. It is what lets the pass select rather
    // than merely summarise.
    if (applied > 0) lines.push(`   Track record: applied ${applied}×, ${wins} succeeded`);
    return lines.join('\n');
  });
  const existingConsolidation = loadProjectAgentConsolidated(normalizedRole, projectRoot);
  const rawBody = rawEntries.map((entry, i) => `### Entry ${i + 1}\n\n${entry}`).join('\n\n');

  const sections: string[] = [
    `You are reviewing and consolidating the captured learning entries for the "${normalizedRole}" agent role in this project.`,
    '',
    'Your task is to synthesize the raw entries below into a single, narrowly-scoped document that represents what this agent has learned — specifically for its skills and role responsibilities. This document is the **instruction manual for future invocations** of this agent in this project. It is not a journal, not an exhaustive transcription, and not a memory store.',
    '',
    '## Requirements',
    '',
    '1. **Be selective.** Some raw entries are noise — narrative descriptions of single-session events, ephemeral references (commit SHAs, timestamps, line numbers, PR refs), or thin fragments that cannot be generalized. **Drop them.** The output must be smaller than the input; a consolidation that preserves every word is not a consolidation.',
    '2. **Extract the directive.** When a raw entry mixes narrative framing with a buried lesson ("When I worked on X, I realized Y"), extract the lesson as a directive and discard the framing.',
    '3. **Generic, not specific.** Rewrite entries so they apply across sessions. Replace session-specific anchors (commit SHAs, dates, line numbers) with general principles or concrete tools/commands that will still be valid next month.',
    '4. **Self-contained bullets.** Each bullet must make sense standalone — understandable to a future agent that has no context about the session that produced it.',
    '5. **Narrow scope.** Keep only knowledge that is genuinely durable and role-relevant. When in doubt, leave it out.',
    '6. **Structured format.** Organize the content under clear markdown headings (##) by topic. Use bullet points for individual facts. Group by category (Conventions, Patterns, Warnings, Project Facts) when it helps scannability.',
    '7. **Preserve actionable anchors.** Keep exact file paths, command names, package names, and configuration values that make a directive concrete and runnable.',
    '8. **No filler.** Do not include meta-commentary about the consolidation process. The document should read as if it were always a single authoritative reference.',
    '9. **Trust the track record over your own judgement of plausibility.** An entry may carry `Track record: applied N×, M succeeded` — completed tasks that exercised it, and how many of those succeeded. Keep the ones that keep working, even when they read as obvious. An entry applied several times with few successes has been tested and has failed the test: drop it, or narrow it to the condition under which it actually holds. Entries with no track record are unproven rather than bad — judge them on merit, but do not let one displace a proven entry.',
    '',
    rawEntries.length > 0
      ? `## Raw learned entries (${rawEntries.length} total)\n\n${rawBody}`
      : '## Raw learned entries\n\n(No raw entries yet — return an empty document.)',
  ];

  if (existingConsolidation) {
    sections.push(
      '',
      `## Existing consolidated document (for reference — improve upon it)\n\n${existingConsolidation}`,
    );
  }

  // Only the ones the role has *not* since re-learned. Retirement archives
  // rather than deletes precisely because a rule can be right about a project
  // that has changed; a directive back in the buffer has earned its retrial and
  // must not be pre-emptively vetoed here.
  const retired = retiredDirectivesToWarnAbout(
    normalizedRole,
    entries.map((entry) => entry.what),
    projectRoot,
  );
  if (retired.length > 0) {
    sections.push(
      '',
      `## Retired — do not reinstate (${retired.length})\n\nThese were exercised repeatedly and kept correlating with failed tasks. If the existing document above still states any of them, drop it.\n\n${retired
        .map((what) => `- ${what}`)
        .join('\n')}`,
    );
  }

  sections.push(
    '',
    '## Output',
    '',
    'Return ONLY the consolidated markdown document. Do not wrap it in code fences or add commentary.',
  );

  return {
    instruction: sections.join('\n'),
    rawEntries,
    hasExistingConsolidation: Boolean(existingConsolidation),
  };
}
