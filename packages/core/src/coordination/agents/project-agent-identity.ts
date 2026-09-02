/**
 * Project-level agent identity, override and learning layer.
 *
 * Every built-in roster agent has a base definition (role + prompt + tools +
 * skills) in the catalog. On top of that, **each project** can:
 *
 * 1. Override prompt, tools, skills, budget per role
 * 2. Accumulate learned wisdom specific to this codebase
 * 3. Attach a project-custom identity (name, avatar, tone)
 *
 * Resolution cascade (most → least specific):
 *   activeLearning.json  →  project-identity.md  →  catalog base
 *
 * Files live under `.wrongstack/agents/<role>/`:
 *   config.json   — static overrides (tools, budget, skillNames)
 *   identity.md   — custom prompt appendix (tone, project-specific rules)
 *   learned.md    — auto-generated wisdom from past sessions
 *   knowledge.md  — current-needs checklist (what versions to verify today)
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { CAPTURE_COOLDOWN_MS, CAPTURE_MAX_PER_SESSION } from './project-agent-capture-window.js';
import {
  loadConsolidationMetadata,
  loadProjectAgentConsolidated,
} from './project-agent-consolidation.js';
import type { RoleKnowledgeManifest } from './project-agent-identity-types.js';
import { BUILT_IN_KNOWLEDGE_MANIFESTS } from './project-agent-knowledge-manifests.js';
import { splitLearnedEntries } from './project-agent-learning-entries.js';
import { loadProjectAgentLearningPolicy } from './project-agent-learning-policy.js';
import { parseStructuredLearnedEntriesFromContent } from './project-agent-learning-structured.js';
import { roleDir } from './project-agent-paths.js';
import { listProjectSkillAugmentations } from './project-agent-skill-layer.js';

export {
  DEFAULT_AUTO_OPTIMIZE_POLICY,
  evaluateAutoOptimize,
  LearningOptimizationScheduler,
  resolveAutoOptimizePolicy,
} from './project-agent-auto-optimize.js';
export {
  CAPTURE_SESSION_WINDOW_MS,
  resetCaptureWindow,
  resetCaptureWindows,
} from './project-agent-capture-window.js';
export { loadProjectAgentConfig } from './project-agent-config-io.js';
export { validateProjectAgentConfig } from './project-agent-config-validation.js';
export {
  buildConsolidationInstruction,
  clearProjectAgentConsolidated,
  consolidatedDocumentPath,
  isConsolidated,
  loadConsolidationMetadata,
  loadProjectAgentConsolidated,
  readRawLearnedEntries,
  saveProjectAgentConsolidated,
} from './project-agent-consolidation.js';
export {
  DIRECTIVE_QUARANTINE_MAX_UTILITY,
  DIRECTIVE_QUARANTINE_MIN_APPLIED,
  directiveWasApplied,
  recordDirectiveOutcomes,
} from './project-agent-directive-outcome.js';
export type {
  CreateProjectAgentInput,
  LearnedCaptureResult,
  ProjectAgentConfig,
  ProjectAgentProfile,
  RoleKnowledgeManifest,
} from './project-agent-identity-types.js';
export { splitLearnedEntries, tokenOverlap } from './project-agent-learning-entries.js';
export {
  classifyLearnedEntry,
  LEARNED_ENTRY_MAX_CHARS,
  LEARNED_HARD_LIMIT,
  LEARNED_SOFT_LIMIT,
  normalizeLearnedEntry,
} from './project-agent-learning-normalize.js';
export {
  loadProjectAgentLearningPolicy,
  recordProjectAgentOptimizePass,
  updateProjectAgentLearningPolicy,
} from './project-agent-learning-policy.js';
export {
  DIRECTIVE_PROVEN_MIN_APPLIED,
  DIRECTIVE_PROVEN_MIN_UTILITY,
  decomposeLearnedEntry,
  directiveTrials,
  directiveUtility,
  enforceLearnedBudget,
  isProvenDirective,
  mergeStructuredEntries,
  parseLearnedEntryStamp,
  parseStructuredLearnedEntriesFromContent,
  renderLearnedInstructions,
} from './project-agent-learning-structured.js';
export {
  optimizeProjectAgentLearning,
  unwrapWholeDocumentFence,
} from './project-agent-optimizer.js';
export { assertProjectAgentRole } from './project-agent-paths.js';
export {
  quarantinePath,
  readQuarantinedDirectives,
  retiredDirectivesToWarnAbout,
  scrubRetiredLines,
} from './project-agent-quarantine.js';
export {
  buildSkillDistillInstruction,
  clearProjectSkillAugmentation,
  DEFAULT_EAGER_SKILL_LIMIT,
  listProjectSkillAugmentations,
  loadProjectSkillAugmentation,
  loadSkillAffinity,
  rankRoleSkills,
  recordSkillLoad,
  recordSkillOutcome,
  renderSkillAugmentation,
  resolveRoleSkillCandidates,
  routeDirectiveToSkill,
  SKILL_AUGMENTATION_MAX_BYTES,
  SKILL_EVIDENCE_HALF_LIFE_DAYS,
  saveProjectSkillAugmentation,
  scoreSkillAffinity,
  setSkillPinned,
} from './project-agent-skill-layer.js';
export { CAPTURE_COOLDOWN_MS, CAPTURE_MAX_PER_SESSION };

export {
  listProjectAgentRoles,
  refreshProjectAgentIdentity,
  resetProjectAgentIdentity,
  updateProjectAgentConfig,
  updateProjectAgentIdentity,
  updateProjectAgentKnowledge,
  updateProjectAgentLearned,
} from './project-agent-files.js';
export {
  createProjectAgent,
  loadProjectAgentProfile,
  slugifyProjectAgentRole,
} from './project-agent-profile.js';

export {
  applyProjectAgentConfig,
  createProjectAgentRoster,
} from './project-agent-roster.js';

export {
  canCaptureNewLearned,
  captureLearnedFromAgentOutput,
  captureLearnedFromAgentOutputDetailed,
  detectLearnedConflicts,
  getProjectAgentLearnStats,
  hintLearnedNeedsSummarization,
  listProjectAgentLearnedEntries,
  loadProjectAgentLearned,
  parseStructuredLearnedEntries,
} from './project-agent-capture.js';

import { loadProjectAgentLearned } from './project-agent-capture.js';

/**
 * Load the project-level identity appendix for a given role.
 * Appended to the subagent prompt after the base role prompt and policy.
 * Returns the empty string when no identity file exists.
 */
