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

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import type { SubagentConfig } from '../../types/multi-agent.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectAgentConfig {
  /**
   * Static tool allowlist override. When set, replaces the catalog tools
   * entirely (not merged). Omit to keep catalog defaults.
   */
  tools?: string[] | undefined;
  /** Static skill name override. Replaces catalog skillNames entirely. */
  skillNames?: string[] | undefined;
  /**
   * Budget overrides. Each field individually overrides the catalog budget.
   */
  budget?:
    | {
        timeoutMs?: number | undefined;
        idleTimeoutMs?: number | undefined;
        maxIterations?: number | undefined;
        maxToolCalls?: number | undefined;
        maxTokens?: number | undefined;
        maxCostUsd?: number | undefined;
      }
    | undefined;
  /** Provider/model override for this role within the project. */
  provider?: string | undefined;
  model?: string | undefined;
  modelPolicy?:
    | {
        allowed: Array<{ provider: string; model: string }>;
        fallbacks?: Array<{ provider: string; model: string }> | undefined;
        strict?: boolean | undefined;
      }
    | undefined;
  fallbackProfile?: string | undefined;
  /** Project-relative directory, resolved inside the assigned checkout/worktree. */
  cwd?: string | undefined;
  worktree?: boolean | 'auto' | 'required' | 'off' | undefined;
  availability?:
    | {
        timezone: string;
        days: number[];
        start: string;
        end: string;
        mode?: 'advisory' | 'enforce' | undefined;
      }
    | undefined;
  /**
   * Allowed capability overrides. Replaces catalog capabilities entirely.
   */
  allowedCapabilities?: readonly string[] | undefined;
}

/** Durable definition for a project-created roster role. */
export interface ProjectAgentProfile {
  role: string;
  name: string;
  baseRole: string;
  purpose: string;
  taskTypes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectAgentInput {
  role?: string | undefined;
  name: string;
  purpose: string;
  taskTypes: string[];
  baseRole?: string | undefined;
}

const PROJECT_AGENT_CONFIG_KEYS = new Set([
  'tools',
  'skillNames',
  'budget',
  'provider',
  'model',
  'allowedCapabilities',
  'modelPolicy',
  'fallbackProfile',
  'cwd',
  'worktree',
  'availability',
]);

const PROJECT_AGENT_BUDGET_KEYS = new Set([
  'timeoutMs',
  'idleTimeoutMs',
  'maxIterations',
  'maxToolCalls',
  'maxTokens',
  'maxCostUsd',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertStringList(value: unknown, field: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)
  ) {
    throw new Error(`Project agent config "${field}" must be an array of non-empty strings.`);
  }
}

/** Validate untrusted JSON before it can alter a roster agent runtime. */
export function validateProjectAgentConfig(value: unknown): ProjectAgentConfig {
  if (!isPlainRecord(value)) throw new Error('Project agent config must be an object.');

  const unknownKey = Object.keys(value).find((key) => !PROJECT_AGENT_CONFIG_KEYS.has(key));
  if (unknownKey) throw new Error(`Unknown project agent config field: "${unknownKey}".`);

  if (value.tools !== undefined) assertStringList(value.tools, 'tools');
  if (value.skillNames !== undefined) assertStringList(value.skillNames, 'skillNames');
  if (value.allowedCapabilities !== undefined) {
    assertStringList(value.allowedCapabilities, 'allowedCapabilities');
  }
  for (const field of ['provider', 'model', 'fallbackProfile'] as const) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && (typeof fieldValue !== 'string' || !fieldValue.trim())) {
      throw new Error(`Project agent config "${field}" must be a non-empty string.`);
    }
  }

  if (value.cwd !== undefined) {
    if (typeof value.cwd !== 'string' || !value.cwd.trim()) {
      throw new Error('Project agent config "cwd" must be a non-empty relative path.');
    }
    const cwd = value.cwd.replace(/\\/g, '/').trim();
    if (path.posix.isAbsolute(cwd) || /^[a-z]:\//i.test(cwd) || cwd.split('/').includes('..')) {
      throw new Error('Project agent config "cwd" must stay inside the assigned checkout.');
    }
  }
  if (
    value.worktree !== undefined &&
    value.worktree !== true &&
    value.worktree !== false &&
    value.worktree !== 'auto' &&
    value.worktree !== 'required' &&
    value.worktree !== 'off'
  ) {
    throw new Error('Project agent config "worktree" must be auto, required, off, or boolean.');
  }

  if (value.modelPolicy !== undefined) validateProjectAgentModelPolicy(value.modelPolicy);
  if (value.availability !== undefined) validateProjectAgentAvailability(value.availability);

  if (value.budget !== undefined) {
    if (!isPlainRecord(value.budget)) {
      throw new Error('Project agent config "budget" must be an object.');
    }
    const unknownBudgetKey = Object.keys(value.budget).find(
      (key) => !PROJECT_AGENT_BUDGET_KEYS.has(key),
    );
    if (unknownBudgetKey) {
      throw new Error(`Unknown project agent budget field: "${unknownBudgetKey}".`);
    }
    for (const [field, amount] of Object.entries(value.budget)) {
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
        throw new Error(`Project agent budget "${field}" must be a finite non-negative number.`);
      }
      if (field !== 'maxCostUsd' && !Number.isInteger(amount)) {
        throw new Error(`Project agent budget "${field}" must be an integer.`);
      }
    }
  }

  return value as ProjectAgentConfig;
}

function validateProjectAgentModelPolicy(value: unknown): void {
  if (!isPlainRecord(value)) throw new Error('Project agent modelPolicy must be an object.');
  const allowedKeys = new Set(['allowed', 'fallbacks', 'strict']);
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey) throw new Error(`Unknown modelPolicy field: "${unknownKey}".`);

  const validateTargets = (targets: unknown, field: string, allowEmpty: boolean) => {
    if (!Array.isArray(targets) || (!allowEmpty && targets.length === 0)) {
      throw new Error(`Project agent modelPolicy "${field}" must be a non-empty array.`);
    }
    for (const target of targets) {
      if (
        !isPlainRecord(target) ||
        typeof target.provider !== 'string' ||
        !target.provider.trim() ||
        typeof target.model !== 'string' ||
        !target.model.trim()
      ) {
        throw new Error(`Project agent modelPolicy "${field}" contains an invalid target.`);
      }
    }
  };
  validateTargets(value.allowed, 'allowed', false);
  if (value.fallbacks !== undefined) {
    validateTargets(value.fallbacks, 'fallbacks', true);
    const allowed = new Set(
      (value.allowed as Array<{ provider: string; model: string }>).map(
        (target) => `${target.provider}\0${target.model}`,
      ),
    );
    for (const target of value.fallbacks as Array<{ provider: string; model: string }>) {
      if (!allowed.has(`${target.provider}\0${target.model}`)) {
        throw new Error('Every modelPolicy fallback must also appear in allowed.');
      }
    }
  }
  if (value.strict !== undefined && typeof value.strict !== 'boolean') {
    throw new Error('Project agent modelPolicy "strict" must be boolean.');
  }
}

