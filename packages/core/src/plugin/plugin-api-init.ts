import type { Container } from '@wrongstack/contracts/kernel/container';
import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { Config } from '@wrongstack/contracts/types/config';
import type { CouncilQuestion, CouncilResult } from '@wrongstack/contracts/types/council';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { Mailbox } from '@wrongstack/contracts/types/mailbox';
import type { ModelsRegistry } from '@wrongstack/contracts/types/models-registry';
import type { OneShotLLMInput, OneShotLLMResult } from '@wrongstack/contracts/types/one-shot-llm';
import type {
  MCPRegistryView,
  MetricsSinkView,
  Notifier,
  PluginCapabilities,
  PluginPipelines,
  SessionWriterView,
} from '@wrongstack/contracts/types/plugin';
import type { Provider } from '@wrongstack/contracts/types/provider';
import type { ExtensionRegistry } from '../extension/registry.js';
import type { HookRegistry } from '../hooks/registry.js';
import type { ProviderAuthRegistry } from '../registry/provider-auth-registry.js';
import type { ProviderRegistry } from '../registry/provider-registry.js';
import type { SlashCommandRegistry } from '../registry/slash-command-registry.js';
import type { ToolRegistry } from '../registry/tool-registry.js';

export interface PluginAPIInit {
  ownerName: string;
  container: Container;
  events: EventBus;
  /**
   * The agent's concrete pipelines. `DefaultPluginAPI` converts each to a
   * `ReadonlyPipeline` before exposing them to the plugin — plugins can
   * inspect and invoke pipelines but cannot mutate them.
   */
  pipelines: PluginPipelines;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  /** Shared interactive-auth registry. Production hosts pass one instance to every surface. */
  providerAuthRegistry?: ProviderAuthRegistry | undefined;
  slashCommandRegistry?: SlashCommandRegistry | undefined;
  mcpRegistry?: MCPRegistryView | undefined;
  /**
   * The agent's extension registry. Plugins register AgentExtension
   * instances here to hook into agent lifecycle events.
   */
  extensions?: ExtensionRegistry | undefined;
  /**
   * The host's lifecycle hook registry. When provided, `api.registerHook`
   * adds in-process hooks here. When absent, `registerHook` is a noop.
   */
  hookRegistry?: HookRegistry | undefined;
  /**
   * The active session writer. Plugins append custom events here.
   * When not provided, a noop writer is used.
   */
  sessionWriter?: SessionWriterView | undefined;
  /**
   * The host's metrics sink. When set, the plugin gets a scoped view
   * that auto-prefixes metric names with `plugin.<pluginName>.`.
   * When not provided, a noop sink is used.
   */
  metricsSink?: MetricsSinkView | undefined;
  /**
   * The host's models registry (models.dev-backed catalog of providers,
   * models, and per-token pricing). When provided, plugins that need
   * model metadata (cost-tracker, billing reports) can query it instead
   * of relying on bundled tables. Optional — minimal hosts/tests may
   * omit it.
   */
  modelsRegistry?: ModelsRegistry | undefined;
  /**
   * The host's project-level mailbox. When provided, plugins that publish
   * to other agents (todo-listener, session-recap) can call `api.mailbox.send`.
   * When not provided, those plugins should gracefully no-op.
   */
  mailbox?: Mailbox | undefined;
  /**
   * Notification router for one-way channel delivery. Plugins that
   * implement `NotificationChannel` register their channel here during
   * `setup()`. Optional — minimal hosts/tests may omit it.
   */
  notifier?: Notifier | undefined;
  /**
   * LLM wiring for `api.llm`. When provided, `DefaultPluginAPI` exposes a
   * `PluginLLM` that routes completions through the host's provider layer:
   *
   *  - `provider` — the host session's live default Provider instance
   *  - `model`    — the host session's default model id
   *  - `createProvider` — optional factory used when a plugin requests a
   *    DIFFERENT provider by name (per-call `opts.provider` or the plugin's
   *    `config.extensions[<name>].llm.provider`). The CLI host passes an
   *    implementation backed by the provider registry + saved provider
   *    configs; when absent, `DefaultPluginAPI` falls back to
   *    `providerRegistry.create({ ...config.providers[name], type: name })`.
   *
   * Omit entirely on minimal hosts — `api.llm` stays undefined and plugins
   * must guard.
   */
  llm?:
    | {
        provider: Provider;
        model: string;
        getProvider?: (() => Provider) | undefined;
        getModel?: (() => string) | undefined;
        createProvider?: ((name: string, model?: string) => Provider) | undefined;
        /** Preferred production path: shared One Shot runtime with fallbacks. */
        oneShot?: ((input: OneShotLLMInput) => Promise<OneShotLLMResult>) | undefined;
        /** Optional shared multi-model Council runtime. */
        council?: ((question: CouncilQuestion) => Promise<CouncilResult>) | undefined;
      }
    | undefined;
  config: Config;
  /**
   * The host's ConfigStore. Used to wire `api.onConfigChange()`.
   * When not provided, `onConfigChange` is a noop.
   */
  configStore?: { watch(cb: (next: unknown, prev: unknown) => void): () => void };
  log: Logger;
  /**
   * Whether this plugin is first-party ("official"). Set by the host based on
   * the plugin's load source (e.g. shipped in the built-in factory list), NOT
   * self-declared by the plugin. Official plugins may register bare slash
   * command names and override built-ins; external plugins are namespaced.
   * Defaults to false.
   */
  official?: boolean | undefined;
  /**
   * Declared capabilities of the plugin. Used for capability-based
   * authorization checks (e.g. tool mutation permissions).
   */
  capabilities?: PluginCapabilities | undefined;
}
