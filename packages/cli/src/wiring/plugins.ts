import { join } from 'node:path';
import type { AgentPipelines } from '@wrongstack/core/agent';
import type { ExtensionRegistry } from '@wrongstack/core/extension';
import type { Container, EventBus } from '@wrongstack/core/kernel';
import type { PluginAPIInit, PluginHostHandle } from '@wrongstack/core/plugin';
import { loadPlugins, resolvePluginConfig, resolvePluginEnablement } from '@wrongstack/core/plugin';
import type {
  ProviderRegistry,
  SlashCommandRegistry,
  ToolRegistry,
} from '@wrongstack/core/registry';
import type {
  Config,
  ConfigStore,
  HealthRegistry,
  Logger,
  MetricsRuntimeStatus,
  MetricsSinkView,
  ModelsRegistry,
  Plugin,
  PromptLoader,
  SessionWriter,
  SkillLoader,
} from '@wrongstack/core/types';
import type { MCPRegistry } from '@wrongstack/mcp';
import { OFFICIAL_PLUGIN_FACTORIES } from '@wrongstack/plugins/factories';
import createApi from '../plugin-api-factory.js';
import { PLUGIN_AUDIT_ENTRIES } from '../plugin-management.js';
import { patchConfig } from '../utils.js';
import { loadExternalPlugins } from './external-plugins.js';

// ---------------------------------------------------------------------------
// Deprecated plugin names — built-ins that have been merged into core
// tools and no longer ship as separate plugins. We no longer auto-import
// these factories, and if a user references one of these names in their
// `config.plugins` we warn once and skip. Removal is split into two
// phases:
//   1. Remove the factory from BUILTIN_PLUGIN_FACTORIES (today).
//   2. Drop the source files + subpath exports + tests from
//      @wrongstack/plugins in a follow-up commit.
// Keeping the source files temporarily (phase 2) means user configs
// that hard-code `@wrongstack/plugins/web-search` as a string spec
// still resolve at runtime — the loader receives a no-op stub plugin
// instead of an import error. Once the user removes the entry from
// their config, the source can be safely deleted.
// ---------------------------------------------------------------------------
export const DEPRECATED_PLUGIN_NAMES: Record<string, string> = {
  'web-search': 'use the built-in `search` and `fetch` tools',
  'json-path': 'use the built-in `json` tool with action: query | validate | transform | merge',
};

// Per-process dedupe so we don't spam the log if a user lists the
// same deprecated name across multiple config entries (object form
// + string form, etc.). Cleared on process restart by design —
// startup noise is fine, mid-session noise is not.
const deprecatedWarningsEmitted = new Set<string>();

const BUILTIN_PLUGIN_CONFIG_ALIASES: Record<string, string> = {
  lsp: '@wrongstack/plug-lsp',
  '@wrongstack/telegram': 'telegram',
};

export const BUILTIN_PLUGIN_CONFIG_NAMES = new Set<string>([
  ...PLUGIN_AUDIT_ENTRIES.map((entry) => entry.name),
  ...PLUGIN_AUDIT_ENTRIES.map((entry) => `@wrongstack/plugins/${entry.name}`),
  ...Object.keys(BUILTIN_PLUGIN_CONFIG_ALIASES),
]);

/** Test helper: reset the dedupe set between test cases. */
export function _resetDeprecatedWarningsForTests(): void {
  deprecatedWarningsEmitted.clear();
}

/**
 * If `name` is in `DEPRECATED_PLUGIN_NAMES`, log a one-shot `warn`
 * describing the migration target and return true (caller should
 * skip the plugin). If the name is deprecated but already warned
 * about, return true WITHOUT logging again — the caller still needs
 * to know to skip the plugin. For unknown names, return false.
 */
export function warnIfDeprecatedPluginName(name: string, log: Logger): boolean {
  const replacement = DEPRECATED_PLUGIN_NAMES[name];
  if (!replacement) return false;
  if (deprecatedWarningsEmitted.has(name)) return true;
  deprecatedWarningsEmitted.add(name);
  log.warn(`[setupPlugins] plugin "${name}" is deprecated and no longer loaded — ${replacement}`);
  return true;
}

/**
 * Normalize a plugin spec (either a short name like `'web-search'` or a
 * fully-qualified import path like `'@wrongstack/plugins/web-search'`)
 * to its bare plugin name. Used to look the spec up in
 * `DEPRECATED_PLUGIN_NAMES` regardless of how the user spelled it.
 *
 * Returns null if the spec is not a string we can normalize (e.g.
 * relative paths, file URLs).
 */
