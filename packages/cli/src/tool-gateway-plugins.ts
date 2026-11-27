/**
 * Official plugin tools for one-shot `wstack tools list | describe | run | batch`.
 *
 * The tools subcommand used to serve built-in tools only, so an enabled
 * plugin's tools (change_risk_analyze, monorepo_change_plan, …) were "Unknown
 * tool" outside an agent session. This loads the plugins whose tools work in a
 * fresh process, with the same enablement decision `setupPlugins` makes, the
 * CLI plugin API factory and the core loader (config validation, capability
 * checks), and disposes them when the gateway closes.
 *
 * Only plugins listed in {@link ONE_SHOT_PLUGINS} are loaded. Every other
 * official plugin either works through hooks that never fire without an agent
 * loop, or answers from process/session state that a new process does not
 * have (`*_status` counters, checkpoints, the verification ledger, file
 * watchers) — exposing those would read "nothing recorded" as a clean result.
 * `wstack mcp serve` is deliberately unchanged.
 */
import type { Config, Logger, Plugin, Tool } from '@wrongstack/contracts/types';
import { HookRegistry } from '@wrongstack/core/hooks';
import { DefaultPluginAPI, loadPlugins, type PluginHostHandle } from '@wrongstack/core/plugin';
import type { ToolRegistry } from '@wrongstack/core/registry';
import {
  OFFICIAL_PLUGIN_FACTORIES,
  OFFICIAL_PLUGIN_SPECIFIERS,
} from '@wrongstack/plugins/factories';
import { buildPluginOptions, builtinEnablement } from '@wrongstack/runtime/plugin-host';

/**
 * Official plugins whose tools are stateless per call: the evidence analyzers
 * (they read the project or supplied evidence) and the on-demand workflows.
 * Excluded workflows keep session-local state: `verification-ledger` (records
 * live in the process) and `generated-artifact-tracker` (baseline per session).
 */
const ONE_SHOT_PLUGINS: readonly string[] = [
  // Evidence analyzers
  'workspace-health',
  'test-impact-analyzer',
  'ci-failure-triage',
  'env-contract-guard',
  'dependency-drift-detector',
  'release-readiness',
  'bundle-budget-guard',
  'public-api-auditor',
  'lockfile-consistency-guard',
  'change-risk-classifier',
  // On-demand workflows
  'bug-reproducer',
  'acceptance-verifier',
  'runtime-trace-explorer',
  'workspace-recipe-runner',
  'architecture-boundary-checker',
  'monorepo-change-planner',
  'config-migration-assistant',
  'feature-flag-lifecycle',
  'api-consumer-replay',
  'migration-rehearsal',
  'failure-injection-lab',
  'concurrency-scenario-tester',
  'resource-lifecycle-inspector',
  'visual-regression-reviewer',
  'responsive-journey-tester',
  'localization-completeness',
  'executable-documentation',
  'dependency-upgrade-sandbox',
  'developer-environment-doctor',
  'service-topology-inspector',
  'decision-journal',
  'plugin-workbench',
];

const SPECIFIER_PREFIX = '@wrongstack/plugins/';

function factoryFor(name: string): (() => Promise<Plugin>) | undefined {
  const index = OFFICIAL_PLUGIN_SPECIFIERS.indexOf(
    `${SPECIFIER_PREFIX}${name}` as (typeof OFFICIAL_PLUGIN_SPECIFIERS)[number],
  );
  return index >= 0 ? OFFICIAL_PLUGIN_FACTORIES[index] : undefined;
}

const silentLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLog;
  },
} as unknown as Logger;

export interface GatewayPlugins {
  /** Plugin names whose tools were registered. */
  loaded: string[];
  /** Plugins that failed to load, with the loader's reason. */
  failed: Array<{ name: string; reason: string }>;
  dispose(): Promise<void>;
}

/**
 * Load the enabled one-shot plugins into `registry`. Never throws for a
 * plugin failure: a broken plugin is reported through `onWarning` and the
 * built-in tools stay usable.
 */
export async function loadGatewayPlugins(options: {
  registry: ToolRegistry;
  config: Config;
  onWarning?: ((message: string) => void) | undefined;
}): Promise<GatewayPlugins> {
  const { registry, config } = options;
  if (config.features?.plugins === false) {
    return { loaded: [], failed: [], dispose: async () => {} };
  }
  const plugins: Plugin[] = [];
  for (const name of ONE_SHOT_PLUGINS) {
    if (!builtinEnablement(name, config).enabled) continue;
    const factory = factoryFor(name);
    if (factory) plugins.push(await factory());
  }
  if (plugins.length === 0) return { loaded: [], failed: [], dispose: async () => {} };
  const pluginOptions = buildPluginOptions(config, plugins);
  const pluginConfig = Object.freeze({ ...config, extensions: pluginOptions }) as Config;
  const hookRegistry = new HookRegistry();
  const host: PluginHostHandle = await loadPlugins(plugins, {
    log: silentLog,
    pluginOptions,
    apiFactory: (plugin) =>
      new DefaultPluginAPI({
        ownerName: plugin.name,
        official: true,
        capabilities: plugin.capabilities,
        toolRegistry: registry,
        pipelines: {} as never,
        hookRegistry,
        config: pluginConfig,
        log: silentLog,
      } as never),
  });
  const failed = host.failed.map((failure) => ({
    name: failure.plugin.name,
    reason: failure.err instanceof Error ? failure.err.message : String(failure.err),
  }));
  for (const failure of failed) {
    options.onWarning?.(`plugin "${failure.name}" did not load: ${failure.reason}`);
  }
  return {
    loaded: host.loaded.map((plugin) => plugin.name),
    failed,
    dispose: () => host.dispose(),
  };
}

/**
 * The one-shot plugin that registers `toolName`, when it is not enabled.
 * Used only on the unknown-tool path, so an "Unknown tool" for a plugin tool
 * can say which plugin to enable. Each candidate's setup runs against a
 * capture-only API and is torn down at once.
 */
export async function disabledPluginForTool(
  toolName: string,
  config: Config,
): Promise<string | undefined> {
  for (const name of ONE_SHOT_PLUGINS) {
    if (builtinEnablement(name, config).enabled) continue;
    const factory = factoryFor(name);
    if (!factory) continue;
    const plugin = await factory();
    const names: string[] = [];
    const api = {
      config: { extensions: {} },
      log: silentLog,
      tools: { register: (tool: Tool) => void names.push(tool.name) },
    };
    try {
      await plugin.setup(api as never);
      await plugin.teardown?.(api as never);
    } catch {
      continue;
    }
    if (names.includes(toolName)) return name;
  }
  return undefined;
}
