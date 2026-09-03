import { type PluginEnablementSource, resolvePluginEnablement } from '../plugin/config.js';
import type { ToolRegistry } from '../registry/tool-registry.js';
import { getDangerousCapabilities, ToolCapabilities } from '../security/capabilities.js';
import { toolMutates } from '../security/readonly-permission-policy.js';
import type { Config, PluginConfig } from '../types/config.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import { validateAgainstSchema } from '../utils/json-schema-validate.js';

export const PLUGIN_MANAGER_TOOL_NAME = 'plugin_manager';

/** Maps the shared resolver's source onto this tool's public wire values. */
const PLUGIN_VIEW_STATE_SOURCE: Record<PluginEnablementSource, PluginView['stateSource']> = {
  'feature-flag': 'feature_flag',
  'plugin-entry': 'config',
  extension: 'extension',
  default: 'default',
};

export interface PluginManagerCatalogEntry {
  name: string;
  description: string;
  risk: 'low' | 'medium' | 'high';
  defaultState: 'active' | 'inactive';
  canDisable: boolean;
  /** Alternative config/discovery names, such as an official package specifier. */
  aliases?: readonly string[] | undefined;
}

export interface PluginManagerMutationResult {
  ok: boolean;
  message: string;
  restartRequired?: boolean | undefined;
}

/**
 * Structural view of the session's PreToolUse hook pipeline — satisfied by
 * `HookRunner` without depending on the class. `use` runs the pipeline
 * before a nested `execute()` so policy hooks (path-guard & co.) rule on
 * plugin-tool calls exactly as they would on the direct path.
 */
export interface PluginManagerHookRunner {
  preToolUse(
    toolName: string,
    toolInput: Record<string, unknown>,
    env: { cwd: string; signal?: AbortSignal | undefined },
    toolMeta?: {
      capabilities?: readonly string[] | undefined;
      mutating?: boolean | undefined;
    },
  ): Promise<{
    block?: boolean | undefined;
    reason?: string | undefined;
    input?: Record<string, unknown>;
  }>;
}

export interface CreatePluginManagerToolOptions {
  /** Re-read on every call so config changes made during the session are visible. */
  getConfig: () => Config;
  /** Built-in/official discovery catalog supplied by the host. */
  catalog: readonly PluginManagerCatalogEntry[];
  /** Live registry used to discover and invoke tools registered by loaded plugins. */
  toolRegistry: ToolRegistry;
  /** Persist an enable/disable decision in the host's active config. */
  setEnabled: (plugin: string, enabled: boolean) => Promise<PluginManagerMutationResult>;
  /**
   * Late-bound source for the session's policy-hook runner, resolved on
   * every `use` call. Late-bound because the hook pipeline is wired after
   * the management tools register (same pattern as OneShotOrchestrator's
   * `wrapProviderCall`); optional so minimal hosts and tests without a
   * hook pipeline keep the previous behavior bit-for-bit.
   */
  getHookRunner?: (() => PluginManagerHookRunner | null | undefined) | undefined;
}

interface PluginManagerInput {
  action: 'list' | 'search' | 'describe' | 'enable' | 'disable' | 'use';
  plugin?: string | undefined;
  query?: string | undefined;
  state?: 'all' | 'enabled' | 'disabled' | undefined;
  tool?: string | undefined;
  input?: Record<string, unknown> | undefined;
}

interface PluginToolView {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  permission: 'auto' | 'confirm' | 'deny';
  enabled: boolean;
}

interface PluginView {
  name: string;
  description: string;
  risk: 'low' | 'medium' | 'high' | 'custom';
  enabled: boolean;
  stateSource: 'config' | 'extension' | 'default' | 'feature_flag';
  canDisable: boolean;
  managerControl: 'allowed' | 'locked';
  aliases: string[];
  callableNow: boolean;
  tools: PluginToolView[];
}

const INPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'search', 'describe', 'enable', 'disable', 'use'],
      description:
        'Operation. list: inventory with optional state filter. search: find plugins by need/query. describe: inspect one plugin, managerControl, callableNow, and full tool schemas. enable/disable: persist boot state (often restartRequired). use: inspect or invoke a tool from a plugin already loaded in this session.',
    },
    plugin: {
      type: 'string',
      description:
        'Plugin name or unambiguous alias. Required for describe, enable, disable, and use.',
    },
    query: {
      type: 'string',
      description:
        'Free-text query over plugin names, aliases, descriptions, and registered tool metadata. Required for search.',
    },
    state: {
      type: 'string',
      enum: ['all', 'enabled', 'disabled'],
      description:
        'Optional list/search filter. enabled/disabled means effective boot state, not whether plugin code can be hot-loaded in the current session. Defaults to all.',
    },
    tool: {
      type: 'string',
      description:
        'Registered plugin tool to invoke when action="use". Omit to receive the available tool schemas first.',
    },
    input: {
      type: 'object',
      description:
        'Exact JSON input for the selected plugin tool when action="use". Read the schema returned by describe or use-without-tool first; do not guess fields.',
      properties: {},
      additionalProperties: true,
    },
  },
  required: ['action'],
  additionalProperties: false,
};

const USAGE_HINT = [
  'Always discover before mutating: never enable a guessed plugin name.',
  'Workflow: (1) search with a capability/need query, or list with an optional state filter;',
  '(2) describe the chosen plugin and inspect enabled, managerControl, callableNow, and tools[].inputSchema;',
  '(3) if disabled, enable only when managerControl="allowed"—never work around "locked"; when restartRequired=true, tell the user the plugin cannot be used until WrongStack restarts;',
  '(4) call use with only plugin to refresh/inspect callable tool schemas;',
  '(5) call use again with the exact tool name and schema-valid input.',
  'Examples: search={"action":"search","query":"release notes"}; describe={"action":"describe","plugin":"release-notes-generator"}; inspect-use={"action":"use","plugin":"release-notes-generator"}; invoke-use={"action":"use","plugin":"release-notes-generator","tool":"generate_release_notes","input":{"to":"HEAD"}}.',
  'use works only for tools loaded now. If the result is needs_direct_call, call the returned tool directly so its confirm/deny/destructive policy runs.',
  'disable also normally affects the next boot, not already-loaded code.',
].join(' ');

