import type {
  AgentPipelines,
  Config,
  ConfigStore,
  Container,
  EventBus,
  ExtensionRegistry,
  HealthRegistry,
  Logger,
  MetricsSinkView,
  ModelsRegistry,
  Plugin,
  PromptLoader,
  ProviderRegistry,
  SessionWriter,
  SkillLoader,
  SlashCommandRegistry,
  ToolRegistry,
} from '@wrongstack/core';
import { join } from 'node:path';
import { loadPlugins } from '@wrongstack/core';
import type { MCPRegistry } from '@wrongstack/mcp';
import createApi from '../plugin-api-factory.js';
import { patchConfig } from '../utils.js';

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
  hookRegistry?: import('@wrongstack/core').HookRegistry | undefined;
  sessionWriter: SessionWriter;
  metricsSink?: MetricsSinkView | undefined;
  /**
   * Models registry (models.dev-backed catalog of providers, models, and
   * per-token pricing). Forwarded to plugins that need model metadata
   * (cost-tracker, billing reports). Optional — minimal hosts may omit.
   */
  modelsRegistry?: ModelsRegistry | undefined;
  /**
   * Project-level mailbox (GlobalMailbox). Forwarded to plugins that
   * publish to other agents (todo-listener, session-recap). Optional —
   * minimal hosts (tests, the LSP server) may omit.
   */
  mailbox?: import('@wrongstack/core').Mailbox | undefined;
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
    /**
     * Per-project root (`~/.wrongstack/projects/<slug>/`). Plugins that
     * need project-scoped state (todo-tracker, etc.) should put their
     * files here so they follow the same lifecycle as goals/SDD
     * boards/tasks.
     */
    projectDir?: string;
    /** Per-project goal.json path. Useful as a sibling anchor. */
    projectGoal?: string;
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
    const { createPromptsPlugin } = await import('@wrongstack/core');
    return createPromptsPlugin();
  },
  async () => {
    const { createSyncPlugin } = await import('@wrongstack/core');
    return createSyncPlugin();
  },
  async () => {
    const { createGitPlugin } = await import('@wrongstack/core');
    return createGitPlugin();
  },
  async () => {
    const { createObservabilityPlugin } = await import('@wrongstack/core');
    return createObservabilityPlugin();
  },
  async () => {
    const { createSecurityPlugin } = await import('@wrongstack/core');
    return createSecurityPlugin();
  },
  async () => {
    const { createChimeraPlugin } = await import('@wrongstack/core');
    return createChimeraPlugin();
  },
  async () => {
    const { createSkillsPlugin } = await import('@wrongstack/core');
    return createSkillsPlugin();
  },
  async () => {
    const { createPlanPlugin } = await import('@wrongstack/core');
    return createPlanPlugin();
  },
  // ── Workspace plugins (@wrongstack/plugins subpath exports) ──────────
  async () => (await import('@wrongstack/plugins/cost-tracker')).default,
  async () => (await import('@wrongstack/plugins/file-watcher')).default,
  async () => (await import('@wrongstack/plugins/git-autocommit')).default,
  async () => (await import('@wrongstack/plugins/auto-doc')).default,
  async () => (await import('@wrongstack/plugins/shell-check')).default,
  async () => (await import('@wrongstack/plugins/cron')).default,
  async () => (await import('@wrongstack/plugins/template-engine')).default,
  async () => (await import('@wrongstack/plugins/semver-bump')).default,
  async () => (await import('@wrongstack/plugins/secret-scanner')).default,
  async () => (await import('@wrongstack/plugins/todo-tracker')).default,
  async () => (await import('@wrongstack/plugins/token-budget')).default,
  async () => (await import('@wrongstack/plugins/lint-gate')).default,
  async () => (await import('@wrongstack/plugins/branch-guard')).default,
  async () => (await import('@wrongstack/plugins/diff-summary')).default,
  async () => (await import('@wrongstack/plugins/commit-validator')).default,
  async () => (await import('@wrongstack/plugins/format-on-save')).default,
  async () => (await import('@wrongstack/plugins/test-runner-gate')).default,
  async () => (await import('@wrongstack/plugins/import-organizer')).default,
  async () => (await import('@wrongstack/plugins/todo-listener')).default,
  async () => (await import('@wrongstack/plugins/session-recap')).default,
  async () => (await import('@wrongstack/plugins/spec-linker')).default,
  // ── LSP plugin ──────────────────────────────────────────────────────
  async () => (await import('@wrongstack/plug-lsp')).default,
  // ── Telegram plugin ─────────────────────────────────────────────────
  async () => (await import('@wrongstack/telegram')).default,
];

