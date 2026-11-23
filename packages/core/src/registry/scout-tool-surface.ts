/**
 * The direct tool surface of the Scout identity (`systemPrompt.variant:
 * 'scout'`).
 *
 * Scout is the general-purpose identity rather than a coding one, and it starts
 * from a deliberately small context: only these schemas are sent on each
 * request. The rest of the catalog stays registered and executable — the model
 * finds it with `tool_search` and calls it with `tool_use`, both of which read
 * `ctx.catalogTools`, not this list.
 *
 * The surface is resolved per conversation from `ctx.meta.systemPromptVariant`
 * instead of through `ToolRegistry.setProviderToolNames`: that setter is
 * registry-wide, so one WebUI tab picking Scout would otherwise shrink the
 * tool surface of every other tab sharing the registry.
 */

import type { Provider } from '@wrongstack/contracts/types/provider';
import type { SessionMetadata } from '@wrongstack/contracts/types/session';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { ToolCapabilities } from '../security/capabilities.js';
import { estimateToolDefTokens } from '../utils/token-estimate.js';
import type { ToolRegistry } from './tool-registry.js';

/**
 * Delegation. The Scout identity requires splitting decomposable work across
 * subagents and roster roles, so the route must not hide behind a search; the
 * roster menu also rides on these schemas. Registered only when the host wired
 * a Director.
 */
const SCOUT_DELEGATION_TOOL_NAMES = [
  'delegate',
  'spawn_subagent',
  'assign_task',
  'await_tasks',
  'roll_up',
  'terminate_subagent',
] as const;

/** Scout's surface when this session may not spawn subagents. */
const SCOUT_SOLO_DIRECT_TOOL_NAMES: ReadonlySet<string> = new Set([
  // The only route to the withheld catalog.
  'tool_search',
  'tool_use',
  'clarify',
  // Files and documents.
  'read',
  'write',
  'edit',
  // Shell and processes.
  'bash',
  'exec',
  'pwsh',
  // Web.
  'search',
  'fetch',
  'read_url_content',
  // Task tracking and memory.
  'todo',
  'remember',
  'search_memory',
  'memory_search',
  // The skill manifest is always in the prompt, so its loader must be direct.
  'skill',
  // Present only when the host enabled the final-turn next-steps contract.
  'nextsteps',
]);

/** Tool names Scout sends directly; a name with no registered tool is skipped. */
export const SCOUT_DIRECT_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...SCOUT_SOLO_DIRECT_TOOL_NAMES,
  ...SCOUT_DELEGATION_TOOL_NAMES,
]);

/**
 * The Quick identity's basic tools (`systemPrompt.variant: 'quick'`): at most
 * ten. A name with no registered tool is skipped, so a session that pins one
 * shell sends nine.
 */
export const QUICK_BASIC_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'bash',
  'pwsh',
  'fetch',
  'clarify',
  // Present only when the host enabled the final-turn next-steps contract.
  'nextsteps',
]);

/**
 * Quick's direct surface: the basic tools plus the catalog gateway. Only the
 * two gateway schemas enter the context; every other tool stays reachable on
 * demand through `tool_search` / `tool_use` (see session-tool-reach).
 */
export const QUICK_DIRECT_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...QUICK_BASIC_TOOL_NAMES,
  'tool_search',
  'tool_use',
]);

/**
 * When a Quick session runs a playbook with `<!-- wrongstack:required-skills -->`
 * (e.g. `/bughunt`), expose `skill` directly so the model does not have to
 * route mandatory skill loading through `tool_use`.
 */
const QUICK_REQUIRED_SKILLS_DIRECT_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...QUICK_DIRECT_TOOL_NAMES,
  'skill',
]);