export function createPluginManagerTool(opts: CreatePluginManagerToolOptions): Tool {
  return {
    name: PLUGIN_MANAGER_TOOL_NAME,
    description:
      'Manage WrongStack plugins through a guarded discovery-first workflow. Search the host catalog, inspect effective state and live plugin-owned tool schemas, persist allowed enable/disable changes, and invoke tools from plugins already loaded in this session. This does not install arbitrary packages or bypass plugin/tool permissions.',
    usageHint: USAGE_HINT,
    selection: {
      doNotUseWhen:
        'installing a new npm package, editing plugin-specific options, changing per-plugin LLM routing, or bypassing a managerControl lock/tool permission',
    },
    category: 'Config',
    inputSchema: INPUT_SCHEMA,
    permission: 'auto',
    mutating: true,
    riskTier: 'standard',
    subjectKey: 'plugin',
    capabilities: [
      ToolCapabilities.TOOL_META,
      ToolCapabilities.TOOL_MUTATE_ANY,
      ToolCapabilities.CONFIG_MUTATE,
    ],
    icon: 'settings',
    validate(input) {
      const value = input as PluginManagerInput;
      const errors: string[] = [];
      if (value.action === 'search' && !value.query?.trim()) {
        errors.push('query is required when action="search"');
      }
      if (
        ['describe', 'enable', 'disable', 'use'].includes(value.action) &&
        !value.plugin?.trim()
      ) {
        errors.push(`plugin is required when action="${value.action}"`);
      }
      if (value.action === 'use' && value.tool && value.input === undefined) {
        errors.push('input is required when action="use" includes a tool');
      }
      return errors;
    },
    async execute(rawInput, ctx, executeOpts) {
      const input = rawInput as PluginManagerInput;
      const views = buildPluginViews(opts);

      if (input.action === 'list' || input.action === 'search') {
        const needle = input.action === 'search' ? input.query!.trim().toLowerCase() : '';
        const state = input.state ?? 'all';
        const matches = views.filter((view) => {
          if (state !== 'all' && view.enabled !== (state === 'enabled')) return false;
          if (!needle) return true;
          const haystack = [
            view.name,
            ...view.aliases,
            view.description,
            ...view.tools.flatMap((tool) => [tool.name, tool.description]),
          ]
            .join('\n')
            .toLowerCase();
          return haystack.includes(needle);
        });
        return {
          status: 'ok',
          action: input.action,
          count: matches.length,
          plugins: matches.map(compactView),
        };
      }

      const resolved = resolvePlugin(input.plugin!, views);
      if ('error' in resolved) return { status: 'error', message: resolved.error };
      const plugin = resolved.plugin;

      if (input.action === 'describe') {
        return { status: 'ok', action: 'describe', plugin };
      }

      if (input.action === 'enable' || input.action === 'disable') {
        const enabled = input.action === 'enable';
        if (plugin.managerControl === 'locked') {
          return {
            status: 'error',
            code: 'plugin_manager_locked',
            message:
              `Plugin "${plugin.name}" is locked against LLM enable/disable changes. ` +
              'Only the user can change it with /plugin or update pluginManager.locked.',
          };
        }
        if (!enabled && !plugin.canDisable) {
          return {
            status: 'error',
            message: `Plugin "${plugin.name}" is locked and cannot be disabled.`,
          };
        }
        if (plugin.enabled === enabled && plugin.stateSource !== 'feature_flag') {
          return {
            status: 'ok',
            action: input.action,
            changed: false,
            restartRequired: false,
            message: `Plugin "${plugin.name}" is already ${enabled ? 'enabled' : 'disabled'}.`,
          };
        }
        const result = await opts.setEnabled(plugin.name, enabled);
        return {
          status: result.ok ? 'ok' : 'error',
          action: input.action,
          changed: result.ok,
          restartRequired: result.restartRequired ?? result.ok,
          message: result.message,
        };
      }

      if (!plugin.enabled) {
        return {
          status: 'error',
          message: `Plugin "${plugin.name}" is disabled. Enable it first; newly enabled plugins become callable after restart.`,
        };
      }
      if (!input.tool) {
        return {
          status: 'ok',
          action: 'use',
          ready: plugin.callableNow,
          message: plugin.callableNow
            ? `Choose one of the loaded tools registered by "${plugin.name}".`
            : `Plugin "${plugin.name}" has no callable tool loaded in this session. It may be hook/command-only or require a restart/configuration.`,
          plugin,
        };
      }

      const selected = plugin.tools.find((tool) => tool.name === input.tool);
      if (!selected) {
        return {
          status: 'error',
          message: `Tool "${input.tool}" is not registered by plugin "${plugin.name}" in this session.`,
          availableTools: plugin.tools.map((tool) => tool.name),
        };
      }
      if (!selected.enabled) {
        return {
          status: 'error',
          message: `Tool "${selected.name}" is registered but disabled by the tool configuration.`,
        };
      }

      const tool = opts.toolRegistry.get(selected.name);
      if (!tool || !ownerMatches(opts.toolRegistry.ownerOf(selected.name), plugin)) {
        return {
          status: 'error',
          message: `Tool "${selected.name}" is no longer available from "${plugin.name}".`,
        };
      }
      if (tool.permission !== 'auto' || tool.riskTier === 'destructive') {
        return {
          status: 'needs_direct_call',
          message:
            `Tool "${tool.name}" requires the normal permission path (${tool.permission}, risk=${tool.riskTier ?? 'standard'}). ` +
            'Call it directly so WrongStack can apply its own approval and policy checks.',
          directCall: { tool: tool.name, input: input.input ?? {}, inputSchema: tool.inputSchema },
        };
      }
      // The executor's pipeline elevates `auto` to `confirm` for tools that
      // declare a dangerous capability (shell, fs.write, config mutation, …)
      // outside YOLO. A nested `execute()` cannot surface that confirm, so
      // the only correct behavior is to send the call back through the
      // direct path where the pipeline can prompt. `getDangerousCapabilities`
      // is the same authority the executor uses (security/capabilities.ts),
      // so the two judgments cannot drift.
      const dangerousCaps = getDangerousCapabilities(tool);
      if (dangerousCaps.length > 0) {
        return {
          status: 'needs_direct_call',
          message:
            `Tool "${tool.name}" declares dangerous capabilities (${dangerousCaps.join(', ')}); ` +
            'the permission pipeline must rule on it. Call it directly.',
          directCall: { tool: tool.name, input: input.input ?? {}, inputSchema: tool.inputSchema },
        };
      }
      // Read-only mode is enforced by `ReadOnlyPermissionPolicy`, which sits on
      // the direct-call path only. `execute()` below is a direct invocation, so
      // without this check a plugin tool at `permission: 'auto'` that mutates
      // would run in a read-only session — the one place the session's hardest
      // guarantee could be walked around. `toolMutates` is imported from the
      // policy rather than restated so the two cannot drift.
      if (ctx.meta['readOnly'] === true && toolMutates(tool)) {
        return {
          status: 'needs_direct_call',
          message:
            `Session is in read-only mode and "${tool.name}" mutates. ` +
            'Call it directly so read-only mode can rule on it.',
          directCall: { tool: tool.name, input: input.input ?? {}, inputSchema: tool.inputSchema },
        };
      }

      let nestedInput = input.input ?? {};
      // Run the session's PreToolUse policy hooks before the nested
      // execute(), mirroring the executor's order (hooks may veto or
      // rewrite the input; validation below runs on whatever they return).
      // Without this, a plugin tool invoked through `use` was the one tool
      // surface no policy hook ever saw.
      const hooks = opts.getHookRunner?.();
      if (hooks) {
        const pre = await hooks.preToolUse(tool.name, nestedInput, ctx, {
          capabilities: tool.capabilities,
          mutating: tool.mutating,
        });
        if (pre.block) {
          return {
            status: 'error',
            message:
              `A policy hook blocked "${tool.name}"` + (pre.reason ? `: ${pre.reason}` : '.'),
          };
        }
        if (pre.input) nestedInput = pre.input;
      }
      const validation = validateAgainstSchema(nestedInput, tool.inputSchema);
      if (!validation.ok) {
        return {
          status: 'error',
          message: `Invalid input for plugin tool "${tool.name}".`,
          errors: validation.errors,
          inputSchema: tool.inputSchema,
        };
      }
      const crossFieldErrors = tool.validate?.(nestedInput) ?? [];
      if (crossFieldErrors.length > 0) {
        return {
          status: 'error',
          message: `Invalid input for plugin tool "${tool.name}".`,
          errors: crossFieldErrors,
          inputSchema: tool.inputSchema,
        };
      }

      const result = await tool.execute(nestedInput, ctx, executeOpts);
      return { status: 'ok', action: 'use', plugin: plugin.name, tool: tool.name, result };
    },
  };
}