function validateProjectAgentAvailability(value: unknown): void {
  if (!isPlainRecord(value)) throw new Error('Project agent availability must be an object.');
  const allowedKeys = new Set(['timezone', 'days', 'start', 'end', 'mode']);
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey) throw new Error(`Unknown availability field: "${unknownKey}".`);
  if (typeof value.timezone !== 'string' || !value.timezone.trim()) {
    throw new Error('Project agent availability requires a timezone.');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.timezone }).format();
  } catch {
    throw new Error(`Invalid project agent availability timezone: "${value.timezone}".`);
  }
  if (
    !Array.isArray(value.days) ||
    value.days.length === 0 ||
    value.days.some((day) => !Number.isInteger(day) || (day as number) < 0 || (day as number) > 6)
  ) {
    throw new Error('Project agent availability days must contain weekday numbers 0-6.');
  }
  if (
    typeof value.start !== 'string' ||
    typeof value.end !== 'string' ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.start) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.end)
  ) {
    throw new Error('Project agent availability start/end must use HH:MM.');
  }
  if (value.mode !== undefined && value.mode !== 'advisory' && value.mode !== 'enforce') {
    throw new Error('Project agent availability mode must be advisory or enforce.');
  }
}

/** Persistent controls and counters for one roster role's learning loop. */
export interface ProjectAgentLearningPolicy {
  /** Retain knowledge but stop prompt injection and automatic capture when false. */
  enabled: boolean;
  lifetimeCaptureCount: number;
  lastCaptureAt?: string | undefined;
  lastCaptureSource?: 'automatic' | 'manual' | 'taught' | undefined;
}

export interface LearnedCaptureResult {
  role: string;
  captured: number;
  skipped: number;
  status: 'captured' | 'disabled' | 'empty_output' | 'no_blocks' | 'guarded' | 'quality_rejected';
  reason?: string | undefined;
}

const DEFAULT_LEARNING_POLICY: ProjectAgentLearningPolicy = {
  enabled: true,
  lifetimeCaptureCount: 0,
};

const AGENT_ROLE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/i;

export function assertProjectAgentRole(role: string): string {
  const normalized = role.trim();
  if (
    !AGENT_ROLE_PATTERN.test(normalized) ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.includes('/') ||
    normalized.includes('\\')
  ) {
    throw new Error(`Invalid project agent role: "${role}".`);
  }
  return normalized;
}

/**
 * Current-knowledge manifest for a role: what live facts the agent should
 * fetch on every spawn to avoid hallucinating stale versions.
 */
export interface RoleKnowledgeManifest {
  role: string;
  /** Registry endpoints to query at spawn time, keyed by topic. */
  liveQueries: Record<string, { registry: string; key: string; description: string }>;
  /**
   * Human-readable checklist: "before answering questions about X, verify Y
   * from the live registry". Injected verbatim into the subagent prompt.
   */
  checklist: string[];
  /**
   * Minimum confidence threshold before the role should re-verify a live
   * source rather than relying on its own training data (0.0–1.0). Default 0.5.
   */
  verifyThreshold: number;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function agentsDir(projectRoot?: string): string {
  const root = projectRoot ?? process.cwd();
  return path.join(root, '.wrongstack', 'agents');
}

function roleDir(role: string, projectRoot?: string): string {
  return path.join(agentsDir(projectRoot), assertProjectAgentRole(role));
}

function writeTextAtomically(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, 'utf8');
    renameSync(temporaryPath, filePath);
  } finally {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Best-effort cleanup after a failed rename.
    }
  }
}

function learningPolicyPath(role: string, projectRoot?: string): string {
  return path.join(roleDir(role, projectRoot), 'learning.json');
}

function projectAgentProfilePath(role: string, projectRoot?: string): string {
  return path.join(roleDir(role, projectRoot), 'profile.json');
}

export function slugifyProjectAgentRole(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 96);
  return assertProjectAgentRole(slug);
}

export function loadProjectAgentProfile(
  role: string,
  projectRoot?: string,
): ProjectAgentProfile | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(projectAgentProfilePath(role, projectRoot), 'utf8'),
    ) as Partial<ProjectAgentProfile>;
    const normalizedRole = assertProjectAgentRole(parsed.role ?? role);
    const baseRole = assertProjectAgentRole(parsed.baseRole ?? 'generic');
    if (normalizedRole !== assertProjectAgentRole(role)) return undefined;
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) return undefined;
    if (typeof parsed.purpose !== 'string' || !parsed.purpose.trim()) return undefined;
    if (
      !Array.isArray(parsed.taskTypes) ||
      parsed.taskTypes.some((item) => typeof item !== 'string')
    ) {
      return undefined;
    }
    const createdAt =
      typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date(0).toISOString();
    const updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : createdAt;
    return {
      role: normalizedRole,
      name: parsed.name.trim(),
      baseRole,
      purpose: parsed.purpose.trim(),
      taskTypes: parsed.taskTypes.map((item) => item.trim()).filter(Boolean),
      createdAt,
      updatedAt,
    };
  } catch {
    return undefined;
  }
}

/** Create a new, independently-learning project role from a roster template. */
export function createProjectAgent(
  input: CreateProjectAgentInput,
  projectRoot?: string,
): ProjectAgentProfile {
  const name = input.name.trim();
  const purpose = input.purpose.trim();
  if (!name || name.length > 120) throw new Error('Project agent name must be 1-120 characters.');
  if (purpose.length < 10 || purpose.length > 4_000) {
    throw new Error('Project agent purpose must be 10-4000 characters.');
  }
  const role = assertProjectAgentRole(
    (input.role?.trim() || slugifyProjectAgentRole(name)).toLowerCase(),
  );
  const baseRole = assertProjectAgentRole((input.baseRole?.trim() || 'generic').toLowerCase());
  const taskTypes = [...new Set(input.taskTypes.map((item) => item.trim()).filter(Boolean))];
  if (
    taskTypes.length === 0 ||
    taskTypes.length > 32 ||
    taskTypes.some((item) => item.length > 160)
  ) {
    throw new Error('Project agent requires 1-32 task descriptions, each at most 160 characters.');
  }

  const dir = roleDir(role, projectRoot);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`Project agent role "${role}" already exists.`);
  }
  const now = new Date().toISOString();
  const profile: ProjectAgentProfile = {
    role,
    name,
    baseRole,
    purpose,
    taskTypes,
    createdAt: now,
    updatedAt: now,
  };
  const identity = [
    `# ${name}`,
    '',
    `You are the project-specific "${name}" agent (role: ${role}).`,
    '',
    '## Purpose',
    '',
    purpose,
    '',
    '## Primary task types',
    '',
    ...taskTypes.map((item) => `- ${item}`),
    '',
    'Learn durable project conventions from completed work, keep conclusions evidence-based, and stay within this assigned purpose.',
    '',
  ].join('\n');

  mkdirSync(dir, { recursive: true });
  writeTextAtomically(path.join(dir, 'identity.md'), identity);
  writeTextAtomically(
    projectAgentProfilePath(role, projectRoot),
    `${JSON.stringify(profile, null, 2)}\n`,
  );
  return profile;
}

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