const SCOUT_DELEGATION_NAMES: ReadonlySet<string> = new Set(SCOUT_DELEGATION_TOOL_NAMES);
const soloFallbacks = new WeakMap<Tool[], Tool[]>();
const projectedQuickTools = new WeakMap<Tool[], Tool[]>();
const deferredKanbanSurfaces = new WeakMap<Tool[], Tool[]>();
const quickShellSurfaces = {
  bash: new WeakMap<Tool[], Tool[]>(),
  pwsh: new WeakMap<Tool[], Tool[]>(),
};

function hasLazyToolGateways(tools: readonly Tool[]): boolean {
  return (
    tools.some((tool) => tool.name === 'tool_search') &&
    tools.some((tool) => tool.name === 'tool_use')
  );
}

function quickShellTool(
  tools: readonly Tool[],
  pinned: SessionMetadata['quickShellTool'],
): SessionMetadata['quickShellTool'] {
  if (
    (pinned === 'bash' || pinned === 'pwsh') &&
    tools.some((tool) => tool.name === pinned) &&
    hasLazyToolGateways(tools)
  ) {
    return pinned;
  }
  return undefined;
}

function quickToolProjection(tools: Tool[], shell: SessionMetadata['quickShellTool']): Tool[] {
  const cache = shell ? quickShellSurfaces[shell] : projectedQuickTools;
  const cached = cache.get(tools);
  if (cached) return cached;
  const alternateShell = shell === 'pwsh' ? 'bash' : 'pwsh';
  const direct = shell ? tools.filter((tool) => tool.name !== alternateShell) : tools;
  const projected = direct.map((tool) => {
    if (!tool.quickProjection) return tool;
    const view: Tool = { ...tool, ...tool.quickProjection, _estDefTokens: undefined };
    view._estDefTokens = estimateToolDefTokens(view);
    return view;
  });
  cache.set(tools, projected);
  return projected;
}

/**
 * Session meta key: deferred tools this project keeps calling through
 * `tool_use`, promoted into Scout's direct surface for the whole session
 * (`storage/scout-tool-learning.ts`). Set once at session start and never
 * changed mid-session, so the tool list — and the prompt cache — stays stable.
 */
export const SCOUT_LEARNED_TOOLS_META_KEY = 'scoutLearnedTools';

/** Base + learned name sets, one pair per session's learned array. */
const learnedNameSets = new WeakMap<
  readonly unknown[],
  { all: ReadonlySet<string>; solo: ReadonlySet<string> }
>();

function scoutNames(subagentsAllowed: boolean, learned: unknown): ReadonlySet<string> {
  const base = subagentsAllowed ? SCOUT_DIRECT_TOOL_NAMES : SCOUT_SOLO_DIRECT_TOOL_NAMES;
  if (!Array.isArray(learned) || learned.length === 0) return base;
  let sets = learnedNameSets.get(learned);
  if (!sets) {
    const names = learned.filter((name): name is string => typeof name === 'string');
    sets = {
      all: new Set([...SCOUT_DIRECT_TOOL_NAMES, ...names]),
      solo: new Set([
        ...SCOUT_SOLO_DIRECT_TOOL_NAMES,
        ...names.filter((name) => !SCOUT_DELEGATION_NAMES.has(name)),
      ]),
    };
    learnedNameSets.set(learned, sets);
  }
  return subagentsAllowed ? sets.all : sets.solo;
}

function scoutTools(
  registry: Pick<ToolRegistry, 'list' | 'listWithin'>,
  subagentsAllowed: boolean,
  learned?: unknown,
): Tool[] {
  const selected = registry.listWithin(scoutNames(subagentsAllowed, learned));
  if (hasLazyToolGateways(selected)) {
    // A learned tool can be spawn-capable; a solo session is never offered one.
    return subagentsAllowed ? selected : withoutSpawnTools(selected);
  }
  // A fixed surface is useful only while its withheld tools have a route.
  // Keep the explicit disable/restriction, but expose the remaining catalog.
  const catalog = registry.list();
  return subagentsAllowed ? catalog : withoutSpawnTools(catalog);
}