export function loadProjectAgentIdentity(role: string, projectRoot?: string): string {
  const identityPath = path.join(roleDir(role, projectRoot), 'identity.md');
  try {
    return readFileSync(identityPath, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Load the current-knowledge checklist for a given role.
 * Returns the built-in directive if no project override exists.
 * The checklist guides the agent on what to verify from live registries
 * before answering questions in its domain.
 */
export function loadRoleKnowledgeManifest(
  role: string,
  projectRoot?: string,
): RoleKnowledgeManifest | undefined {
  const projectPath = path.join(roleDir(role, projectRoot), 'knowledge.json');
  try {
    const raw = readFileSync(projectPath, 'utf8');
    return JSON.parse(raw) as RoleKnowledgeManifest;
  } catch {
    return BUILT_IN_KNOWLEDGE_MANIFESTS[role];
  }
}

/**
 * Build the full project-contextualized prompt for a given role.
 *
 * Cascade, from start to end:
 *   1. Base role prompt from instruction files (agentPrompt(id))
 *   2. Technology policy (appended by agentPrompt)
 *   3. Project identity appendix (identity.md)
 *   4. Learned wisdom (learned.md)
 *   5. Live-knowledge checklist
 */
export function buildProjectContextualizedPrompt(
  basePrompt: string,
  role: string,
  projectRoot?: string,
  options: { identityOverride?: string | undefined } = {},
): string {
  const contextStart = '<!-- wrongstack:project-agent-context:start -->';
  const contextEnd = '<!-- wrongstack:project-agent-context:end -->';

  if (process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR']) return basePrompt;

  const cleanBase = basePrompt
    .replace(
      /\s*<!-- wrongstack:project-agent-context:start -->[\s\S]*?<!-- wrongstack:project-agent-context:end -->\s*/g,
      '\n',
    )
    .trim();
  const parts: string[] = [cleanBase];

  const identity = options.identityOverride ?? loadProjectAgentIdentity(role, projectRoot);
  if (identity) {
    parts.push(`\n\n# Project custom identity\n\n${identity}`);
  }

  const learningPolicy = loadProjectAgentLearningPolicy(role, projectRoot);
  let learnedContent = '';
  let learnedLabel = '';
  if (learningPolicy.enabled) {
    const consolidated = loadProjectAgentConsolidated(role, projectRoot);
    const rawLearned = loadProjectAgentLearned(role, projectRoot);
    if (consolidated) {
      const meta = loadConsolidationMetadata(role, projectRoot);
      const rawEntries = parseStructuredLearnedEntriesFromContent(
        rawLearned,
        splitLearnedEntries(rawLearned),
      );
      const rawBytes = Buffer.byteLength(rawLearned, 'utf8');
      const freshEntries =
        meta === undefined
          ? []
          : // `>=` not `>`: the raw buffer is reset at consolidation time, so
            // every entry left in it was captured afterwards in write order —
            // but on millisecond-resolution clocks (Linux) the ISO stamps can
            // tie, and a strict `>` would misread a genuinely fresh capture as
            // already consolidated.
            rawEntries.filter((entry) => entry.capturedAt >= meta.consolidatedAt);
      const stale =
        meta === undefined ||
        freshEntries.length > 0 ||
        rawEntries.length > meta.sourceEntryCount ||
        rawBytes > meta.sourceBytes;
      if (!stale) {
        learnedContent = consolidated;
        learnedLabel = 'Consolidated knowledge for this project';
      } else if (freshEntries.length > 0) {
        const delta = freshEntries.map((entry) => `- **${entry.what}**`).join('\n');
        learnedContent = `${consolidated}\n\n---\n\n## Recently captured (pending next optimization)\n\n${delta}`;
        learnedLabel = 'Consolidated knowledge for this project';
      } else {
        learnedContent = rawLearned;
        learnedLabel = 'Learned instructions for this project (structured: what / why / how)';
      }
    } else {
      learnedContent = rawLearned;
      learnedLabel = 'Learned instructions for this project (structured: what / why / how)';
    }
  }
  if (learnedContent) {
    const meaningful = learnedContent.replace(/<!--[\s\S]*?-->/g, '').trim();
    if (meaningful.length > 0) {
      parts.push(`\n\n# ${learnedLabel}\n\n${learnedContent}`);
    }
  }

  const effectiveProjectRoot = projectRoot || process.cwd();
  const learnedFilePath = path.join(
    effectiveProjectRoot,
    '.wrongstack',
    'agents',
    role,
    'learned.md',
  );
  if (learningPolicy.enabled) {
    parts.push(
      `\n\n## Knowledge capture\n\n` +
        `The file below stores **learning data for this project's "${role}" agent** — not your memory, not a session log. ` +
        `It is read back into the system prompt of every future "${role}" invocation, so each entry must teach a future agent how to act. ` +
        `On every capture the runtime **merges your new entry with every prior entry and rewrites the whole buffer as a structured instruction list** — grouped by category ("What to do", "What to avoid", "Patterns to follow", "Project facts"), with each item decomposed into **what** (the rule), **why** (the reason), and **how** (the concrete commands, file paths, or package names that anchor the rule). ` +
        `When you discover a durable principle that future invocations should follow, end your response with a \`## LEARNED\` block. The runtime persists it to:\n\n` +
        `  \`\`\`\n  ${learnedFilePath}\n  \`\`\`\n\n` +
        `**Write directives, not narratives.** Each LEARNED entry should be:\n\n` +
        `- A **rule or principle** that applies across sessions, not a description of what happened in this one.\n` +
        `- A short **imperative or statement** (1–3 sentences), starting with a verb like "Always verify…", "Use X for Y", "Avoid…", "Never assume…".\n` +
        `- **Generic** — no commit SHAs, timestamps, specific line numbers, or PR/issue numbers. File paths, package names, and command names are fine when they anchor the lesson.\n` +
        `- **Self-contained** — understandable without the surrounding session context.\n` +
        `- **Front-load concrete anchors** — commands in backticks, package names like \`@wrongstack/core\`, file paths like \`packages/core/src/.../foo.ts\`. The structured-list renderer extracts these as the "how" for the entry.\n\n` +
        `**Your directives are scored against real outcomes.** After every task the runtime checks which stored directives were actually exercised — it matches their anchors against the report — and folds that task's success or failure into each one's record. A directive that keeps correlating with success outlives newer arrivals and survives rewording; one that has been exercised repeatedly and kept correlating with failure is retired and stops being injected. Two consequences for how you write them: anchors are what make a directive *measurable*, not just runnable, so an anchorless directive can never earn a record; and a directive you are unsure about costs nothing to write, because the loop will find out.\n\n` +
        `**Tag the skill you are developing.** When a directive refines one of your skills, mark it: \`## LEARNED [skill: testing]\`. Tagged directives are distilled into that skill's project addendum, so the lesson arrives as part of the skill itself on every future run instead of as a loose fact. Untagged directives are routed automatically when the wording makes the target obvious, and stay role-level otherwise.\n\n` +
        `**Bad** (session log — rejected at capture time):\n\n` +
        `\`\`\`\n## LEARNED\nWhen I worked on the telegram plugin today, commit 9c7682b84 had a race condition in poll-lock at line 42 because writeFileSync wasn't using the 'wx' flag.\n\`\`\`\n\n` +
        `**Good** (directive — persists, then merges into the structured list):\n\n` +
        `\`\`\`\n## LEARNED\nAlways use the 'wx' (exclusive create) flag with writeFileSync when implementing concurrent lock acquisition in \`packages/core/src/.../poll-lock.ts\` — filesystem-level atomicity guarantees only one writer wins.\n\`\`\`\n\n` +
        `Capture only durable, cross-session knowledge — never ephemeral task details.`,
    );
  }

  const knowledge = loadRoleKnowledgeManifest(role, projectRoot);
  if (knowledge) {
    const knowledgeSections: string[] = [];
    if (knowledge.checklist.length > 0) {
      knowledgeSections.push(
        `Verify these before answering:\n${knowledge.checklist.map((item) => `- ${item}`).join('\n')}`,
      );
    }
    const liveQueries = Object.entries(knowledge.liveQueries ?? {});
    if (liveQueries.length > 0) {
      const threshold = Number.isFinite(knowledge.verifyThreshold)
        ? knowledge.verifyThreshold
        : 0.5;
      knowledgeSections.push(
        `When your confidence in any of the following is below ${threshold}, fetch the live value rather than recalling it:\n` +
          liveQueries
            .map(
              ([topic, query]) =>
                `- **${topic}** — ${query.description}: \`${query.registry}\` → field \`${query.key}\``,
            )
            .join('\n'),
      );
    }
    if (knowledgeSections.length > 0) {
      parts.push(`\n\n## Current knowledge requirements\n\n${knowledgeSections.join('\n\n')}`);
    }
  }

  const developedSkills = listProjectSkillAugmentations(role, projectRoot);
  if (developedSkills.length > 0) {
    parts.push(
      `\n\n## Project-developed skills\n\n` +
        `These skills have been extended with practice learned in this project: ` +
        `${developedSkills.map((skill) => `\`${skill}\``).join(', ')}. ` +
        `Their project addendum is attached to the skill body — follow it over the generic method when the two differ.`,
    );
  }

  const additions = parts.slice(1).join('\n\n').trim();
  if (!additions) return cleanBase;
  return `${cleanBase}\n\n${contextStart}\n${additions}\n${contextEnd}`;
}

export { existsSync };
