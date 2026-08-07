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
import { clampSubagentCapabilities } from '../../security/capabilities.js';
import type { SubagentConfig } from '../../types/multi-agent.js';
import { inferRuntimeCapabilities } from './capability-manifest.js';
import { validateProjectAgentConfig } from './project-agent-config-validation.js';
import {
  type ConsolidationMetadata,
  isConsolidated,
  loadConsolidationMetadata,
  loadProjectAgentConsolidated,
} from './project-agent-consolidation.js';
import type {
  LearnedCaptureResult,
  ProjectAgentConfig,
  RoleKnowledgeManifest,
} from './project-agent-identity-types.js';
import { BUILT_IN_KNOWLEDGE_MANIFESTS } from './project-agent-knowledge-manifests.js';
import { splitLearnedEntries, tokenOverlap } from './project-agent-learning-entries.js';
import {
  LEARNED_HARD_LIMIT,
  LEARNED_SOFT_LIMIT,
  normalizeForComparison,
  normalizeLearnedEntry,
} from './project-agent-learning-normalize.js';
import {
  loadProjectAgentLearningPolicy,
  type ProjectAgentLearningPolicy,
} from './project-agent-learning-policy.js';
import {
  mergeStructuredEntries,
  parseStructuredLearnedEntriesFromContent,
  renderLearnedInstructions,
  type StructuredLearnedEntry,
} from './project-agent-learning-structured.js';
import {
  assertProjectAgentRole,
  learningPolicyPath,
  roleDir,
  writeTextAtomically,
} from './project-agent-paths.js';

export { validateProjectAgentConfig } from './project-agent-config-validation.js';
export {
  buildConsolidationInstruction,
  type ConsolidationMetadata,
  clearProjectAgentConsolidated,
  isConsolidated,
  loadConsolidationMetadata,
  loadProjectAgentConsolidated,
  saveProjectAgentConsolidated,
} from './project-agent-consolidation.js';
export type {
  CreateProjectAgentInput,
  LearnedCaptureResult,
  ProjectAgentConfig,
  ProjectAgentProfile,
  RoleKnowledgeManifest,
} from './project-agent-identity-types.js';
export {
  classifyLearnedEntry,
  LEARNED_ENTRY_MAX_CHARS,
  LEARNED_HARD_LIMIT,
  LEARNED_SOFT_LIMIT,
  type LearnedEntryCategory,
  normalizeLearnedEntry,
} from './project-agent-learning-normalize.js';
export {
  loadProjectAgentLearningPolicy,
  type ProjectAgentLearningPolicy,
  updateProjectAgentLearningPolicy,
} from './project-agent-learning-policy.js';
export {
  decomposeLearnedEntry,
  mergeStructuredEntries,
  parseLearnedEntryStamp,
  renderLearnedInstructions,
  type StructuredLearnedEntry,
} from './project-agent-learning-structured.js';
export { assertProjectAgentRole } from './project-agent-paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

import { listProjectAgentRoles } from './project-agent-files.js';
import { loadProjectAgentProfile } from './project-agent-profile.js';

/**
 * Live roster overlay. Project policy is resolved lazily for both built-in and
 * project-created roles, so WebUI changes take effect on the next spawn without
 * rebuilding the Director. Built-in roles keep their safety floors; custom
 * roles may opt into a deliberately narrow runtime.
 */