/** Drop delegation and spawn-capable tools, memoised per input array. */
function withoutSpawnTools(tools: Tool[]): Tool[] {
  const cached = soloFallbacks.get(tools);
  if (cached) return cached;
  const solo = tools.filter(
    (tool) =>
      !SCOUT_DELEGATION_NAMES.has(tool.name) &&
      !tool.capabilities?.includes(ToolCapabilities.SUBAGENT_SPAWN),
  );
  soloFallbacks.set(tools, solo);
  return solo;
}

/**
 * The tools a conversation sends to the provider directly. Scout gets its
 * fixed small surface, Quick its fixed basic set; every other variant keeps the
 * registry's tier surface.
 *
 * Under a solo session policy the executor denies every spawn, so Scout's
 * delegation schemas are dropped rather than offered and refused: a listed
 * tool reads as permission to try, and each try is a wasted round trip.
 */
export function providerToolsForVariant(
  registry: Pick<ToolRegistry, 'list' | 'listForProvider' | 'listWithin'>,
  variant: unknown,
  meta?: Readonly<Record<string, unknown>> | undefined,
  provider?: Pick<Provider, 'selectToolsForRequest'> | undefined,
): Tool[] {
  const tools =
    variant === 'scout'
      ? scoutTools(registry, generalSubagentsAllowed(meta), meta?.[SCOUT_LEARNED_TOOLS_META_KEY])
      : variant === 'quick'
        ? registry.listWithin(
            hasRequiredSkills(meta)
              ? QUICK_REQUIRED_SKILLS_DIRECT_TOOL_NAMES
              : QUICK_DIRECT_TOOL_NAMES,
          )
        : registry.listForProvider();
  return provider?.selectToolsForRequest?.(tools) ?? tools;
}

/** The direct request surface and its shell guidance for a specific journal. */
export function providerToolSurfaceForVariant(
  registry: Parameters<typeof providerToolsForVariant>[0] &
    Partial<Pick<ToolRegistry, 'providerToolTier'>>,
  variant: unknown,
  meta: Parameters<typeof providerToolsForVariant>[2],
  provider: Parameters<typeof providerToolsForVariant>[3],
  session?: Pick<
    SessionMetadata,
    'quickToolSchemaVersion' | 'quickShellTool' | 'providerToolSchemaVersion'
  >,
): {
  tools: Tool[];
  quickShellTool?: SessionMetadata['quickShellTool'];
  kanbanDeferred?: true | undefined;
} {
  const direct = providerToolsForVariant(registry, variant, meta, provider);
  if (
    variant !== 'quick' &&
    variant !== 'scout' &&
    registry.providerToolTier === 'medium' &&
    session?.providerToolSchemaVersion === 1 &&
    hasLazyToolGateways(direct)
  ) {
    const cached = deferredKanbanSurfaces.get(direct);
    if (cached) return { tools: cached, kanbanDeferred: true };
    const tools = direct.filter((tool) => tool.name !== 'kanban');
    if (tools.length === direct.length) return { tools: direct };
    deferredKanbanSurfaces.set(direct, tools);
    return { tools, kanbanDeferred: true };
  }
  const version = variant === 'quick' ? session?.quickToolSchemaVersion : undefined;
  if (version !== 1 && version !== 2) return { tools: direct };
  const shell = version === 2 ? quickShellTool(direct, session?.quickShellTool) : undefined;
  return { tools: quickToolProjection(direct, shell), quickShellTool: shell };
}

function hasRequiredSkills(meta: Readonly<Record<string, unknown>> | undefined): boolean {
  const state = meta?.['requiredSkills'] as { required?: unknown } | undefined;
  return Array.isArray(state?.required) && state.required.length > 0;
}

/**
 * `areSubagentsAllowed` from security/session-subagent-policy, read
 * straight off the session meta: core/ may not import coordination/ at
 * runtime. `scout-variant.test.ts` pins the two to the same answer.
 */
function generalSubagentsAllowed(meta: Readonly<Record<string, unknown>> | undefined): boolean {
  return meta?.['subagentsAllowed'] !== false;
}