export function loadProjectAgentLearningPolicy(
  role: string,
  projectRoot?: string,
): ProjectAgentLearningPolicy {
  try {
    const parsed = JSON.parse(
      readFileSync(learningPolicyPath(role, projectRoot), 'utf8'),
    ) as Partial<ProjectAgentLearningPolicy>;
    return {
      enabled: parsed.enabled !== false,
      lifetimeCaptureCount:
        typeof parsed.lifetimeCaptureCount === 'number' &&
        Number.isInteger(parsed.lifetimeCaptureCount) &&
        parsed.lifetimeCaptureCount >= 0
          ? parsed.lifetimeCaptureCount
          : 0,
      ...(typeof parsed.lastCaptureAt === 'string' ? { lastCaptureAt: parsed.lastCaptureAt } : {}),
      ...(parsed.lastCaptureSource === 'automatic' ||
      parsed.lastCaptureSource === 'manual' ||
      parsed.lastCaptureSource === 'taught'
        ? { lastCaptureSource: parsed.lastCaptureSource }
        : {}),
    };
  } catch {
    return { ...DEFAULT_LEARNING_POLICY };
  }
}

export function updateProjectAgentLearningPolicy(
  role: string,
  patch: Partial<Pick<ProjectAgentLearningPolicy, 'enabled'>>,
  projectRoot?: string,
): ProjectAgentLearningPolicy {
  const current = loadProjectAgentLearningPolicy(role, projectRoot);
  const updated = {
    ...current,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
  };
  writeTextAtomically(
    learningPolicyPath(role, projectRoot),
    `${JSON.stringify(updated, null, 2)}\n`,
  );
  return updated;
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
    result.allowedCapabilities = options.protectSystemRole
      ? base.allowedCapabilities === undefined
        ? undefined
        : [...new Set([...base.allowedCapabilities, ...projectConfig.allowedCapabilities])]
      : [...projectConfig.allowedCapabilities];
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
} as const;

function applySystemAgentBudgetFloors(config: SubagentConfig): void {
  const mutable = config as unknown as Record<string, unknown>;
  for (const [field, floor] of Object.entries(SYSTEM_AGENT_BUDGET_FLOORS)) {
    const value = mutable[field];
    if (typeof value === 'number' && value < floor) mutable[field] = floor;
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
// ---------------------------------------------------------------------------
// Update / reset / improve API
// ---------------------------------------------------------------------------

/**
 * Write or update the learned wisdom file for a given role.
 * Appends to existing content when `mode` is 'append'; replaces when
 * it is 'replace'. Returns the full path written so callers can log it.
 */
export function updateProjectAgentLearned(
  role: string,
  content: string,
  projectRoot?: string,
  mode: 'append' | 'replace' = 'append',
): string {
  const dir = roleDir(role, projectRoot);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'learned.md');
  const existing = (() => {
    try {
      return readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  })();
  const newContent =
    mode === 'append' && existing
      ? `${existing.trimEnd()}\n\n---\n\n${content.trimStart()}`
      : content;
  writeTextAtomically(filePath, newContent);
  return filePath;
}

/**
 * Write or update the project identity file for a given role.
 * Replaces any existing identity.md with the new content.
 */
export function updateProjectAgentIdentity(
  role: string,
  content: string,
  projectRoot?: string,
): string {
  const dir = roleDir(role, projectRoot);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'identity.md');
  writeTextAtomically(filePath, content);
  return filePath;
}

/**
 * Write or update the config.json override for a given role.
 */
export function updateProjectAgentConfig(
  role: string,
  config: ProjectAgentConfig,
  projectRoot?: string,
): string {
  const validated = validateProjectAgentConfig(config);
  const dir = roleDir(role, projectRoot);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'config.json');
  writeTextAtomically(filePath, `${JSON.stringify(validated, null, 2)}\n`);
  return filePath;
}

/**
 * Write or update the knowledge manifest for a given role.
 */
export function updateProjectAgentKnowledge(
  role: string,
  manifest: RoleKnowledgeManifest,
  projectRoot?: string,
): string {
  const dir = roleDir(role, projectRoot);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'knowledge.json');
  writeTextAtomically(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
  return filePath;
}

/**
 * Reset all project-level customizations for a given role back to factory
 * defaults by removing its `.wrongstack/agents/<role>/` directory.
 * When `role` is omitted or `'*'`, resets all roles.
 * Returns a list of paths that were removed.
 */
export function resetProjectAgentIdentity(role?: string, projectRoot?: string): string[] {
  const removed: string[] = [];
  if (!role || role === '*') {
    // Remove the entire agents directory
    const dir = agentsDir(projectRoot);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    }
    return removed;
  }
  const dir = roleDir(role, projectRoot);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

/**
 * Improve (or refresh) the project-custom identity for a given role
 * by clearing the learned.md and identity.md and re-scaffolding empty
 * templates. This is the explicit "refresh" trigger a user can call
 * when they want the project agent to re-learn from scratch.
 *
 * Returns a status report string.
 */
export function refreshProjectAgentIdentity(role: string, projectRoot?: string): string {
  const dir = roleDir(role, projectRoot);
  mkdirSync(dir, { recursive: true });

  // Remove learned wisdom and identity, keep config.json and knowledge.json
  // Also clear any consolidated document since it was derived from entries
  // that are about to be wiped.
  for (const file of [
    'learned.md',
    'identity.md',
    'consolidated.md',
    'consolidation.json',
  ]) {
    const fp = path.join(dir, file);
    try {
      rmSync(fp, { force: true });
    } catch {
      // file didn't exist
    }
  }

  // Re-scaffold identifying headers so the role knows these are available
  writeTextAtomically(
    path.join(dir, 'learned.md'),
    renderLearnedInstructions(role, [], new Date().toISOString()),
  );
  writeTextAtomically(
    path.join(dir, 'identity.md'),
    `# Project identity for ${role}\n\n<!-- Describe how this agent should behave in the context of this project. -->\n`,
  );

  return `Project identity for role "${role}" has been refreshed. The identity.md and learned.md files are reset to empty templates. Run an agent-improve pass to populate them with project-specific knowledge.`;
}

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

