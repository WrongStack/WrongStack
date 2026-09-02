#!/usr/bin/env node
/**
 * Idempotent re-application of the CLI-side agent-learning changes.
 *
 * Kept as a script because an external editor in this workspace repeatedly
 * reverted `packages/cli/src/**` mid-session. Run it if the fleet host or the
 * `/agent-improve` command loses the skill-layer wiring:
 *
 *   node scripts/apply-agent-learning-cli-patch.mjs
 *
 * Every patch is guarded: already-applied files are skipped, and a missing
 * anchor is a hard error rather than a silent no-op.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let changed = 0;

function edit(relPath, marker, pairs) {
  const file = path.join(repoRoot, relPath);
  let text = readFileSync(file, 'utf8');
  if (text.includes(marker)) {
    console.log(`  skip   ${relPath} (already applied)`);
    return;
  }
  for (const [oldText, newText] of pairs) {
    if (!text.includes(oldText)) {
      throw new Error(`anchor not found in ${relPath}: ${oldText.slice(0, 80)}…`);
    }
    text = text.replace(oldText, newText);
  }
  writeFileSync(file, text, 'utf8');
  changed++;
  console.log(`  patch  ${relPath}`);
}

function rewrite(relPath, marker, contents) {
  const file = path.join(repoRoot, relPath);
  if (readFileSync(file, 'utf8').includes(marker)) {
    console.log(`  skip   ${relPath} (already applied)`);
    return;
  }
  writeFileSync(file, contents, 'utf8');
  changed++;
  console.log(`  write  ${relPath}`);
}

// ── host-context.ts ─────────────────────────────────────────────────────────
rewrite(
  'packages/cli/src/fleet/host-context.ts',
  'resolveHostSubagentSkillResolution',
  `import {
  loadProjectSkillAugmentation,
  missingRequiredRuntimeTools,
  missingRuntimeCapabilities,
  rankRoleSkills,
  recordSkillLoad,
  resolveRoleSkillCandidates,
  runtimeToolReferencesFromText,
} from '@wrongstack/core/agent-catalog';
import { TOKENS } from '@wrongstack/core/kernel';
import type { SubagentConfig } from '@wrongstack/core/types';
import { getSageRetrieval } from '@wrongstack/sage';

import type { MultiAgentDeps } from './host-types.js';

/** Eagerly-loaded skills per spawn. Kept small so the prompt stays affordable. */
const EAGER_SKILL_LIMIT = 3;

/** Skills whose bodies were requested but did not make it into the prompt. */
export interface SkillResolutionReport {
  content: string;
  selected: string[];
  /** skill → why it was dropped, so the omission is never silent. */
  dropped: Record<string, 'not-found' | 'missing-capability' | 'missing-tool' | 'budget' | 'empty'>;
}