export function pluginNameFromSpec(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('file:')) {
    return null;
  }
  // `@scope/name/sub` → 'name'; `@scope/name` → 'name'; `name/sub` → 'name'.
  const parts = spec.split('/');
  const last = parts[parts.length - 1];
  if (!last) return null;
  return last.split('?')[0] ?? null;
}

export function builtinPluginNameFromSpec(spec: string): string | null {
  if (BUILTIN_PLUGIN_CONFIG_ALIASES[spec]) return BUILTIN_PLUGIN_CONFIG_ALIASES[spec];
  const bareName = pluginNameFromSpec(spec);
  if (BUILTIN_PLUGIN_CONFIG_NAMES.has(spec)) return bareName ?? spec;
  if (bareName && BUILTIN_PLUGIN_CONFIG_NAMES.has(bareName)) return bareName;
  return null;
}

export interface PluginsWiringDeps {
  config: Config;
  container: Container;
  events: EventBus;
  pipelines: AgentPipelines;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  slashCommandRegistry: SlashCommandRegistry;
  mcpRegistry: MCPRegistry;
  log: Logger;
  agent: { extensions?: ExtensionRegistry | undefined };
  /** Lifecycle hook registry — injected so plugins can register in-process hooks. */
  hookRegistry?: import('@wrongstack/core/hooks').HookRegistry | undefined;
  sessionWriter: SessionWriter;
  metricsSink?: MetricsSinkView | undefined;
  metricsStatus?: MetricsRuntimeStatus | undefined;
  /**
   * Models registry (models.dev-backed catalog of providers, models, and
   * per-token pricing). Forwarded to plugins that need model metadata
   * (cost-tracker, billing reports). Optional — minimal hosts may omit.
   */
  modelsRegistry?: ModelsRegistry | undefined;
  /**
   * Project-level mailbox (server-backed). Forwarded to plugins that
   * publish to other agents (todo-listener, session-recap). Optional —
   * minimal hosts (tests, the LSP server) may omit.
   */
  mailbox?: import('@wrongstack/core/coordination').Mailbox | undefined;
  /**
   * Notification router — instantiated as a `NotifierImpl` by the host.
   * Plugins that deliver one-way notifications (Telegram, Slack, webhook)
   * register their `NotificationChannel` with this notifier during setup().
   * Optional — minimal hosts may omit.
   */
  notifier?: import('@wrongstack/core/notifications').Notifier | undefined;
  /**
   * LLM wiring for `api.llm` — the host session's live provider, its
   * default model, and a factory for named-provider overrides. Optional —
   * minimal hosts omit it and plugins see `api.llm === undefined`.
   */
  llm?: PluginAPIInit['llm'];
  /** Health registry — injected so the observability built-in can run /health. */
  healthRegistry?: HealthRegistry | undefined;
  /** Skill loader — injected so the skills built-in can list/read skills. */
  skillLoader?: SkillLoader | undefined;
  /** Prompt loader — injected so the prompts built-in can list/search/save prompts. */
  promptLoader?: PromptLoader | undefined;
  configStore: ConfigStore;
  /** Secret vault — injected so sync plugin can encrypt the GitHub token. */
  vault?: { encrypt(plaintext: string): string; decrypt?(value: string): string };
  /** Resolved WstackPaths — injected so built-in plugins can init stores. */
  paths?: {
    globalRoot: string;
    globalConfig: string;
    globalSkills: string;
    globalPrompts: string;
    globalMemory: string;
    historyFile: string;
    syncConfig: string;
    /** ~/.wrongstack/profiles/<activeProfile> — used by sync plugin for its state path. */
    configDir: string;
    /**
     * Per-project root (`~/.wrongstack/projects/<slug>/`). Plugins that
     * need project-scoped state (todo-tracker, etc.) should put their
     * files here so they follow the same lifecycle as goals/SDD
     * boards/tasks.
     */
    projectDir?: string;
    /** Per-project goal.json path. Useful as a sibling anchor. */
    projectGoal?: string;
    /**
     * The actual code project root (the directory containing
     * `<projectRoot>/.wrongstack/`). Anchors relative `path` entries in
     * `config.plugins` and the project-local plugin discovery root.
     * Optional — minimal hosts may omit it, in which case only
     * config-specifier user plugins load.
     */
    projectRoot?: string;
  };
}

/**
 * Built-in plugins loaded automatically for every WrongStack session.
 * Lazy (dynamic import) so they don't bloat consumers who never use them.
 *
 * Disable a built-in by adding `{ name: 'wstack-prompts', enabled: false }`
 * to config.plugins.
 *
 * Override for tests by mocking this module's `BUILTIN_PLUGIN_FACTORIES`.
 */