export async function setupPlugins(params: PluginsWiringDeps): Promise<void> {
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
    modelsRegistry,
    mailbox,
    healthRegistry,
    skillLoader,
    promptLoader,
    configStore,
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
  const disabledBuiltins = new Set(
    (config.plugins ?? [])
      .filter(
        (p): p is { name: string; enabled?: boolean | undefined } =>
          typeof p === 'object' && p.enabled === false,
      )
      .map((p) => p.name),
  );
  if (paths && config.features?.plugins !== false) {
    for (const factory of BUILTIN_PLUGIN_FACTORIES) {
      try {
        const plugin = await factory();
        if (!plugin) continue;
        if (disabledBuiltins.has(plugin.name)) {
          log.info(`[setupPlugins] built-in plugin "${plugin.name}" disabled by config`);
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

  // ── 2. Load user plugins from config.plugins ───────────────────────────
  const userPlugins: Plugin[] = [];
  if (config.features?.plugins !== false) {
    for (const p of config.plugins ?? []) {
      if (typeof p === 'object' && p.enabled === false) continue;
      const spec = typeof p === 'string' ? p : p.name;
      // Deprecation policy: if the spec resolves to a deprecated plugin
      // name (either as `'web-search'` or `'@wrongstack/plugins/web-search'`),
      // warn once and skip the dynamic import. Today this means
      // web-search/json-path stub plugins silently load — after the
      // source files are deleted (phase 2), this branch becomes the
      // only line of defense.
      const bareName = pluginNameFromSpec(spec);
      if (bareName && warnIfDeprecatedPluginName(bareName, log)) {
        continue;
      }
      try {
        const mod = (await import(spec)) as { default?: Plugin | undefined };
        if (mod.default) userPlugins.push(mod.default);
      } catch (err) {
        log.warn(`Plugin "${spec}" failed to load`, err);
      }
    }
  }

  // ── 3. Merge: builtins first (they set up infrastructure), then user plugins
  const allPlugins = [...builtinPlugins, ...userPlugins];
  if (allPlugins.length === 0) return;

  const pluginOptions = buildPluginOptions(config);

  // Workspace plugins that persist project-scoped state read ONLY their own
  // namespaced `config.extensions[name]` options — they never see the
  // top-level `paths` injected below. Bridge that gap for todo-tracker by
  // seeding a default `filePath` derived from `paths.projectDir` when the
  // user hasn't set one explicitly. This mirrors how goals/SDD boards/tasks
  // live under `~/.wrongstack/projects/<slug>/` and follows the intent
  // documented on `PluginsWiringDeps.paths.projectDir`.
  if (paths?.projectDir) {
    const todoTrackerOpts = (pluginOptions['todo-tracker'] ??= {});
    if (typeof todoTrackerOpts['filePath'] !== 'string' || todoTrackerOpts['filePath'] === '') {
      todoTrackerOpts['filePath'] = join(paths.projectDir, 'todo-tracker.json');
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
    metricsSink,
    healthRegistry,
    skillLoader,
    promptLoader,
  } as Partial<Config>);

  await loadPlugins(allPlugins, {
    log,
    pluginOptions,
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
}

function buildPluginOptions(config: Config): Record<string, Record<string, unknown>> {
  const options: Record<string, Record<string, unknown>> = {};
  for (const entry of config.plugins ?? []) {
    if (typeof entry !== 'object') continue;
    if (entry.options) options[entry.name] = { ...entry.options };
  }
  for (const [name, value] of Object.entries(config.extensions ?? {})) {
    options[name] = { ...(options[name] ?? {}), ...value };
  }
  return options;
}