export const LEARNED_SOFT_LIMIT = 8_192;
export const LEARNED_HARD_LIMIT = 16_384;

/**
 * Maximum length (in characters) of a single captured learning entry after
 * normalization. Entries longer than this are truncated to the first few
 * instructive sentences. Keeps `learned.md` scannable and prevents agents
 * from dumping journal-style narratives into the buffer.
 */
export const LEARNED_ENTRY_MAX_CHARS = 600;

/**
 * Minimum instructive content length (after stripping ephemeral artifacts
 * and narrative framing) for an entry to qualify as learned data.
 */
const MIN_INSTRUCTIVE_LENGTH = 30;

/**
 * Category tag for a captured learning entry. Derived deterministically from
 * the entry's content so the file is self-describing and scannable.
 *
 *  - `convention`  — durable rule / standard ("Always run X", "Never assume Y")
 *  - `pattern`     — reusable approach ("Use X for Y", "Prefer A over B")
 *  - `warning`     — pitfall / anti-pattern ("Avoid X", "Beware Y")
 *  - `fact`        — stable project fact (default when no directive verb matches)
 */
export type LearnedEntryCategory = 'convention' | 'pattern' | 'warning' | 'fact';

/**
 * Patterns whose presence signals an entry is narrative ("I/we did X") rather
 * than instructive ("Always do X"). When a sentence begins with one of these,
 * it is describing an event, not a principle — and gets stripped at capture
 * time so the buffer is not polluted with session logs.
 *
 * Each pattern matches a sentence START (after a sentence boundary), so it
 * only fires on narrative framing, never on substantive content that happens
 * to mention those words.
 */
const NARRATIVE_SENTENCE_STARTS: readonly RegExp[] = [
  /^(?:when|while|during|after|before|once|since)\s+(?:i|we|the agent|i was|i were|i had)\b/i,
  /^(?:i|we)\s+(?:found|noticed|learned|discovered|realized|saw|encountered|hit|ran into)\b/i,
  /^(?:i|we)\s+(?:was|were|had|did|ran|tried|attempted|used|modified|changed|updated)\b/i,
  /^(?:this|that|the)\s+(?:task|session|run|commit|change|pr|pull request|invocation)\b/i,
  /^(?:in|on|for|at|during)\s+(?:this|that|the)\s+(?:task|session|run|commit|change|pr)\b/i,
  /^(?:today|yesterday|earlier|just now|recently|lately)\b/i,
];

/**
 * Ephemeral artifacts that are noisy anchors (they pin an entry to a single
 * moment in history instead of making it actionable across sessions). Stripped
 * before persistence so the buffer reads like durable guidance.
 *
 * Kept deliberately conservative: file paths, package names, and command names
 * are NEVER stripped — those anchor the lesson in actionable form.
 */
const EPHEMERAL_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  // Git commit / blob SHAs (7-40 hex chars surrounded by word boundaries).
  { pattern: /\b[0-9a-f]{7,40}\b/g, replacement: '' },
  // ISO-8601 timestamps (with optional fractional seconds and timezone).
  {
    pattern: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
    replacement: '',
  },
  // Date-only references in narrative context ("on 2026-07-22", "from 2026-01-15").
  // Matches date preceded by a preposition so we don't strip version strings
  // like "2026.1.0" or legitimate date-valued configuration.
  { pattern: /(?<=\b(?:on|from|since|before|after|dated|until)\s)\d{4}-\d{2}-\d{2}\b/gi, replacement: '' },
  // Specific line / line-range references ("line 42", "lines 10–20").
  { pattern: /\b(?:line|lines?)\s+\d+(?:\s*[-–]\s*\d+)?/gi, replacement: '' },
  // PR / issue / MR number references ("PR #42", "issue #100").
  { pattern: /#\s*(?:PR|issue|MR)\s*\d+/gi, replacement: '' },
  // Standalone PR/issue/mr id (#123) when it's a numeric-only reference.
  { pattern: /(?<=\s)#\d{1,6}\b/g, replacement: '' },
];

/**
 * Normalize a captured LEARNED block into an instructive entry.
 *
 * Removes ephemeral artifacts (commit SHAs, timestamps, line numbers, PR refs),
 * strips narrative framing sentences ("When I did X...", "Today I found..."),
 * and enforces a maximum length. Returns `null` when the block is too thin,
 * too narrative, or otherwise cannot be salvaged into actionable guidance —
 * in which case the capture pipeline should reject it rather than persist a
 * session-log entry that masquerades as learned data.
 *
 * This function is deliberately conservative: when unsure, it preserves the
 * content. The goal is to remove clearly-noisy artifacts, not to rewrite the
 * agent's lesson.
 */
export function normalizeLearnedEntry(raw: string): {
  text: string;
  category: LearnedEntryCategory;
} | null {
  if (!raw) return null;

  // Step 1: strip ephemeral artifacts.
  let cleaned = raw;
  for (const { pattern, replacement } of EPHEMERAL_PATTERNS) {
    cleaned = cleaned.replace(pattern, replacement);
  }

  // Step 2: split into sentences and drop narrative-only sentences.
  // A sentence is "narrative-only" when it STARTS with a narrative marker
  // and contains no directive verb / imperative framing — i.e. it is purely
  // describing what happened. Substantive sentences that merely mention
  // a temporal marker (e.g. "When retrying, use backoff with jitter")
  // are preserved.
  const sentences = splitSentences(cleaned);
  const directiveSentences: string[] = [];
  let hadSubstantiveNarrative = false;
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (isNarrativeSentence(trimmed)) {
      hadSubstantiveNarrative = true;
      // If the sentence ALSO contains a directive verb, salvage the directive
      // tail (e.g. "When polling, prefer long-poll with jitter" → keep "prefer
      // long-poll with jitter"). Otherwise drop it.
      const salvaged = salvageDirectiveTail(trimmed);
      if (salvaged) {
        directiveSentences.push(salvaged);
      }
      continue;
    }
    directiveSentences.push(trimmed);
  }

  // If every sentence was narrative-only and we salvaged nothing, this is a
  // session log entry, not a learning — reject it.
  if (directiveSentences.length === 0) return null;

  let normalized = directiveSentences.join(' ').replace(/\s+/g, ' ').trim();

  // Step 3: enforce length cap. Truncate to the first full sentence that fits.
  if (normalized.length > LEARNED_ENTRY_MAX_CHARS) {
    normalized = truncateToInstructive(normalized, LEARNED_ENTRY_MAX_CHARS);
    if (normalized.length < MIN_INSTRUCTIVE_LENGTH) return null;
  }

  if (normalized.length < MIN_INSTRUCTIVE_LENGTH) return null;

  // If the entry was overwhelmingly narrative (more than half of its
  // sentences were narrative framing) and nothing directive remains, treat
  // it as a session log entry.
  if (hadSubstantiveNarrative && directiveSentences.length < sentences.length / 2) {
    // Only reject if the surviving content is thin relative to the original.
    if (normalized.length < MIN_INSTRUCTIVE_LENGTH * 2) return null;
  }

  return {
    text: normalized,
    category: classifyLearnedEntry(normalized),
  };
}