export const BUILTIN_PLUGIN_FACTORIES: (() => Promise<Plugin>)[] = [
  async () => {
    const { createPromptsPlugin } = await import('@wrongstack/core/plugin');
    return createPromptsPlugin();
  },
  async () => {
    const { createSyncPlugin } = await import('@wrongstack/core/plugin');
    return createSyncPlugin();
  },
  async () => {
    const { createCloudConfigSyncPlugin } = await import('@wrongstack/core/plugin');
    return createCloudConfigSyncPlugin();
  },
  async () => {
    const { createChimeraPlugin } = await import('@wrongstack/core/plugin');
    return createChimeraPlugin();
  },
  async () => {
    const { createAutoReviewPlugin } = await import('@wrongstack/core/plugin');
    return createAutoReviewPlugin();
  },
  async () => {
    const { createSkillsPlugin } = await import('@wrongstack/core/plugin');
    return createSkillsPlugin();
  },
  // ── Workspace plugins (@wrongstack/plugins subpath exports) ──────────
  ...OFFICIAL_PLUGIN_FACTORIES,
  // ── LSP plugin ──────────────────────────────────────────────────────
  async () => (await import('@wrongstack/plug-lsp')).default,
  // ── Telegram plugin ─────────────────────────────────────────────────
  async () => (await import('@wrongstack/telegram')).default,
];

