import { clampSubagentCapabilities } from '../../security/capabilities.js';
import type { SubagentConfig } from '../../types/multi-agent.js';
import { inferRuntimeCapabilities } from './capability-manifest.js';
import { loadProjectAgentConfig } from './project-agent-config-io.js';
import { listProjectAgentRoles } from './project-agent-files.js';
import type { ProjectAgentConfig } from './project-agent-identity-types.js';
import { loadProjectAgentProfile } from './project-agent-profile.js';

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