export function createProjectAgentRoster(
  baseRoster: Record<string, SubagentConfig>,
  projectRoot?: string,
): Record<string, SubagentConfig> {
  const target = { ...baseRoster };
  const resolveRole = (role: string, resolving = new Set<string>()): SubagentConfig | undefined => {
    if (resolving.has(role)) return undefined;
    const isBuiltIn = Object.hasOwn(target, role);
    if (!isBuiltIn && !listProjectAgentRoles(projectRoot).includes(role)) return undefined;
    resolving.add(role);
    const profile = loadProjectAgentProfile(role, projectRoot);
    const template = isBuiltIn
      ? target[role]
      : profile
        ? (resolveRole(profile.baseRole, resolving) ?? target['generic'])
        : target['generic'];
    resolving.delete(role);
    if (!template) return undefined;
    const base = isBuiltIn
      ? template
      : {
          ...template,
          id: role,
          role,
          name: profile?.name ?? role,
          ...(profile
            ? {
                dispatch: {
                  summary: profile.purpose,
                  keywords: [
                    ...profile.taskTypes,
                    ...new Set(
                      `${profile.purpose} ${profile.taskTypes.join(' ')}`
                        .toLowerCase()
                        .split(/[^a-z0-9]+/)
                        .filter((word) => word.length >= 3),
                    ),
                  ],
                },
              }
            : {}),
        };
    return applyProjectAgentConfig(base, loadProjectAgentConfig(role, projectRoot), {
      protectSystemRole: isBuiltIn && !profile,
    });
  };

  return new Proxy(target, {
    get(current, property, receiver) {
      if (typeof property !== 'string') return Reflect.get(current, property, receiver);
      return resolveRole(property) ?? Reflect.get(current, property, receiver);
    },
    has(current, property) {
      return typeof property === 'string'
        ? Reflect.has(current, property) || resolveRole(property) !== undefined
        : Reflect.has(current, property);
    },
    ownKeys(current) {
      return [...new Set([...Reflect.ownKeys(current), ...listProjectAgentRoles(projectRoot)])];
    },
    getOwnPropertyDescriptor(current, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, property);
      if (descriptor || typeof property !== 'string' || !resolveRole(property)) return descriptor;
      return {
        configurable: true,
        enumerable: true,
        writable: false,
        value: resolveRole(property),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Project agent config loading
// ---------------------------------------------------------------------------

/**
 * Load the project-level agent config for a given role.
 * Returns `undefined` when no project override exists.
 */
export function loadProjectAgentConfig(
  role: string,
  projectRoot?: string,
): ProjectAgentConfig | undefined {
  const cfgPath = path.join(roleDir(role, projectRoot), 'config.json');
  try {
    const raw = readFileSync(cfgPath, 'utf8');
    return validateProjectAgentConfig(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

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
 * Load the learning-derived wisdom for a given role.
 * Appended to the subagent prompt as a "knowledge from past sessions" block.
 * The learning file is auto-generated by the `memory-curator` or
 * `self-improving` agent roles and contains de-duplicated, curated findings.
 */
export function loadProjectAgentLearned(role: string, projectRoot?: string): string {
  const learnedPath = path.join(roleDir(role, projectRoot), 'learned.md');
  try {
    return readFileSync(learnedPath, 'utf8').trim();
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
  // First look for project-level knowledge manifest
  const projectPath = path.join(roleDir(role, projectRoot), 'knowledge.json');
  try {
    const raw = readFileSync(projectPath, 'utf8');
    return JSON.parse(raw) as RoleKnowledgeManifest;
  } catch {
    // Fall back to built-in manifests
    return BUILT_IN_KNOWLEDGE_MANIFESTS[role];
  }
}

/**
 * Merge a project agent config onto a base `SubagentConfig`.
 * Returns a new config; does not mutate either input.
 */
export function applyProjectAgentConfig(
  base: SubagentConfig,
  projectConfig: ProjectAgentConfig | undefined,
  options: { protectSystemRole?: boolean | undefined } = {},
): SubagentConfig {
  if (!projectConfig) return base;
  const result: SubagentConfig = { ...base };
  if (projectConfig.tools !== undefined) {
    result.tools = options.protectSystemRole
      ? base.tools === undefined
        ? undefined
        : [...new Set([...base.tools, ...projectConfig.tools])]
      : [...projectConfig.tools];
    result.capabilities = inferRuntimeCapabilities(result.tools ?? []);
  }
  if (projectConfig.skillNames !== undefined) result.skillNames = [...projectConfig.skillNames];
  if (projectConfig.provider !== undefined) result.provider = projectConfig.provider;
  if (projectConfig.model !== undefined) result.model = projectConfig.model;
  if (projectConfig.modelPolicy !== undefined) {
    result.modelPolicy = {
      allowed: projectConfig.modelPolicy.allowed.map((target) => ({ ...target })),
      fallbacks: projectConfig.modelPolicy.fallbacks?.map((target) => ({ ...target })),
      // System roles must remain recoverable even when a preferred model is
      // temporarily unavailable. Custom roles may opt into a hard boundary.
      strict: options.protectSystemRole ? false : (projectConfig.modelPolicy.strict ?? false),
    };
    result.fallbackModels = (projectConfig.modelPolicy.fallbacks ?? []).map(
      (target) => `${target.provider}/${target.model}`,
    );
  } else if (projectConfig.fallbackProfile !== undefined) {
    result.fallbackProfile = projectConfig.fallbackProfile;
  }
  if (projectConfig.cwd !== undefined) result.cwd = projectConfig.cwd;
  if (projectConfig.worktree !== undefined) {
    result.worktree =
      options.protectSystemRole &&
      (projectConfig.worktree === true || projectConfig.worktree === 'required')
        ? 'auto'
        : projectConfig.worktree;
  }
  if (projectConfig.availability !== undefined) {
    result.availability = {
      ...projectConfig.availability,
      days: [...projectConfig.availability.days],
      mode: options.protectSystemRole ? 'advisory' : (projectConfig.availability.mode ?? 'enforce'),
    };
  }
  if (projectConfig.allowedCapabilities !== undefined) {
    // `projectConfig` is a repo-committed file — untrusted by the same standard
    // as `.wrongstack/config.json`, which in-project-policy already strips. It
    // may NARROW a grant but never widen one, so everything sourced from it is
    // clamped to the wide-subagent ceiling. Without this, a cloned repo could
    // hand its subagents fs.write.outside-project / tool.mutate.any /
    // config.mutate — the exact set WIDE_SUBAGENT_CAPABILITIES withholds.
    //
    // Note `protectSystemRole` UNIONS rather than restricts here; it protects
    // the role's identity, not its blast radius, so it is not a substitute
    // for this clamp (WS-079).
    const merged = options.protectSystemRole
      ? base.allowedCapabilities === undefined
        ? undefined
        : [...new Set([...base.allowedCapabilities, ...projectConfig.allowedCapabilities])]
      : [...projectConfig.allowedCapabilities];
    result.allowedCapabilities =
      merged === undefined ? undefined : clampSubagentCapabilities(merged).granted;
  }
  if (projectConfig.budget) {
    if (projectConfig.budget.timeoutMs !== undefined)
      result.timeoutMs = projectConfig.budget.timeoutMs;
    if (projectConfig.budget.idleTimeoutMs !== undefined)
      result.idleTimeoutMs = projectConfig.budget.idleTimeoutMs;
    if (projectConfig.budget.maxIterations !== undefined)
      result.maxIterations = projectConfig.budget.maxIterations;
    if (projectConfig.budget.maxToolCalls !== undefined)
      result.maxToolCalls = projectConfig.budget.maxToolCalls;
    if (projectConfig.budget.maxTokens !== undefined)
      result.maxTokens = projectConfig.budget.maxTokens;
    if (projectConfig.budget.maxCostUsd !== undefined)
      result.maxCostUsd = projectConfig.budget.maxCostUsd;
  }
  if (options.protectSystemRole) applySystemAgentBudgetFloors(result);
  return result;
}

const SYSTEM_AGENT_BUDGET_FLOORS = {
  timeoutMs: 300_000,
  idleTimeoutMs: 120_000,
  maxIterations: 20,
  maxToolCalls: 40,
  maxTokens: 8_192,
  maxCostUsd: 0.25,
} as const satisfies Partial<Record<keyof SubagentConfig, number>>;

type BudgetFloorEntry = {
  [K in keyof typeof SYSTEM_AGENT_BUDGET_FLOORS]: [K, (typeof SYSTEM_AGENT_BUDGET_FLOORS)[K]];
}[keyof typeof SYSTEM_AGENT_BUDGET_FLOORS];

function applySystemAgentBudgetFloors(config: SubagentConfig): void {
  for (const [field, floor] of Object.entries(SYSTEM_AGENT_BUDGET_FLOORS) as BudgetFloorEntry[]) {
    const value = config[field];
    if (typeof value === 'number' && value < floor) config[field] = floor;
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

  // Skip project identity when WRONGSTACK_AGENT_INSTRUCTIONS_DIR is set
  // (this is a test/override context — keep byte-exact equality with on-disk files).
  // The marker cleanup below is intentionally placed AFTER this early return so a
  // prompt that already contains legacy context markers is preserved verbatim.
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
  // Prefer the reviewed, consolidated document over the raw learned.md buffer.
  // The consolidated version is a synthesized, narrowly-scoped representation
  // of everything the agent has learned — same information, less context volume.
  //
  // STALENESS GATE: When new raw entries have been captured since the last
  // consolidation (entry count > sourceEntryCount), the consolidation is stale.
  // In that case we append the delta entries so the agent still sees new
  // learnings — preserving the capture→inject feedback loop without losing
  // the optimization benefit of the consolidated document.
  let learnedContent = '';
  let learnedLabel = '';
  if (learningPolicy.enabled) {
    const consolidated = loadProjectAgentConsolidated(role, projectRoot);
    if (consolidated) {
      const meta = loadConsolidationMetadata(role, projectRoot);
      // Read the raw buffer once; split it for entry counting.
      const rawLearned = loadProjectAgentLearned(role, projectRoot);
      const rawEntries = splitLearnedEntries(rawLearned);
      const rawBytes = Buffer.byteLength(rawLearned, 'utf8');
      // Freshness gate: consolidated.md is preferred, but only while the
      // raw buffer hasn't grown past the snapshot at consolidation time.
      // We check both entry count and byte size — either exceeding the
      // recorded snapshot means the consolidated document is stale. When
      // metadata is missing entirely we cannot verify freshness, so treat
      // it as stale to avoid orphaning new captures.
      const stale =
        meta === undefined ||
        rawEntries.length > meta.sourceEntryCount ||
        rawBytes > meta.sourceBytes;
      if (stale) {
        if (meta !== undefined && meta.sourceEntryCount < rawEntries.length) {
          // New countable entries arrived since consolidation — append just
          // the delta to preserve the context optimization while surfacing
          // freshly captured knowledge (capture→inject loop).
          const deltaEntries = rawEntries.slice(meta.sourceEntryCount);
          learnedContent = `${consolidated}\n\n---\n\n## Recently captured (pending next optimization)\n\n${deltaEntries.join('\n\n---\n\n')}`;
        } else {
          // Metadata missing, or raw grew without new countable entries —
          // cannot compute a precise delta, so serve the full raw buffer.
          learnedContent = rawLearned;
        }
      } else {
        learnedContent = consolidated;
      }
      learnedLabel = 'Consolidated knowledge for this project';
    } else {
      learnedContent = loadProjectAgentLearned(role, projectRoot);
      learnedLabel = 'Learned instructions for this project (structured: what / why / how)';
    }
  }
  if (learnedContent) {
    // Only include content that has meaningful text (strip HTML comments)
    const meaningful = learnedContent.replace(/<!--[\s\S]*?-->/g, '').trim();
    if (meaningful.length > 0) {
      parts.push(`\n\n# ${learnedLabel}\n\n${learnedContent}`);
    }
  }

  // ── Capture mechanism: tell every agent HOW to persist new knowledge ──
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
        `**Bad** (session log — rejected at capture time):\n\n` +
        `\`\`\`\n## LEARNED\nWhen I worked on the telegram plugin today, commit 9c7682b84 had a race condition in poll-lock at line 42 because writeFileSync wasn't using the 'wx' flag.\n\`\`\`\n\n` +
        `**Good** (directive — persists, then merges into the structured list):\n\n` +
        `\`\`\`\n## LEARNED\nAlways use the 'wx' (exclusive create) flag with writeFileSync when implementing concurrent lock acquisition in \`packages/core/src/.../poll-lock.ts\` — filesystem-level atomicity guarantees only one writer wins.\n\`\`\`\n\n` +
        `Capture only durable, cross-session knowledge — never ephemeral task details.`,
    );
  }

  const knowledge = loadRoleKnowledgeManifest(role, projectRoot);
  if (knowledge && knowledge.checklist.length > 0) {
    const checklist = knowledge.checklist.map((item) => `- ${item}`).join('\n');
    parts.push(
      `\n\n## Current knowledge requirements\n\nVerify these before answering:\n${checklist}`,
    );
  }

  const additions = parts.slice(1).join('\n\n').trim();
  if (!additions) return cleanBase;
  return `${cleanBase}\n\n${contextStart}\n${additions}\n${contextEnd}`;
}

// ---------------------------------------------------------------------------
// Learned-wisdom capture from agent output
// ---------------------------------------------------------------------------

// ─── learned.md automation contract ────────────────────────────────────────
//
//  TRIGGER  Primary: end of a delegated subagent task (CLI fleet host's
//           task.completed handler). The director's task resolution checks the
//           final output text for ## LEARNED blocks and captures durable entries.
//           Secondary: leader's own output after a user-invoked improvement
//           prompt ("improve the executor agent"). Never on intermediate tool
//           calls or every iteration — only once per task resolution.
//           Manual: `/agent-improve <role> capture` at any time.
//
//  GUARDRAILS
//
//  1. COOLDOWN  Per-role: minimum 120 seconds between captures. Tracks the
//     last capture timestamp in a module-level Map.  A capture within the
//     cooldown window is silently skipped (counter not bumped).
//
//  2. FREQUENCY CAP  Per-session: at most 3 captures per role before the
//     capture falls through to `/agent-improve` (human-gated). The session
//     is reset on process restart (module reload).
//
//  3. HUMAN-APPROVAL THRESHOLD  When `learned.md` exceeds `LEARNED_SOFT_LIMIT`
//     (8 KB) the next capture is deferred — the agent is asked to run
//     `/agent-improve <role> refresh` or the user must call it explicitly.
//     The hintLearnedNeedsSummarization() check is exposed so the CLI can
//     surface this in /agent-improve output.
//
//  4. SIZE  SOFT_LIMIT = 8 192 B → hintLearnedNeedsSummarization() returns true.
//           HARD_LIMIT = 16 384 B → capture halves the structured entry list
//           (oldest first) and re-renders before writing.
//
//  5. CONTENT QUALITY  A block is run through `normalizeLearnedEntry` and
//     skipped when it cannot be converted into an instructive directive:
//     - too short after stripping ephemeral artifacts (< 30 chars)
//     - all narrative framing with no salvageable directive tail
//     - overwhelmingly narrative (>50% sentences are event descriptions)
//     - longer than LEARNED_ENTRY_MAX_CHARS (600 chars) — truncated to the
//       first instructive sentence cluster that fits
//     Ephemeral artifacts stripped BEFORE the length check:
//     - git commit SHAs, ISO timestamps, specific line numbers, PR/issue refs
//     Code-only blocks (>70% fenced-code lines) and near-duplicates
//     (Jaccard ≥ 0.55) are still rejected. Surviving entries are stamped
//     with a category tag (convention / pattern / warning / fact).
//
//  OWNER  logic : packages/core/src/coordination/agents/project-agent-identity.ts
//         hook  : packages/cli/src/fleet/host.ts
// ---------------------------------------------------------------------------

// ─── Automation guardrails ───────────────────────────────────────────────────

const captureCooldowns = new Map<string, number>(); // role → timestamp
const captureFrequency = new Map<string, number>(); // role → count

export const CAPTURE_COOLDOWN_MS = 120_000; // 2 minutes
export const CAPTURE_MAX_PER_SESSION = 3;

/**
 * Check whether a new capture is allowed for this role. Returns a rejection
 * reason string when blocked, or undefined when capture may proceed.
 */
export function canCaptureNewLearned(
  role: string,
  existingSize: number,
  isManual: boolean,
  projectRoot?: string,
): string | undefined {
  const key = `${path.resolve(projectRoot ?? process.cwd())}\0${assertProjectAgentRole(role)}`;
  // Cooldown gate (bypassed for manual captures)
  if (!isManual) {
    const last = captureCooldowns.get(key);
    if (last && Date.now() - last < CAPTURE_COOLDOWN_MS) {
      return `Cooldown active for role "${role}" (${Math.ceil((CAPTURE_COOLDOWN_MS - (Date.now() - last)) / 1000)}s remaining)`;
    }
  }

  // Frequency cap (bypassed for manual captures)
  if (!isManual) {
    const count = captureFrequency.get(key) ?? 0;
    if (count >= CAPTURE_MAX_PER_SESSION) {
      return `Frequency cap reached for role "${role}" (${count}/${CAPTURE_MAX_PER_SESSION}). Use /agent-improve ${role} capture for manual override.`;
    }
  }

  // Size gate: when over SOFT_LIMIT, require manual approval
  if (existingSize > LEARNED_SOFT_LIMIT && !isManual) {
    return `learned.md for role "${role}" exceeds soft limit (${existingSize}B / ${LEARNED_SOFT_LIMIT}B). Run /agent-improve ${role} capture manually or /agent-improve ${role} refresh to reset.`;
  }

  return undefined;
}

/**
 * Per-role learning stats for monitoring UIs.
 */
export interface ProjectAgentLearnStats {
  role: string;
  exists: boolean;
  entryCount: number;
  totalBytes: number;
  lastCapture: string | null;
  lastCaptureTimestamp: number | null;
  cooldownRemainingMs: number;
  sessionCaptureCount: number;
  needsSummarization: boolean;
  learnedPath: string | null;
  identityPath: string | null;
  hasIdentity: boolean;
  hasConfig: boolean;
  hasKnowledge: boolean;
  learningEnabled: boolean;
  lifetimeCaptureCount: number;
  lastCaptureSource: ProjectAgentLearningPolicy['lastCaptureSource'] | null;
  /** Whether a consolidated document exists for this role. */
  isConsolidated: boolean;
  /** Consolidation metadata, if a consolidation has been performed. */
  consolidation?: ConsolidationMetadata | undefined;
}

export function getProjectAgentLearnStats(
  role: string,
  projectRoot?: string,
): ProjectAgentLearnStats {
  const dir = roleDir(role, projectRoot);
  const learnedPath_ = path.join(dir, 'learned.md');
  const identityPath_ = path.join(dir, 'identity.md');
  const configPath_ = path.join(dir, 'config.json');
  const knowledgePath_ = path.join(dir, 'knowledge.json');
  let learnedText = '';
  try {
    learnedText = readFileSync(learnedPath_, 'utf8');
  } catch {
    /* no file */
  }
  // Use the structured parser so entryCount reflects directive entries, not
  // raw chunks split by `---` (the structured document also uses `---` for
  // section dividers and the footer, which would inflate chunk counts).
  const entries = parseStructuredLearnedEntries(role, projectRoot);
  const exists = existsSync(dir);
  const policy = loadProjectAgentLearningPolicy(role, projectRoot);
  const captureKey = `${path.resolve(projectRoot ?? process.cwd())}\0${assertProjectAgentRole(role)}`;
  const runtimeLastTs = captureCooldowns.get(captureKey) ?? null;
  const persistedLastTs = policy.lastCaptureAt ? Date.parse(policy.lastCaptureAt) : Number.NaN;
  const lastTs = runtimeLastTs ?? (Number.isFinite(persistedLastTs) ? persistedLastTs : null);
  const cooldownRemaining = lastTs ? Math.max(0, CAPTURE_COOLDOWN_MS - (Date.now() - lastTs)) : 0;
  const freq = captureFrequency.get(captureKey) ?? 0;

  return {
    role,
    exists,
    entryCount: entries.length,
    totalBytes: Buffer.byteLength(learnedText, 'utf8'),
    lastCapture: lastTs ? new Date(lastTs).toISOString() : null,
    lastCaptureTimestamp: lastTs,
    cooldownRemainingMs: cooldownRemaining,
    sessionCaptureCount: freq,
    needsSummarization: exists
      ? hintLearnedNeedsSummarization(role, projectRoot).length > 0
      : false,
    learnedPath: existsSync(learnedPath_) ? learnedPath_ : null,
    identityPath: existsSync(identityPath_) ? identityPath_ : null,
    hasIdentity: existsSync(identityPath_),
    hasConfig: existsSync(configPath_),
    hasKnowledge: existsSync(knowledgePath_),
    learningEnabled: policy.enabled,
    lifetimeCaptureCount: policy.lifetimeCaptureCount,
    lastCaptureSource: policy.lastCaptureSource ?? null,
    isConsolidated: isConsolidated(role, projectRoot),
    consolidation: loadConsolidationMetadata(role, projectRoot),
  };
}

/**
 * Re-export existsSync so callers can check file existence without importing fs.
 */
export { existsSync };

/**
 * Detect semantic conflicts between different roles' learned wisdom.
 * Returns entries where token overlap ≥ 0.60, which suggests the two
 * roles have learned about the same topic — potentially contradicting.
 */
export function detectLearnedConflicts(projectRoot?: string): Array<{
  roleA: string;
  roleB: string;
  snippetA: string;
  snippetB: string;
  similarity: number;
  detectedAt: string;
}> {
  const roles = listProjectAgentRoles(projectRoot);
  const entries: { role: string; normalized: string; raw: string }[] = [];
  for (const role of roles) {
    const text = loadProjectAgentLearned(role, projectRoot);
    if (!text || text.trim().length < 50) continue;
    entries.push({ role, normalized: normalizeForComparison(text), raw: text });
  }
  const conflicts: Array<{
    roleA: string;
    roleB: string;
    snippetA: string;
    snippetB: string;
    similarity: number;
    detectedAt: string;
  }> = [];
  for (const [i, a] of entries.entries()) {
    for (const b of entries.slice(i + 1)) {
      const sim = tokenOverlap(a.normalized, b.normalized);
      if (sim >= 0.6) {
        conflicts.push({
          roleA: a.role,
          roleB: b.role,
          snippetA: a.raw.slice(0, 200),
          snippetB: b.raw.slice(0, 200),
          similarity: sim,
          detectedAt: new Date().toISOString(),
        });
      }
    }
  }
  return conflicts.sort((a, b) => b.similarity - a.similarity);
}

export function listProjectAgentLearnedEntries(role: string, projectRoot?: string): string[] {
  return splitLearnedEntries(loadProjectAgentLearned(role, projectRoot));
}

// ---------------------------------------------------------------------------
// Structured instruction list
//
// Each `learned.md` capture now produces a structured instruction list rather
// than an append-only journal. Every entry is decomposed into a "what / why /
// how" shape so a future agent invocation can read the buffer and immediately
// understand the rule, the reason behind it, and the concrete steps to apply
// it. The buffer is rewritten in this structured form on every capture, with
// historical entries re-decomposed in lockstep so the file stays
// self-describing and scannable across the lifetime of the role.
// ---------------------------------------------------------------------------

export function parseStructuredLearnedEntries(
  role: string,
  projectRoot?: string,
): StructuredLearnedEntry[] {
  const raw = loadProjectAgentLearned(role, projectRoot);
  return parseStructuredLearnedEntriesFromContent(
    raw,
    listProjectAgentLearnedEntries(role, projectRoot),
  );
}

/**
 * Learned-wisdom capture from agent output.
 *
 * Scans `output` for `## LEARNED` blocks and persists each unique,
 * quality-passing block to the role's `learned.md`.  Each block is run
 * through `normalizeLearnedEntry` so the buffer only accumulates instructive
 * directives — narrative session logs are rejected at capture time. Near-
 * duplicate entries (token overlap ≥ 0.55) are silently skipped.
 *
 * When the resulting file would exceed `LEARNED_HARD_LIMIT` (16 KB)
 * the oldest entries are rotated out before writing.
 *
 * @returns the number of **new** items actually persisted (0 if none).
 */
export function captureLearnedFromAgentOutput(
  output: string,
  role: string,
  projectRoot?: string,
  isManual = false,
): number {
  return captureLearnedFromAgentOutputDetailed(output, role, projectRoot, isManual).captured;
}

export function captureLearnedFromAgentOutputDetailed(
  output: string,
  role: string,
  projectRoot?: string,
  isManual = false,
): LearnedCaptureResult {
  const normalizedRole = assertProjectAgentRole(role);
  if (!output.trim()) {
    return { role: normalizedRole, captured: 0, skipped: 0, status: 'empty_output' };
  }
  const policy = loadProjectAgentLearningPolicy(normalizedRole, projectRoot);
  if (!policy.enabled && !isManual) {
    return {
      role: normalizedRole,
      captured: 0,
      skipped: 0,
      status: 'disabled',
      reason: 'Automatic learning is disabled for this role.',
    };
  }

  const regex = /^##\s*LEARNED\s*$/gim;
  const candidates: string[] = [];
  let startMatch = regex.exec(output);
  while (startMatch !== null) {
    const blockStart = startMatch.index + startMatch[0].length;
    const rest = output.slice(blockStart);
    const nextHeading = /^##\s/gm.exec(rest);
    const blockEnd = nextHeading ? blockStart + nextHeading.index : output.length;
    candidates.push(output.slice(blockStart, blockEnd).trim());
    regex.lastIndex = Math.max(regex.lastIndex, blockEnd);
    startMatch = regex.exec(output);
  }
  if (candidates.length === 0) {
    return { role: normalizedRole, captured: 0, skipped: 0, status: 'no_blocks' };
  }

  const existingRaw = loadProjectAgentLearned(normalizedRole, projectRoot);
  const guard = canCaptureNewLearned(
    normalizedRole,
    Buffer.byteLength(existingRaw, 'utf8'),
    isManual,
    projectRoot,
  );
  if (guard) {
    return {
      role: normalizedRole,
      captured: 0,
      skipped: candidates.length,
      status: 'guarded',
      reason: guard,
    };
  }

  // Dedup against existing structured entries' directive keys so the
  // capture loop can reject near-duplicates using the same normalization
  // the structured renderer applies. This replaces the old chunked-text
  // dedup path which could not see through the structured document format.
  const normalizedEntries = parseStructuredLearnedEntries(normalizedRole, projectRoot).map(
    (entry) => entry.key,
  );
  let structuredEntries = parseStructuredLearnedEntries(normalizedRole, projectRoot);
  let captured = 0;
  let skipped = 0;
  const now = new Date();
  const nowIso = now.toISOString();
  const remainingSessionCaptures = isManual
    ? Number.POSITIVE_INFINITY
    : Math.max(
        0,
        CAPTURE_MAX_PER_SESSION -
          (captureFrequency.get(
            `${path.resolve(projectRoot ?? process.cwd())}\0${normalizedRole}`,
          ) ?? 0),
      );

  for (const content of candidates) {
    if (captured >= remainingSessionCaptures) {
      skipped++;
      continue;
    }
    // Run normalization FIRST: strip ephemeral artifacts, drop narrative
    // framing, classify, and reject entries that cannot be salvaged into
    // instructive directives. This is the quality gate that keeps the
    // buffer from accumulating session logs.
    const normalized = normalizeLearnedEntry(content);
    if (!normalized) {
      skipped++;
      continue;
    }
    // Code-only check: rejects entries that are mostly fenced code even after
    // normalization (the normalizer preserves prose, so a code-only block
    // will already be short on text — this is a belt-and-braces check).
    const totalLines = Math.max(1, content.split('\n').length);
    const codeBodyLines = (content.match(/```[\s\S]*?```/g) ?? []).reduce(
      (sum, block) => sum + Math.max(0, block.split('\n').length - 2),
      0,
    );
    if (totalLines > 5 && codeBodyLines / totalLines > 0.7) {
      skipped++;
      continue;
    }
    const candidateNorm = normalizeForComparison(normalized.text);
    if (normalizedEntries.some((entry) => tokenOverlap(candidateNorm, entry) >= 0.55)) {
      skipped++;
      continue;
    }
    normalizedEntries.push(candidateNorm);
    // Merge the new directive into the structured list, deduplicating against
    // existing entries by content similarity. The buffer is rewritten as a
    // structured instruction list (what / why / how) at the end of this
    // function — historical entries are re-decomposed in lockstep so the
    // file is always a current, consistent snapshot.
    structuredEntries = mergeStructuredEntries(structuredEntries, {
      text: normalized.text,
      category: normalized.category,
      capturedAt: nowIso,
    });
    captured++;
  }

  if (captured === 0) {
    return {
      role: normalizedRole,
      captured: 0,
      skipped,
      status: 'quality_rejected',
      reason:
        'Every LEARNED block was too short, too narrative, or a near-duplicate. Write directives, not session logs.',
    };
  }

  // Render the merged list as a structured instruction document. This is the
  // single source of truth — the buffer is rewritten in full on every
  // capture so the file always reflects the current, merged state.
  let newContent = renderLearnedInstructions(normalizedRole, structuredEntries, nowIso);
  if (Buffer.byteLength(newContent, 'utf8') >= LEARNED_HARD_LIMIT) {
    // Trim oldest entries when the document exceeds the hard limit. Keep
    // the structured form intact by re-rendering after pruning.
    const trimmed = structuredEntries.slice(-Math.max(1, Math.floor(structuredEntries.length / 2)));
    newContent = renderLearnedInstructions(normalizedRole, trimmed, nowIso);
  }

  writeTextAtomically(path.join(roleDir(normalizedRole, projectRoot), 'learned.md'), newContent);
  const captureKey = `${path.resolve(projectRoot ?? process.cwd())}\0${normalizedRole}`;
  captureCooldowns.set(captureKey, now.getTime());
  // Increment the frequency counter by 1 per capture attempt (not by
  // `captured`, the number of LEARNED blocks appended). Otherwise a single
  // response that yields N blocks immediately exhausts the
  // CAPTURE_MAX_PER_SESSION budget for the rest of the session, while a
  // response that yields 0 blocks consumes nothing — both diverge from the
  // documented "attempts per session" semantics the cap is meant to enforce.
  captureFrequency.set(captureKey, (captureFrequency.get(captureKey) ?? 0) + 1);
  const nextPolicy: ProjectAgentLearningPolicy = {
    ...policy,
    lifetimeCaptureCount: policy.lifetimeCaptureCount + captured,
    lastCaptureAt: now.toISOString(),
    lastCaptureSource: isManual ? 'manual' : 'automatic',
  };
  writeTextAtomically(
    learningPolicyPath(normalizedRole, projectRoot),
    `${JSON.stringify(nextPolicy, null, 2)}\n`,
  );
  return { role: normalizedRole, captured, skipped, status: 'captured' };
}

/**
 * Signal the host that a background summarisation pass is warranted.
 * Called by `captureLearnedFromAgentOutput` when the **new** learned size
 * crosses `LEARNED_SOFT_LIMIT`.  The host is responsible for scheduling a
 * low-priority consolidation task (typically via the Brain or a shadow agent).
 *
 * The summary _mechanism_ is intentionally shallow here — the real
 * summarisation is an LLM call that should run as a deferred, uncritical
 * fleet task so it never blocks a user-facing operation.
 *
 * @returns a summary brief for the host, or '' when no action is needed.
 */
export function hintLearnedNeedsSummarization(role: string, projectRoot?: string): string {
  const learned = loadProjectAgentLearned(role, projectRoot);
  if (!learned) return '';
  const bytes = Buffer.byteLength(learned, 'utf8');
  if (bytes < LEARNED_SOFT_LIMIT) return '';
  return `Learned wisdom for role "${role}" is ${bytes} B (soft limit ${LEARNED_SOFT_LIMIT}). Schedule a low-priority consolidation pass.`;
}

// ---------------------------------------------------------------------------
// Consolidation: review raw learned.md → produce consolidated.md
// ---------------------------------------------------------------------------
//
// The learned.md file is an append-only capture buffer. Over time it grows
// with verbose, overlapping entries. The consolidation pass reads every raw
// entry, asks an LLM to synthesize them into a single narrowly-scoped
// document that represents what the agent has learned for its role, and
// writes the result to consolidated.md.
//
// Once consolidated.md exists, buildProjectContextualizedPrompt prefers it
// over the raw learned.md — the raw buffer is retained on disk for audit
// but no longer injected into prompts (reducing context volume without
// omitting information, because every fact was carried into the summary).
//
// Files (under .wrongstack/agents/<role>/):
//   consolidated.md   — the synthesized, reviewed document
//   consolidation.json — metadata tracking the last review