export async function setupPlugins(
  params: PluginsWiringDeps,
): Promise<PluginHostHandle | undefined> {
  const {
    config,
    container,
    events,
    toolRegistry,
    providerRegistry,
    slashCommandRegistry,
    mcpRegistry,
    log,
    agent,
    sessionWriter,
    metricsSink,
    metricsStatus,
    modelsRegistry,
    mailbox,
    healthRegistry,
    skillLoader,
    promptLoader,
    configStore,
    vault,
    pipelines,
    paths,
    hookRegistry,
  } = params;

  // ── 1. Load built-in plugins (prompts, sync, git, …) only when paths are
  // available — they need WstackPaths to initialise their stores.
  //
  // Built-ins are ENABLED BY DEFAULT. A user can opt a specific one out by
  // adding `{ name: 'wstack-git', enabled: false }` to `config.plugins`
  // (or disable all plugins with `config.features.plugins === false`).
  const builtinPlugins: Plugin[] = [];
  if (paths && config.features?.plugins !== false) {
    for (const factory of BUILTIN_PLUGIN_FACTORIES) {
      try {
        const plugin = await factory();
        if (!plugin) continue;
        const auditEntry = PLUGIN_AUDIT_ENTRIES.find((entry) => entry.name === plugin.name);
        // Enablement precedence lives in ONE place (core/plugin/config.ts) so
        // the loader, `wstack plugin list`, and the plugin_manager tool cannot
        // disagree about what is running. Only the matcher is local: config
        // entries may spell a built-in as `@wrongstack/plugins/<name>` or via
        // an alias (`lsp`, `@wrongstack/telegram`).
        const { enabled, source } = resolvePluginEnablement({
          name: plugin.name,
          aliases: plugin.configAliases,
          // Built-ins outside the audit catalog (prompts, sync, skills, …)
          // are infrastructure — they run unless explicitly turned off.
          defaultState: auditEntry?.defaultState ?? 'active',
          config,
          matches: (spec) => (builtinPluginNameFromSpec(spec) ?? spec) === plugin.name,
        });
        if (!enabled) {
          if (source !== 'default') {
            log.info(`[setupPlugins] built-in plugin "${plugin.name}" disabled by ${source}`);
          }
          continue;
        }
        // Defensive: if a future PR leaves a deprecated factory in
        // BUILTIN_PLUGIN_FACTORIES, the loader-level deprecation policy
        // still skips it (and warns once per name). Today this branch
        // is unreachable because we removed those factories — but the
        // check stays so a sloppy re-add doesn't silently re-enable a
        // retired plugin.
        if (warnIfDeprecatedPluginName(plugin.name, log)) continue;
        builtinPlugins.push(plugin);
      } catch (err) {
        log.warn('[setupPlugins] builtin plugin failed to load:', err);
      }
    }
  }

  // ── 2. Load external (third-party) plugins ─────────────────────────────
  // config.plugins specifiers AND explicit `path` entries, plus directory
  // discovery under `<globalRoot>/plugins` and `<projectRoot>/.wrongstack/
  // plugins`. Every external plugin passes a pre-import TOFU trust gate and
  // a shape/spoof check — see wiring/external-plugins.ts for the pipeline.
  const userPlugins: Plugin[] =
    config.features?.plugins === false
      ? []
      : await loadExternalPlugins(
          {
            config,
            log,
            globalRoot: paths?.globalRoot,
            projectRoot: paths?.projectRoot ?? process.cwd(),
            reservedNames: new Set<string>([
              ...BUILTIN_PLUGIN_CONFIG_NAMES,
              ...builtinPlugins.map((p) => p.name),
            ]),
          },
          {
            nameFromSpec: pluginNameFromSpec,
            isBuiltinSpec: (spec) => builtinPluginNameFromSpec(spec) !== null,
            warnIfDeprecated: (name) =>
              name !== '' && warnIfDeprecatedPluginName(name, log),
          },
        );

  // ── 3. Merge: builtins first (they set up infrastructure), then user plugins
  const allPlugins = [...builtinPlugins, ...userPlugins];
  if (allPlugins.length === 0) return;

  const pluginOptions = buildPluginOptions(config, allPlugins);

  // Workspace plugins that persist project-scoped state read ONLY their own
  // namespaced `config.extensions[name]` options — they never see the
  // top-level `paths` injected below. Bridge that gap for todo-tracker by
  // seeding a default `filePath` derived from `paths.projectDir` when the
  // user hasn't set one explicitly. This mirrors how goals/SDD boards/tasks
  // live under `~/.wrongstack/projects/<slug>/` and follows the intent
  // documented on `PluginsWiringDeps.paths.projectDir`.
  if (paths?.projectDir) {
    if (pluginOptions['todo-tracker'] === undefined) {
      pluginOptions['todo-tracker'] = {};
    }
    const todoTrackerOpts = pluginOptions['todo-tracker'];
    if (typeof todoTrackerOpts['filePath'] !== 'string' || todoTrackerOpts['filePath'] === '') {
      todoTrackerOpts['filePath'] = join(paths.projectDir, 'todo-tracker.json');
    }
    // context-pins persists pinned facts the same way — project-scoped,
    // next to goals/SDD boards/todo-tracker.
    const contextPinsOpts = pluginOptions['context-pins'] ?? {};
    pluginOptions['context-pins'] = contextPinsOpts;
    if (typeof contextPinsOpts['filePath'] !== 'string' || contextPinsOpts['filePath'] === '') {
      contextPinsOpts['filePath'] = join(paths.projectDir, 'context-pins.json');
    }
  }

  // Built-in plugins read their host dependencies off the TOP LEVEL of the
  // config object they receive (e.g. prompts/sync use `config.paths` /
  // `config.configStore`, observability uses `config.metricsSink` /
  // `config.healthRegistry`). Inject them here so each can wire up its store or
  // view without a circular import. User plugins never see these — they only
  // read their own namespaced `config.extensions[name]` options.
  const pluginConfig = patchConfig(config, {
    extensions: pluginOptions,
    paths,
    configStore,
    vault,
    metricsSink,
    metricsStatus,
    healthRegistry,
    skillLoader,
    promptLoader,
  } as Partial<Config>);

  const pluginHost = await loadPlugins(allPlugins, {
    log,
    pluginOptions,
    // First-party plugins keep the historical warn-only capability checks;
    // external (third-party) plugins are held to their declared
    // capabilities strictly — an undeclared API call rejects the plugin.
    enforceCapabilities: (plugin) => !builtinPlugins.includes(plugin),
    apiFactory: (plugin) =>
      createApi(plugin.name, {
        // First-party plugins come from BUILTIN_PLUGIN_FACTORIES — trust them
        // ("official") so they can claim bare slash command names (/prompts,
        // /sync) and override built-ins. User plugins stay namespaced.
        official: builtinPlugins.includes(plugin),
        container,
        events,
        pipelines: pipelines as never as Parameters<typeof createApi>[1]['pipelines'],
        toolRegistry,
        providerRegistry,
        slashCommandRegistry,
        mcpRegistry,
        config: pluginConfig,
        log,
        extensions: agent.extensions,
        hookRegistry,
        modelsRegistry,
        mailbox,
        notifier: params.notifier,
        llm: params.llm,
        sessionWriter: {
          transcriptPath: sessionWriter.transcriptPath,
          append: (e: Record<string, unknown> & { type: string; ts: string }) =>
            sessionWriter.append(e as Parameters<typeof sessionWriter.append>[0]),
        },
        metricsSink,
        configStore,
      }),
  });

  log.info(
    `[setupPlugins] loaded ${builtinPlugins.length} built-in, ${userPlugins.length} user plugin(s)`,
  );
  return pluginHost;
}

function buildPluginOptions(
  config: Config,
  plugins: readonly Plugin[],
): Record<string, Record<string, unknown>> {
  const options: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(config.extensions ?? {})) {
    options[name] = { ...value };
  }
  for (const plugin of plugins) {
    const resolved = resolvePluginConfig({
      name: plugin.name,
      aliases: plugin.configAliases,
      config,
    });
    if (resolved.configured) options[plugin.name] = resolved.options;
  }
  return options;
}