/**
 * Split a block into sentence-like units. Conservative splitter that
 * respects common abbreviations and avoids splitting on decimals so we
 * don't shred well-formed technical content.
 */
function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Heuristic: is this sentence narrative framing (describes an event) rather
 * than instructive content (describes what should be done)?
 */
function isNarrativeSentence(sentence: string): boolean {
  return NARRATIVE_SENTENCE_STARTS.some((re) => re.test(sentence));
}

/**
 * Given a narrative sentence like "When retrying, prefer long-poll with jitter",
 * extract the directive tail ("prefer long-poll with jitter") and return it.
 * Returns null when no salvageable directive tail exists.
 */
function salvageDirectiveTail(sentence: string): string | null {
  // Try each narrative pattern; if it matches, look for a directive verb
  // somewhere in the remainder.
  for (const re of NARRATIVE_SENTENCE_STARTS) {
    const m = re.exec(sentence);
    if (!m) continue;
    const tail = sentence.slice(m[0].length).replace(/^[,\s]+/, '').trim();
    if (!tail) return null;
    // Salvage only if the tail starts with a directive verb / noun phrase
    // that reads as actionable guidance.
    if (looksDirective(tail)) return tail;
    return null;
  }
  return null;
}

const DIRECTIVE_VERB_PATTERN =
  /^(?:always|never|prefer|avoid|use|ensure|verify|check|run|execute|apply|adopt|choose|require|must|should|don'?t|do not|keep|maintain|set|define|specify|validate|confirm|inspect|review|handle|enable|disable|restrict|cap|limit|wrap|isolate|separate|combine|split|merge|refactor|rename|move|extract|inline)\b/i;

/**
 * Loose test for "this reads as actionable guidance" — either starts with a
 * directive verb, or contains one of the canonical imperative markers.
 */
function looksDirective(text: string): boolean {
  if (DIRECTIVE_VERB_PATTERN.test(text)) return true;
  // Substantive phrasing like "the project uses X" or "X is required" also
  // counts as directive knowledge (it tells future invocations how things are).
  if (/\b(?:is|are|must be|should be|required to)\s+(?:always|never|used|preferred)\b/i.test(text))
    return true;
  // Narrative tails that contain a deontic verb ("had to use", "needs to
  // verify", "must be") carry a buried lesson — salvage them.
  if (
    /\b(?:had to|has to|have to|needs? to|must|should|ought to)\s+\w+/i.test(text) &&
    text.length > MIN_INSTRUCTIVE_LENGTH
  )
    return true;
  return false;
}

/**
 * Truncate text to fit within `maxChars`, cutting at the last sentence
 * boundary that still fits. Falls back to a hard cut when even the first
 * sentence exceeds the budget.
 */
function truncateToInstructive(text: string, maxChars: number): string {
  const sentences = splitSentences(text);
  let acc = '';
  for (const s of sentences) {
    const candidate = acc ? `${acc} ${s}` : s;
    if (candidate.length > maxChars) break;
    acc = candidate;
  }
  if (acc) return acc;
  // Hard cut at maxChars with an ellipsis when no sentence boundary works.
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Classify an instructive entry into one of four category buckets so the
 * `learned.md` file is self-describing and scannable. Order of checks is
 * intentional: warnings are the highest-signal category and win ties.
 */
export function classifyLearnedEntry(text: string): LearnedEntryCategory {
  const lower = text.toLowerCase();
  if (/\b(?:avoid|never|don'?t|do not|must not|prevent|watch out|beware|pitfall|gotcha|hazard|risk)\b/.test(lower))
    return 'warning';
  if (
    /\b(?:use|prefer|choose|adopt|leverage|apply|switch to|migrate to)\b/.test(lower) ||
    /\b(?:pattern|approach|strategy|technique|idiom)\b/.test(lower)
  )
    return 'pattern';
  if (/\b(?:always|must|should|require|ensure|verify|check|run|execute|before|after|when)\b/.test(lower))
    return 'convention';
  return 'fact';
}

/**
 * Normalize text for dedup comparison: lowercase, strip punctuation, sort tokens.
 */
function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .sort()
    .join(' ');
}

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
 * List every role that has any project-level agent customization or policy.
 */
export function listProjectAgentRoles(projectRoot?: string): string[] {
  const dir = agentsDir(projectRoot);
  try {
    return (readdirSync as (dir: string) => string[])(dir).filter((name: string) => {
      if (!AGENT_ROLE_PATTERN.test(name) || name === '.' || name === '..') return false;
      const sub = path.join(dir, name);
      try {
        return [
          'learned.md',
          'identity.md',
          'config.json',
          'knowledge.json',
          'learning.json',
          'profile.json',
          'consolidated.md',
          'consolidation.json',
        ].some((file) => existsSync(path.join(sub, file)));
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
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
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i]!;
    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j]!;
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

/**
 * Return the Jaccard similarity (0–1) of two normalised token sets.
 */
function tokenOverlap(a: string, b: string): number {
  const setA = new Set(a.split(/\s+/));
  const setB = new Set(b.split(/\s+/));
  const intersect = new Set([...setA].filter((t) => setB.has(t)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersect.size / union.size;
}

/**
 * Split an existing learned.md body into individual entries.
 * Entries are delimited by `---\n\n` sequences.
 */
function splitLearnedEntries(body: string): string[] {
  return body
    .split(/\n---\n+/)
    .map((entry) => entry.trim())
    .map((entry) =>
      entry
        .replace(/^# Learned wisdom for .+$/im, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim(),
    )
    .filter(Boolean);
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

/**
 * Parsed representation of a single buffered entry — the structured shape
 * that every capture merges into.
 */
export interface StructuredLearnedEntry {
  /** Injective content identity: normalized token signature for dedup. */
  key: string;
  /** Category bucket (convention / pattern / warning / fact). */
  category: LearnedEntryCategory;
  /** The directive itself — what the agent should do. */
  what: string;
  /** Why this directive exists — derived from category and directive signals. */
  why: string;
  /** Concrete, runnable anchor — commands, file paths, package names. */
  how: string;
  /** ISO timestamp of when this entry was originally captured. */
  capturedAt: string;
}

/**
 * Parse the stamp line at the top of a buffered entry. Handles three formats:
 *
 *  1. New structured-document format (current):
 *     `<!-- learned-stamp: category=<cat>; capturedAt=<iso> -->`
 *  2. Legacy stamped format: `> [category] Captured <iso>` / `> Captured <iso>`
 *  3. Legacy taught format: `> [category] Taught <iso>` / `> Taught <iso>`
 *
 * Buffers persisted before the structured-document migration still load
 * cleanly through this parser.
 */
export function parseLearnedEntryStamp(entry: string): {
  capturedAt: string;
  category: LearnedEntryCategory | null;
} {
  // New structured format — the stamp lives in a hidden HTML comment.
  const structuredMatch = entry.match(
    /<!--\s*learned-stamp:\s*category=([\w-]+);\s*capturedAt=([^;]+?)\s*-->/,
  );
  if (structuredMatch) {
    const rawCategory = structuredMatch[1];
    const candidate: LearnedEntryCategory | undefined =
      rawCategory === 'convention' ||
      rawCategory === 'pattern' ||
      rawCategory === 'warning' ||
      rawCategory === 'fact'
        ? rawCategory
        : undefined;
    return {
      capturedAt: typeof structuredMatch[2] === 'string' ? structuredMatch[2].trim() : '',
      category: candidate ?? null,
    };
  }
  // Legacy format — `> [category] Captured <iso>` or `> Captured <iso>`.
  const stampMatch = entry.match(/^>\s*(?:\[\s*([\w-]+)\s*\]\s+)?(?:Captured|Taught)\s+(\S+)/m);
  if (!stampMatch) {
    return { capturedAt: '', category: null };
  }
  const rawCategory = stampMatch[1];
  const candidate: LearnedEntryCategory | undefined =
    rawCategory === 'convention' ||
    rawCategory === 'pattern' ||
    rawCategory === 'warning' ||
    rawCategory === 'fact'
      ? rawCategory
      : undefined;
  return {
    capturedAt: typeof stampMatch[2] === 'string' ? stampMatch[2] : '',
    category: candidate ?? null,
  };
}

/**
 * Strip the stamp line(s) from a buffered entry so only the directive text
 * remains. Handles both the hidden-comment structured stamp and the legacy
 * blockquote stamp.
 */
function stripStamp(entry: string): string {
  return entry
    .replace(/<!--\s*learned-stamp:[\s\S]*?-->/g, '')
    .replace(/^>\s*(?:\[[\w-]+\]\s+)?(?:Captured|Taught)\s+.+$/m, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract a content key (normalized token signature) from a directive. Used
 * for dedup so two entries that say the same thing in slightly different
 * words collapse to one. Same normalization shape as the existing dedup path
 * for backward compatibility.
 */
function directiveKey(text: string): string {
  return normalizeForComparison(text);
}

/**
 * Decompose a directive into its "what / why / how" components.
 *
 * Most captured LEARNED blocks are a single sentence — "Always run pnpm
 * typecheck before declaring work complete." This function heuristically
 * pulls out the action (what), the implicit reason (why, derived from
 * the entry's category and directive verbs), and any concrete anchors
 * (how, extracted as commands, file paths, and package names).
 *
 * The decomposition is deliberately conservative: when an entry already
 * reads cleanly as a single imperative, the "what" carries the full text
 * and "why"/"how" are short complementary notes. The agent reading the
 * buffer can scan the "what" lines for relevance and dive into "why" /
 * "how" only when applying the rule.
 */
export function decomposeLearnedEntry(
  text: string,
  category: LearnedEntryCategory,
): { what: string; why: string; how: string } {
  const what = text;
  const why = deriveWhy(category, text);
  const how = extractHow(text);
  return { what, why, how };
}

const WHY_BY_CATEGORY: Record<LearnedEntryCategory, string> = {
  convention:
    'Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.',
  pattern:
    "This project's chosen approach — alternatives were considered and either conflict with existing architecture or were rejected for known reasons.",
  warning:
    'Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.',
  fact:
    'Current state of the project — assumed by other conventions, build steps, or peers, so acting on a stale assumption wastes a cycle.',
};

/**
 * Build a category-aware reason string. When the directive text contains
 * signals about WHY (e.g. "before merging", "to avoid silent data loss"),
 * append those signals so the "why" reads as project-specific rather than
 * generic.
 */
function deriveWhy(category: LearnedEntryCategory, text: string): string {
  const base = WHY_BY_CATEGORY[category];
  const signals: string[] = [];
  const lower = text.toLowerCase();
  if (/\bbefore\s+(?:merge|commit|deploy|release|shipping|publishing)\b/.test(lower))
    signals.push('guard before shipping');
  if (/\bto\s+avoid\b/.test(lower)) {
    const m = text.match(/to avoid ([^.!?]+)/i);
    if (m?.[1]) signals.push(`avoid ${m[1].trim()}`);
  }
  if (/\bso\s+(?:that|we|the project)\b/.test(lower)) {
    const m = text.match(/so (?:that |we |the project )?([^.!?]+)/i);
    if (m?.[1]) signals.push(`so ${m[1].trim()}`);
  }
  if (signals.length === 0) return base;
  return `${base} Project signals: ${signals.join('; ')}.`;
}

/**
 * Extract concrete runnable anchors from a directive: shell commands
 * (`pnpm test`, `git status`), file paths (`packages/core/src/...`),
 * package names (`@wrongstack/core`), and environment names (`vitest`).
 * Returns a deduplicated bullet list, or an empty string when no concrete
 * anchor can be extracted.
 */
function extractHow(text: string): string {
  const anchors = new Set<string>();
  // Backtick-wrapped commands / paths / identifiers — strong signal.
  const backticked = text.match(/`([^`]+)`/g) ?? [];
  for (const raw of backticked) {
    const inner = raw.replace(/`/g, '').trim();
    if (inner.length > 0 && inner.length <= 120) anchors.add(inner);
  }
  // File paths — anything matching packages/..., src/..., tests/..., or ending in .ts/.tsx/.js/.json/.md
  const pathMatches = text.match(/(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yaml|yml)/g) ?? [];
  for (const p of pathMatches) anchors.add(p);
  // Package-scoped names like @scope/name
  const scoped = text.match(/@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*/gi) ?? [];
  for (const p of scoped) anchors.add(p);
  if (anchors.size === 0) return '';
  return [...anchors].map((a) => `- \`${a}\``).join('\n');
}

/**
 * Parse every buffered entry into a structured representation, skipping
 * malformed lines and structural-document chunks (the header, section
 * headings, footer) that don't carry a per-entry stamp. Entries with no
 * parseable directive body are dropped — the merge pipeline re-derives
 * category from the directive text so old entries that lost their stamp
 * still load.
 */
export function parseStructuredLearnedEntries(role: string, projectRoot?: string): StructuredLearnedEntry[] {
  // Read the raw buffer directly — do NOT use splitLearnedEntries, which
  // strips HTML comments and would destroy the structured stamp metadata.
  const raw = loadProjectAgentLearned(role, projectRoot);
  if (!raw) return [];
  const structured: StructuredLearnedEntry[] = [];
  // Each entry block in the structured document starts with a stamp comment
  // immediately followed by a bullet `- **<what>**`. Extract those pairs.
  const entryPattern =
    /<!--\s*learned-stamp:\s*category=([\w-]+);\s*capturedAt=([^;]+?)\s*-->\s*\n-\s+\*\*(.+?)\*\*(?:\s*\n\s+-\s+\*Why:\*\s+(.+?))?(?:\s*\n\s+-\s+\*How:\*\s+(.+?))?(?=\n(?:<!--|##|---|\n|$))/gs;
  for (const m of raw.matchAll(entryPattern)) {
    const categoryRaw = m[1] ?? '';
    const capturedAt = (m[2] ?? '').trim();
    const what = (m[3] ?? '').trim();
    const why = (m[4] ?? '').trim();
    const howRaw = (m[5] ?? '').trim();
    const category: LearnedEntryCategory =
      categoryRaw === 'convention' ||
      categoryRaw === 'pattern' ||
      categoryRaw === 'warning' ||
      categoryRaw === 'fact'
        ? categoryRaw
        : 'fact';
    if (what.length < MIN_INSTRUCTIVE_LENGTH) continue;
    structured.push({
      key: directiveKey(what),
      category,
      what,
      why: why || WHY_BY_CATEGORY[category],
      how: howRaw,
      capturedAt,
    });
  }
  // Fallback: if no structured stamps were found, try the legacy format
  // (blockquote stamps) via splitLearnedEntries so old buffers still load.
  // Also handles raw unstructured text written by updateProjectAgentLearned
  // (entries without any stamp — each chunk is treated as a directive).
  if (structured.length === 0) {
    const rawEntries = listProjectAgentLearnedEntries(role, projectRoot);
    for (const chunk of rawEntries) {
      const stamp = parseLearnedEntryStamp(chunk);
      const directive = stamp.capturedAt || stamp.category ? stripStamp(chunk) : chunk;
      if (directive.length < MIN_INSTRUCTIVE_LENGTH) continue;
      const category = stamp.category ?? classifyLearnedEntry(directive);
      const { what, why, how } = decomposeLearnedEntry(directive, category);
      structured.push({
        key: directiveKey(directive),
        category,
        what,
        why,
        how,
        capturedAt: stamp.capturedAt,
      });
    }
  }
  return structured;
}

/**
 * Merge a new directive into an existing structured-entry list, deduplicating
 * by content similarity. Returns the merged list with the new entry replacing
 * its near-duplicate when one is found (newest write wins).
 */
export function mergeStructuredEntries(
  existing: StructuredLearnedEntry[],
  fresh: { text: string; category: LearnedEntryCategory; capturedAt: string },
): StructuredLearnedEntry[] {
  const { what, why, how } = decomposeLearnedEntry(fresh.text, fresh.category);
  const freshEntry: StructuredLearnedEntry = {
    key: directiveKey(fresh.text),
    category: fresh.category,
    what,
    why,
    how,
    capturedAt: fresh.capturedAt,
  };
  // Dedup: drop existing entries that overlap with the new one (token overlap ≥ 0.55).
  const merged = existing.filter((entry) => tokenOverlap(entry.key, freshEntry.key) < 0.55);
  merged.push(freshEntry);
  // Stable order: by category bucket (warning → convention → pattern → fact),
  // then by what text so the buffer is scannable and reproducible.
  const order: Record<LearnedEntryCategory, number> = { warning: 0, convention: 1, pattern: 2, fact: 3 };
  merged.sort((a, b) => {
    const cmp = order[a.category] - order[b.category];
    if (cmp !== 0) return cmp;
    return a.what.localeCompare(b.what);
  });
  return merged;
}

const SECTION_TITLE: Record<LearnedEntryCategory, string> = {
  warning: '## What to avoid',
  convention: '## What to do',
  pattern: '## Patterns to follow',
  fact: '## Project facts',
};

/**
 * Render a structured-entry list as the markdown instruction document that
 * gets written to `learned.md`. The output is intentionally a single
 * structured reference — not a journal — so a future agent reading it can
 * scan section headings and pull the rules it needs.
 *
 * Each entry embeds its category and capture timestamp as a hidden HTML
 * comment (`<!-- learned-stamp: ... -->`) so the parser can recover that
 * metadata when re-loading the buffer. The comment is invisible when the
 * file is rendered as markdown — agents reading the document see only the
 * structured "what / why / how" content.
 */
export function renderLearnedInstructions(
  role: string,
  entries: StructuredLearnedEntry[],
  capturedAt: string,
): string {
  const headerLines = [
    `# Learned instructions for \`${role}\``,
    '',
    '> Project-specific learning data for the `' +
      role +
      '` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.',
    '',
  ];

  if (entries.length === 0) {
    return (
      headerLines.join('\n') +
      [
        '_No learned entries yet._',
        '',
        '---',
        `*Last capture: ${capturedAt} · 0 entries*`,
        '',
      ].join('\n')
    );
  }

  // Group entries by category in the canonical order.
  const buckets: Record<LearnedEntryCategory, StructuredLearnedEntry[]> = {
    warning: [],
    convention: [],
    pattern: [],
    fact: [],
  };
  for (const entry of entries) buckets[entry.category].push(entry);

  const sections: string[] = [];
  for (const category of ['warning', 'convention', 'pattern', 'fact'] as LearnedEntryCategory[]) {
    const list = buckets[category];
    if (list.length === 0) continue;
    sections.push(SECTION_TITLE[category]);
    sections.push('');
    for (const entry of list) {
      // Hidden stamp comment preserves category + capturedAt for the parser.
      // The what/why/how body stays clean for human/agent readers.
      const stamp = `<!-- learned-stamp: category=${entry.category}; capturedAt=${entry.capturedAt} -->`;
      sections.push(stamp);
      sections.push(`- **${entry.what}**`);
      sections.push(`  - *Why:* ${entry.why}`);
      if (entry.how) {
        for (const line of entry.how.split('\n')) sections.push(`  - *How:* ${line.replace(/^- /, '')}`);
      }
      sections.push('');
    }
  }

  const footer = ['---', `*Last capture: ${capturedAt} · ${entries.length} entries*`, ''];

  return [...headerLines, ...sections, ...footer].join('\n');
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

function consolidationPath(role: string, projectRoot?: string): string {
  return path.join(roleDir(role, projectRoot), 'consolidated.md');
}

function consolidationMetaPath(role: string, projectRoot?: string): string {
  return path.join(roleDir(role, projectRoot), 'consolidation.json');
}

/**
 * Load the consolidated learning document for a role.
 * Returns '' when no consolidation has been performed.
 */
export function loadProjectAgentConsolidated(role: string, projectRoot?: string): string {
  try {
    return readFileSync(consolidationPath(role, projectRoot), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Load consolidation metadata for a role.
 * Returns undefined when no consolidation has been performed.
 */
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

/**
 * Whether a role has a valid consolidated document.
 */
export function isConsolidated(role: string, projectRoot?: string): boolean {
  // Check the metadata file existence rather than reading + trimming the
  // entire consolidated.md — this runs in the per-role stats hot path.
  return existsSync(consolidationMetaPath(role, projectRoot));
}

/**
 * Save the consolidated document and its metadata atomically.
 * Returns the path to consolidated.md.
 */
export function saveProjectAgentConsolidated(
  role: string,
  content: string,
  projectRoot?: string,
  metadata?: Partial<ConsolidationMetadata>,
): string {
  // Refuse to persist a meaningless (empty/whitespace) consolidation — doing
  // so would write metadata that contradicts runtime behavior (empty
  // consolidated.md yet isConsolidated: true). See High finding.
  if (!content.trim()) {
    const fp = consolidationPath(assertProjectAgentRole(role), projectRoot);
    return fp;
  }
  const normalizedRole = assertProjectAgentRole(role);
  const dir = roleDir(normalizedRole, projectRoot);
  mkdirSync(dir, { recursive: true });
  const fp = consolidationPath(normalizedRole, projectRoot);
  writeTextAtomically(fp, content);

  const rawEntries = listProjectAgentLearnedEntries(normalizedRole, projectRoot);
  const rawBytes = Buffer.byteLength(
    loadProjectAgentLearned(normalizedRole, projectRoot),
    'utf8',
  );
  const meta: ConsolidationMetadata = {
    consolidatedAt: new Date().toISOString(),
    sourceEntryCount: rawEntries.length,
    sourceBytes: rawBytes,
    consolidatedBytes: Buffer.byteLength(content, 'utf8'),
    trigger: metadata?.trigger ?? 'manual',
    ...(metadata?.model ? { model: metadata.model } : {}),
  };
  writeTextAtomically(consolidationMetaPath(normalizedRole, projectRoot), `${JSON.stringify(meta, null, 2)}\n`);
  return fp;
}

/**
 * Clear the consolidated document and its metadata (e.g. when raw entries
 * are deleted or reset). Idempotent — safe to call when no consolidation
 * exists.
 */
export function clearProjectAgentConsolidated(role: string, projectRoot?: string): void {
  const normalizedRole = assertProjectAgentRole(role);
  for (const file of [consolidationPath(normalizedRole, projectRoot), consolidationMetaPath(normalizedRole, projectRoot)]) {
    try {
      rmSync(file, { force: true });
    } catch {
      // already absent
    }
  }
}

/**
 * Build the LLM instruction for consolidating a role's learned entries.
 *
 * The instruction tells the reviewing LLM to:
 *   1. Read every raw learned.md entry
 *   2. Synthesize them into a single narrowly-scoped document
 *   3. Preserve every fact, convention, and decision — no omissions
 *   4. Rewrite verbose entries into concise, directive statements
 *
 * The caller (WS handler / CLI / WebUI) is responsible for executing the
 * LLM call and passing the result to saveProjectAgentConsolidated().
 */
export function buildConsolidationInstruction(role: string, projectRoot?: string): {
  instruction: string;
  rawEntries: string[];
  hasExistingConsolidation: boolean;
} {
  const normalizedRole = assertProjectAgentRole(role);
  const rawEntries = listProjectAgentLearnedEntries(normalizedRole, projectRoot);
  const existingConsolidation = loadProjectAgentConsolidated(normalizedRole, projectRoot);

  const rawBody = rawEntries
    .map((entry, i) => `### Entry ${i + 1}\n\n${entry}`)
    .join('\n\n');

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
    sections.push('', `## Existing consolidated document (for reference — improve upon it)\n\n${existingConsolidation}`);
  }

  sections.push(
    '',
    '## Output',
    '',
    'Return ONLY the consolidated markdown document. Do not wrap it in code fences or add commentary.',
  );

  const instruction = sections.join('\n');

  return {
    instruction,
    rawEntries,
    hasExistingConsolidation: Boolean(existingConsolidation),
  };
}

// ---------------------------------------------------------------------------
// Built-in knowledge manifests (per role type, current-needs checklist)
// ---------------------------------------------------------------------------

const BUILT_IN_KNOWLEDGE_MANIFESTS: Record<string, RoleKnowledgeManifest> = {
  android: {
    role: 'android',
    liveQueries: {
      agp: {
        registry: 'https://developer.android.com/build/releases/gradle-plugin',
        key: 'latest',
        description: 'Android Gradle Plugin latest stable',
      },
      kotlin: {
        registry: 'https://registry.npmjs.org/kotlin/latest',
        key: 'version',
        description: 'Kotlin latest stable',
      },
      compileSdk: {
        registry: 'https://developer.android.com/about/versions',
        key: 'api_level',
        description: 'Current stable API level',
      },
    },
    checklist: [
      'Current Android Gradle Plugin version (8.x+)',
      'Current Kotlin version (2.x+)',
      'Current compileSdk / targetSdk (≥ 34, check Play Store policy)',
      'Current Jetpack Compose stable version',
      'All third-party dependencies are at latest compatible minor',
    ],
    verifyThreshold: 0.5,
  },
  frontend: {
    role: 'frontend',
    liveQueries: {
      react: {
        registry: 'https://registry.npmjs.org/react/latest',
        key: 'version',
        description: 'React latest stable',
      },
      nextjs: {
        registry: 'https://registry.npmjs.org/next/latest',
        key: 'version',
        description: 'Next.js latest stable',
      },
    },
    checklist: [
      'Current React version (pinned in package.json)',
      'Current Next.js / Vite / framework version',
      'Node.js runtime version (project .nvmrc or engines)',
      'All devDependencies are at latest compatible versions',
      'Browser compatibility targets from browserslist',
    ],
    verifyThreshold: 0.5,
  },
  executor: {
    role: 'executor',
    liveQueries: {
      node: {
        registry: 'https://registry.npmjs.org/node/latest',
        key: 'version',
        description: 'Node.js latest LTS',
      },
    },
    checklist: [
      'Node.js version from .nvmrc or package.engines',
      'TypeScript version from package.json',
      'Package manager (pnpm ≥ 9) from packageManager',
      'Current toolchain: esbuild, vitest, etc.',
    ],
    verifyThreshold: 0.6,
  },
};
