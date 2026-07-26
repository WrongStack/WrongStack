import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import * as path from 'node:path';
import { splitLearnedEntries } from './project-agent-learning-entries.js';
import { assertProjectAgentRole, roleDir, writeTextAtomically } from './project-agent-paths.js';

export interface ConsolidationMetadata {
  /** ISO timestamp of the last consolidation. */
  consolidatedAt: string;
  /** Number of raw learned.md entries that were synthesized. */
  sourceEntryCount: number;
  /** Byte size of the raw learned.md at consolidation time. */
  sourceBytes: number;
  /** Byte size of the resulting consolidated.md. */
  consolidatedBytes: number;
  /** Whether the consolidation was user-triggered or automatic. */
  trigger: 'manual' | 'automatic';
  /** Optional model that produced the consolidation. */
  model?: string | undefined;
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

function listProjectAgentLearnedTextEntries(role: string, projectRoot?: string): string[] {
  return splitLearnedEntries(loadProjectAgentLearnedText(role, projectRoot));
}

function consolidationPath(role: string, projectRoot?: string): string {
  return path.join(roleDir(role, projectRoot), 'consolidated.md');
}

function consolidationMetaPath(role: string, projectRoot?: string): string {
  return path.join(roleDir(role, projectRoot), 'consolidation.json');
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

export function saveProjectAgentConsolidated(
  role: string,
  content: string,
  projectRoot?: string,
  metadata?: Partial<ConsolidationMetadata>,
): string {
  if (!content.trim()) {
    return consolidationPath(assertProjectAgentRole(role), projectRoot);
  }
  const normalizedRole = assertProjectAgentRole(role);
  const dir = roleDir(normalizedRole, projectRoot);
  mkdirSync(dir, { recursive: true });
  const fp = consolidationPath(normalizedRole, projectRoot);
  writeTextAtomically(fp, content);

  const rawEntries = listProjectAgentLearnedTextEntries(normalizedRole, projectRoot);
  const rawBytes = Buffer.byteLength(loadProjectAgentLearnedText(normalizedRole, projectRoot), 'utf8');
  const meta: ConsolidationMetadata = {
    consolidatedAt: new Date().toISOString(),
    sourceEntryCount: rawEntries.length,
    sourceBytes: rawBytes,
    consolidatedBytes: Buffer.byteLength(content, 'utf8'),
    trigger: metadata?.trigger ?? 'manual',
    ...(metadata?.model ? { model: metadata.model } : {}),
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
  const rawEntries = listProjectAgentLearnedTextEntries(normalizedRole, projectRoot);
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
