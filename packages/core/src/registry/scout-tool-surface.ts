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
import type { Tool } from '@wrongstack/contracts/types/tool';
import { ToolCapabilities } from '../security/capabilities.js';
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

const SCOUT_DELEGATION_NAMES: ReadonlySet<string> = new Set(SCOUT_DELEGATION_TOOL_NAMES);
const soloFallbacks = new WeakMap<Tool[], Tool[]>();

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
  if (
    selected.some((tool) => tool.name === 'tool_search') &&
    selected.some((tool) => tool.name === 'tool_use')
  ) {
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
 * fixed small surface; every other variant keeps the registry's tier surface.
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
      : registry.listForProvider();
  return provider?.selectToolsForRequest?.(tools) ?? tools;
}

/**
 * `areSubagentsAllowed` from security/session-subagent-policy, read
 * straight off the session meta: core/ may not import coordination/ at
 * runtime. `scout-variant.test.ts` pins the two to the same answer.
 */
function generalSubagentsAllowed(meta: Readonly<Record<string, unknown>> | undefined): boolean {
  return meta?.['subagentsAllowed'] !== false;
}