function buildPluginViews(opts: CreatePluginManagerToolOptions): PluginView[] {
  const config = opts.getConfig();
  const configured = config.plugins ?? [];
  const catalog = [...opts.catalog];
  const knownNames = new Set(catalog.flatMap((entry) => [entry.name, ...(entry.aliases ?? [])]));

  for (const item of configured) {
    const name = pluginConfigName(item);
    if (!knownNames.has(name)) {
      catalog.push({
        name,
        description: 'User-configured plugin (not present in the built-in discovery catalog).',
        risk: 'medium',
        defaultState: 'inactive',
        canDisable: true,
      });
      knownNames.add(name);
    }
  }

  return catalog
    .map((entry): PluginView => {
      const aliases = [...(entry.aliases ?? [])];
      const names = new Set([entry.name, ...aliases]);
      // Shares one precedence with the loader (cli/wiring/plugins.ts) and
      // `wstack plugin report` — see resolvePluginEnablement. Reading only
      // `config.plugins` here reported a plugin enabled through
      // `extensions.<name>.enabled` as disabled while it was in fact running.
      const { enabled, source } = resolvePluginEnablement({
        name: entry.name,
        aliases,
        defaultState: entry.defaultState,
        config,
        matches: (spec) => names.has(spec),
      });
      const stateSource = PLUGIN_VIEW_STATE_SOURCE[source];
      const tools = pluginTools(opts.toolRegistry, entry.name, aliases);
      const managerControl = isManagerLocked(config, entry.name, aliases) ? 'locked' : 'allowed';
      return {
        name: entry.name,
        description: entry.description,
        risk: entry.risk,
        enabled,
        stateSource,
        canDisable: entry.canDisable,
        managerControl,
        aliases,
        callableNow: enabled && tools.some((tool) => tool.enabled),
        tools,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function isManagerLocked(config: Config, name: string, aliases: readonly string[]): boolean {
  const locked = new Set(
    (config.pluginManager?.locked ?? []).map((entry) => entry.trim().toLowerCase()),
  );
  if (locked.has('*')) return true;
  return [name, ...aliases].some((entry) => locked.has(entry.toLowerCase()));
}

function pluginTools(
  registry: ToolRegistry,
  name: string,
  aliases: readonly string[],
): PluginToolView[] {
  const plugin = { name, aliases };
  const active = registry
    .listWithOwner()
    .filter(({ owner }) => ownerMatches(owner, plugin))
    .map(({ tool }) => toolView(tool, true));
  const disabled = registry
    .listDisabled()
    .filter(({ owner }) => ownerMatches(owner, plugin))
    .map(({ tool }) => toolView(tool, false));
  return [...active, ...disabled].sort((a, b) => a.name.localeCompare(b.name));
}

function toolView(tool: Tool, enabled: boolean): PluginToolView {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    permission: tool.permission,
    enabled,
  };
}

function ownerMatches(
  owner: string | undefined,
  plugin: { name: string; aliases: readonly string[] },
): boolean {
  // undefined owner means no ownership constraint (built-in tool) — allow.
  if (!owner) return true;
  const names = new Set([plugin.name, ...plugin.aliases]);
  const segments = owner.split('+');
  return segments.length > 0 && segments.every((segment) => names.has(segment));
}

function resolvePlugin(
  input: string,
  views: PluginView[],
): { plugin: PluginView } | { error: string } {
  const needle = input.trim().toLowerCase();
  const exact = views.find(
    (view) =>
      view.name.toLowerCase() === needle ||
      view.aliases.some((alias) => alias.toLowerCase() === needle),
  );
  if (exact) return { plugin: exact };
  const partial = views.filter(
    (view) =>
      view.name.toLowerCase().includes(needle) ||
      view.aliases.some((alias) => alias.toLowerCase().includes(needle)),
  );
  if (partial.length === 1) return { plugin: partial[0]! };
  if (partial.length > 1) {
    return {
      error: `Plugin name "${input}" is ambiguous. Matches: ${partial.map((view) => view.name).join(', ')}.`,
    };
  }
  return { error: `Plugin "${input}" was not found. Use plugin_manager search first.` };
}

function compactView(view: PluginView): Omit<PluginView, 'tools'> & { tools: string[] } {
  return { ...view, tools: view.tools.map((tool) => tool.name) };
}

function pluginConfigName(item: string | PluginConfig): string {
  return typeof item === 'string' ? item : item.name;
}