export async function resolveHostSubagentSkillResolution(
  deps: MultiAgentDeps,
  roster: Record<string, SubagentConfig>,
  subCfg: SubagentConfig,
  availableToolNames: readonly string[] = [],
): Promise<SkillResolutionReport> {
  const role = subCfg.role;
  const rosterEntry = role ? roster[role] : undefined;
  const directContent = subCfg.skillContent?.trim();
  const dropped: SkillResolutionReport['dropped'] = {};

  // Candidate pool, widest first: an explicit per-spawn list wins; otherwise
  // the role's full curated pool (not just the catalog's default eager slice)
  // plus any skill this project has already developed an addendum for.
  const pool = [
    ...new Set(
      subCfg.skillNames ??
        (role
          ? [
              ...(rosterEntry?.skillPool ?? rosterEntry?.skillNames ?? []),
              ...resolveRoleSkillCandidates(role, deps.projectRoot),
            ]
          : []),
    ),
  ];
  // Rank by project affinity so a skill this project actually developed
  // outranks an unused sibling from the same curated set.
  const skillNames = role
    ? rankRoleSkills(role, pool, deps.projectRoot, EAGER_SKILL_LIMIT)
    : pool.slice(0, EAGER_SKILL_LIMIT);

  if (skillNames.length === 0 || !deps.skillLoader) {
    return { content: directContent ?? '', selected: [], dropped };
  }

  const resolved: string[] = [];
  const selected: string[] = [];
  let usedChars = 0;
  const maxChars = 16_000;
  const maxCharsPerSkill = 4_000;
  for (const skillName of skillNames) {
    try {
      const manifest = await deps.skillLoader.find(skillName);
      if (!manifest) {
        dropped[skillName] = 'not-found';
        continue;
      }
      if (missingRuntimeCapabilities(manifest.requiredCapabilities, availableToolNames).length > 0) {
        dropped[skillName] = 'missing-capability';
        continue;
      }
      if (missingRequiredRuntimeTools(manifest.requiredTools, availableToolNames).length > 0) {
        dropped[skillName] = 'missing-tool';
        continue;
      }
      const body = (await deps.skillLoader.readSaveBody(skillName)).trim();
      if (!body) {
        dropped[skillName] = 'empty';
        continue;
      }
      if (
        missingRequiredRuntimeTools(runtimeToolReferencesFromText(body), availableToolNames)
          .length > 0
      ) {
        dropped[skillName] = 'missing-tool';
        continue;
      }
      // The project addendum belongs to the skill, not to a separate memory
      // block: it is what this project has taught the role about applying
      // this skill here, so it is read as part of the skill body.
      const augmentation = role
        ? loadProjectSkillAugmentation(role, skillName, deps.projectRoot)
        : '';
      const entry = [
        \`## Skill: \${skillName}\`,
        '',
        body.slice(0, maxCharsPerSkill),
        ...(augmentation
          ? [
              '',
              \`### Project practice for \\\`\${skillName}\\\`\`,
              '',
              'Learned in this project. Where this differs from the general method above, follow this.',
              '',
              augmentation,
            ]
          : []),
      ].join('\\n');
      if (usedChars + entry.length > maxChars) {
        dropped[skillName] = 'budget';
        continue;
      }
      resolved.push(entry);
      selected.push(skillName);
      usedChars += entry.length;
    } catch {
      dropped[skillName] = 'not-found';
    }
  }

  if (role && selected.length > 0) {
    try {
      recordSkillLoad(role, selected, deps.projectRoot);
    } catch {
      // Affinity bookkeeping must never block a spawn.
    }
  }

  const sections = [
    directContent,
    resolved.length > 0
      ? \`# Role-prioritized skills\\n\\nApply these skills first for this assignment.\\n\\n\${resolved.join('\\n\\n---\\n\\n')}\`
      : undefined,
  ].filter((section): section is string => Boolean(section));
  return { content: sections.join('\\n\\n'), selected, dropped };
}

/** Backwards-compatible wrapper for callers that only need the prompt text. */
export async function resolveHostSubagentSkillContent(
  deps: MultiAgentDeps,
  roster: Record<string, SubagentConfig>,
  subCfg: SubagentConfig,
  availableToolNames: readonly string[] = [],
): Promise<string> {
  return (await resolveHostSubagentSkillResolution(deps, roster, subCfg, availableToolNames))
    .content;
}

export async function retrieveHostSubagentMemory(
  deps: MultiAgentDeps,
  getLeaderMode: (() => string | undefined) | undefined,
  subCfg: SubagentConfig,
  taskContext?: Record<string, unknown>,
): Promise<string[]> {
  const memoryPort = deps.container.safeResolve(TOKENS.MemoryStore);
  const memory = memoryPort ? getSageRetrieval(memoryPort) : undefined;
  if (!memory?.retrieveForAudience) return [];
  const contextualTaskType =
    typeof taskContext?.['taskType'] === 'string' ? taskContext['taskType'] : undefined;
  try {
    const taskType = subCfg.memoryContext?.taskType ?? contextualTaskType;
    const mode = subCfg.memoryContext?.mode ?? getLeaderMode?.();
    const matches = await memory.retrieveForAudience(
      {
        ...(subCfg.role !== undefined ? { role: subCfg.role } : {}),
        ...(taskType !== undefined ? { taskType } : {}),
        ...(mode !== undefined ? { mode } : {}),
      },
      20,
    );
    await memory.recordInjection?.(
      matches.map((item) => item.id),
      'subagent_audience',
      deps.session.id,
    );
    return matches.map((item) => item.text);
  } catch {
    return [];
  }
}
`,
);

// ── host-learning.ts ────────────────────────────────────────────────────────
rewrite(
  'packages/cli/src/fleet/host-learning.ts',
  'LearningSubject',
  `import {
  captureLearnedFromAgentOutputDetailed,
  recordSkillOutcome,
} from '@wrongstack/core/agent-catalog';
import { TOKENS } from '@wrongstack/core/kernel';
import type { TaskResult } from '@wrongstack/core/types';
import type { MultiAgentDeps } from './host-types.js';

/** What a spawn recorded about the agent that will produce this result. */
export interface LearningSubject {
  role: string;
  skills: readonly string[];
}

export function captureCompletedTaskLearningForHost(
  result: TaskResult,
  deps: Pick<MultiAgentDeps, 'container' | 'projectRoot'>,
  subjects: ReadonlyMap<string, LearningSubject>,
): void {
  const subject = subjects.get(result.subagentId);
  if (!subject) return;
  const logger = deps.container.safeResolve(TOKENS.Logger);

  // Feed the outcome back into skill affinity before anything can throw, so a
  // capture failure does not also lose the signal about which skills were
  // loaded for a task that did / did not work out.
  if (subject.skills.length > 0) {
    try {
      recordSkillOutcome(
        subject.role,
        subject.skills,
        result.status === 'success',
        deps.projectRoot,
      );
    } catch (error) {
      logger?.debug?.(\`skill affinity update failed for role "\${subject.role}": \${describe(error)}\`);
    }
  }

  // Capture from failed and cancelled tasks too. A subagent that hit a wall and
  // wrote down *why* is the single highest-value learning source there is;
  // restricting capture to successes threw all of it away.
  const finalText = typeof result.result === 'string' ? result.result : result.partial?.text;
  if (!finalText) return;
  try {
    const capture = captureLearnedFromAgentOutputDetailed(
      finalText,
      subject.role,
      deps.projectRoot,
      false,
    );
    if (capture.captured > 0) {
      const routed = capture.skills?.length ? \` (skills: \${capture.skills.join(', ')})\` : '';
      logger?.debug(
        \`agent learning captured \${capture.captured} item(s) for role "\${subject.role}"\${routed}\`,
      );
    }
  } catch (error) {
    logger?.warn(\`agent learning capture failed for role "\${subject.role}": \${describe(error)}\`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
`,
);

// ── host-learning-tracker.ts ────────────────────────────────────────────────
rewrite(
  'packages/cli/src/fleet/host-learning-tracker.ts',
  'LearningSubject',
  `import type { TaskResult } from '@wrongstack/core/types';
import { setBoundedLruEntry } from './host-helpers.js';
import { captureCompletedTaskLearningForHost, type LearningSubject } from './host-learning.js';
import type { MultiAgentDeps } from './host-types.js';

export class HostLearningRoleTracker {
  private readonly roles = new Map<string, LearningSubject>();
  private readonly accessOrder: string[] = [];

  constructor(private readonly maxEntries = 256) {}

  record(subagentId: string, role: string, skills: readonly string[] = []): void {
    setBoundedLruEntry(
      this.roles,
      this.accessOrder,
      subagentId,
      { role, skills: [...skills] },
      this.maxEntries,
    );
  }

  capture(result: TaskResult, deps: Pick<MultiAgentDeps, 'container' | 'projectRoot'>): void {
    captureCompletedTaskLearningForHost(result, deps, this.roles);
  }
}
`,
);

// ── host-subagent-factory.ts ────────────────────────────────────────────────
edit('packages/cli/src/fleet/host-subagent-factory.ts', 'skillResolution', [
  [
    "import { resolveHostSubagentSkillContent, retrieveHostSubagentMemory } from './host-context.js';",
    "import { resolveHostSubagentSkillResolution, retrieveHostSubagentMemory } from './host-context.js';",
  ],
  [
    '  recordLearningRole: (subagentId: string, role: string) => void;',
    '  recordLearningRole: (subagentId: string, role: string, skills?: readonly string[]) => void;',
  ],
  [
    `    const roleSkillContent = await resolveHostSubagentSkillContent(
      host.deps,
      host.roster,
      effectiveCfg,
      subagentTools.map((tool) => tool.name),
    );
    if (roleSkillContent) {
      for (let index = baseSystem.length - 1; index >= 0; index--) {
        if (baseSystem[index]?.text.includes('# Active Skills')) baseSystem.splice(index, 1);
      }
      baseSystem.push({ type: 'text', text: roleSkillContent });
    }`,
    `    const skillResolution = await resolveHostSubagentSkillResolution(
      host.deps,
      host.roster,
      effectiveCfg,
      subagentTools.map((tool) => tool.name),
    );
    if (skillResolution.content) {
      for (let index = baseSystem.length - 1; index >= 0; index--) {
        if (baseSystem[index]?.text.includes('# Active Skills')) baseSystem.splice(index, 1);
      }
      baseSystem.push({ type: 'text', text: skillResolution.content });
    }
    const droppedSkills = Object.entries(skillResolution.dropped);
    if (droppedSkills.length > 0) {
      // A skill that silently fails to load leaves the agent believing it has
      // guidance it never received. Surface it on the event bus so the drop is
      // observable instead of a bare console.warn nobody reads.
      host.deps.events.emit('subagent.skills.dropped', {
        sessionId: host.deps.session.id,
        role: effectiveCfg.role,
        selected: skillResolution.selected,
        dropped: Object.fromEntries(droppedSkills),
      });
    }`,
  ],
  [
    '      host.recordLearningRole(subagentName, effectiveCfg.role);',
    '      host.recordLearningRole(subagentName, effectiveCfg.role, skillResolution.selected);',
  ],
]);

// ── host.ts ─────────────────────────────────────────────────────────────────
edit('packages/cli/src/fleet/host.ts', 'this.recordLearningRole(subagentId, subagentId)', [
  [
    `  private recordLearningRole(subagentId: string, role: string): void {
    this.learningRoles.record(subagentId, role);
  }`,
    `  private recordLearningRole(
    subagentId: string,
    role: string,
    skills: readonly string[] = [],
  ): void {
    this.learningRoles.record(subagentId, role, skills);
  }`,
  ],
  [
    '      recordLearningRole: (subagentId, role) => this.recordLearningRole(subagentId, role),',
    `      recordLearningRole: (subagentId, role, skills) =>
        this.recordLearningRole(subagentId, role, skills),`,
  ],
  [
    `    const acpRunner = await this.buildACPRunner(subagentId);
    coordinator.setRunner(acpRunner);`,
    `    const acpRunner = await this.buildACPRunner(subagentId);
    // ACP agents never pass through the subagent factory, so nothing recorded
    // their role and every \`## LEARNED\` block they wrote was discarded. Their
    // subagentId *is* the role name (see the spawn call below).
    this.recordLearningRole(subagentId, subagentId);
    coordinator.setRunner(acpRunner);`,
  ],
]);

console.log(
  changed === 0
    ? '\nNothing to do — all patches already applied.'
    : `\nApplied ${changed} file(s).`,
);
