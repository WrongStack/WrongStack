import type { Container } from '@wrongstack/contracts/kernel/container';
import type { EventBus, EventName, Listener } from '@wrongstack/contracts/kernel/events';
import type { Pipeline } from '@wrongstack/contracts/kernel/pipeline';
import type { Config } from '@wrongstack/contracts/types/config';
import type { HookEvent, HookMatcher, InProcessHook } from '@wrongstack/contracts/types/hooks';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { Mailbox } from '@wrongstack/contracts/types/mailbox';
import type { ModelsRegistry } from '@wrongstack/contracts/types/models-registry';
import type {
  MCPRegistryView,
  MetricsSinkView,
  Notifier,
  PluginAPI,
  PluginCapabilities,
  PluginDependency,
  PluginJev,
  PluginLLM,
  PluginPipelines,
  ProviderAuthRegistryView,
  ProviderFactory,
  ProviderRegistryView,
  SessionWriterView,
  SlashCommandRegistryView,
  ToolRegistryView,
} from '@wrongstack/contracts/types/plugin';
import type { SystemPromptContributor } from '@wrongstack/contracts/types/system-prompt-contributor';
import type { JSONSchema, Tool } from '@wrongstack/contracts/types/tool';
import { ExtensionRegistry } from '../extension/registry.js';
import type { HookRegistry } from '../hooks/registry.js';
import { ProviderAuthRegistry } from '../registry/provider-auth-registry.js';
import type { ToolWrapper } from '../registry/tool-registry.js';
import { KERNEL_API_VERSION } from './loader.js';
import type { PluginAPIInit } from './plugin-api-init.js';
import { makePluginJev } from './plugin-jev.js';
import { makePluginLLM } from './plugin-llm.js';

export type { PluginAPIInit } from './plugin-api-init.js';

export class DefaultPluginAPI implements PluginAPI {
  readonly container: Container;
  readonly events: EventBus;
  readonly pipelines: PluginPipelines;
  readonly tools: ToolRegistryView;
  readonly providers: ProviderRegistryView;
  readonly providerAuth: ProviderAuthRegistryView;
  readonly mcp: MCPRegistryView;
  readonly slashCommands: SlashCommandRegistryView;
  readonly extensions: ExtensionRegistry;
  readonly session: SessionWriterView;
  readonly metrics: MetricsSinkView;
  readonly config: Config;
  readonly log: Logger;
  readonly modelsRegistry: ModelsRegistry | undefined;
  readonly mailbox: Mailbox | undefined;
  readonly notifier: Notifier | undefined;
  readonly llm: PluginLLM | undefined;
  readonly jev: PluginJev | undefined;
  private readonly lifetime = new AbortController();
  private readonly configStore:
    | { watch(cb: (next: unknown, prev: unknown) => void): () => void }
    | undefined;
  private readonly hookRegistry: HookRegistry | undefined;
  private readonly ownerName: string;
  private readonly pluginCleanupFns: Array<() => void> = [];

  constructor(init: PluginAPIInit) {
    const owner = init.ownerName;
    this.ownerName = owner;
    this.hookRegistry = init.hookRegistry;
    this.container = init.container;
    this.events = init.events;
    this.config = init.config;
    this.configStore = init.configStore;
    this.log = init.log.child({ plugin: owner });
    const extensions = init.extensions ?? new ExtensionRegistry();
    this.extensions = new Proxy(extensions, {
      get: (target, key) => {
        if (
          key === 'register' ||
          key === 'registerOrReplace' ||
          key === 'registerOrReplaceScoped'
        ) {
          return (extension: Parameters<ExtensionRegistry['register']>[0]) => {
            this.assertActive();
            return this.ownRegistration(
              key === 'register'
                ? target.register(extension)
                : target.registerOrReplaceScoped(extension),
            );
          };
        }
        if (key === 'registerSystemPromptContributor') {
          return (contributor: SystemPromptContributor) => {
            this.assertActive();
            const guarded = Object.assign(
              async (context: Parameters<SystemPromptContributor>[0]) => {
                if (this.lifetime.signal.aborted) return [];
                const blocks = await contributor(context);
                return this.lifetime.signal.aborted ? [] : blocks;
              },
              contributor,
            );
            return this.ownRegistration(target.registerSystemPromptContributor(guarded));
          };
        }
        if (key === 'unregister') {
          return (name: string) => {
            this.assertActive();
            return target.unregister(name);
          };
        }
        if (key === 'clear') {
          return () => {
            this.assertActive();
            target.clear();
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    this.session = init.sessionWriter ?? noopSession;
    this.metrics = init.metricsSink ? scopedMetrics(init.metricsSink, owner) : noopMetrics;
    this.modelsRegistry = init.modelsRegistry;
    this.mailbox = init.mailbox;
    this.notifier = init.notifier;
    // Live view of config.extensions: `/plugin llm <name> …` updates flow
    // through ConfigStore.update(), and api.llm should honour the new
    // per-plugin override WITHOUT a restart. When no ConfigStore is wired
    // (minimal hosts), the setup-time snapshot stands.
    let liveConfig: Config | undefined;
    if (init.configStore) {
      const off = init.configStore.watch((next) => {
        const n = next as Config | undefined;
        if (n && typeof n === 'object') liveConfig = n;
      });
      this.pluginCleanupFns.push(off);
    }
    this.llm = init.llm
      ? makePluginLLM(
          owner,
          init.llm,
          init.providerRegistry,
          init.config,
          () => liveConfig,
          this.metrics,
          this.log,
        )
      : undefined;
    this.jev = init.official
      ? makePluginJev(
          owner,
          () => liveConfig ?? init.config,
          this.metrics,
          () =>
            init.toolRegistry.isDisabled('jev') ||
            init.toolRegistry.isRestricted('jev') ||
            (liveConfig ?? init.config).tools?.disabledTools?.includes('jev') === true,
          this.lifetime.signal,
        )
      : undefined;

    // Convert concrete pipelines to read-only views before passing to plugins.
    const pipelines = init.pipelines as never as Record<string, Pipeline<unknown>>;
    const readonlyPipelines: PluginPipelines = {} as PluginPipelines;
    for (const [key, pipeline] of Object.entries(pipelines)) {
      readonlyPipelines[key] = pipeline.asReadonly() as PluginPipelines[typeof key];
    }
    this.pipelines = readonlyPipelines;

    const tr = init.toolRegistry;
    const isOfficial = init.official === true;
    const capabilities = init.capabilities;
    // "core" is the registries' owner for built-ins: the tool registry's
    // `--restricted` exemption and the slash registry's built-in tier both key
    // on it. A plugin's owner is its self-chosen name, so a non-official plugin
    // may not register anything as "core".
    const assertNotCoreOwner = (kind: string, name: string): void => {
      if (!isOfficial && owner === 'core') {
        throw new Error(
          `Plugin "${owner}" may not register ${kind} "${name}" — "core" is reserved for built-ins.`,
        );
      }
    };
    // Trust tiers for the tool registry, mirroring the slash-command registry:
    // only first-party ("official") plugins (and core) may mutate a tool they
    // do not own. An external plugin can register, wrap, and unregister its OWN
    // tools, but must not silently downgrade a built-in's `permission` via
    // `wrap`, nor `unregister` another owner's safeguard. Officiality is set by
    // the host from the load source — never self-declared. (`register` is
    // already collision-safe: it throws on a duplicate name, so an external
    // plugin cannot shadow a built-in by re-registering it.)
    // Tool names this plugin itself registered. The owner string alone cannot
    // prove ownership: it is the plugin's self-chosen name, and the registry
    // owns built-ins as "core", Sage tools as "sage" and MCP tools as
    // "mcp:<server>" — a plugin named after one of those would own them all.
    const toolNamesIRegistered = new Set<string>();
    const assertCanMutateTool = (name: string, op: string): void => {
      if (isOfficial) return;
      const currentOwner = tr.ownerOf(name);
      // undefined: tool doesn't exist — let the downstream call no-op/throw.
      if (currentOwner === undefined) return;
      // `wrap` records a chain owner like "core+plugin"; a tool this plugin
      // solely registered and (re)wrapped is "plugin" or "plugin+plugin".
      // The plugin owns the tool only if EVERY segment is itself — so a core
      // tool ("core") or one another plugin touched ("core+plugin") is denied.
      const ownedSolelyByMe =
        toolNamesIRegistered.has(name) && currentOwner.split('+').every((seg) => seg === owner);
      if (ownedSolelyByMe) return;

      // 2026-06-13: Capability-based mutation check for non-official plugins
      // that don't own the tool. If the plugin declares toolMutateCapabilities
      // matching the tool's capabilities, allow the mutation.
      const toolCaps = tr.get(name)?.capabilities ?? [];
      const pluginMutateCaps = capabilities?.toolMutateCapabilities ?? [];
      const hasRequiredCap = toolCaps.some((c) => pluginMutateCaps.includes(c));

      if (!hasRequiredCap) {
        throw new Error(
          `Plugin "${owner}" may not ${op} tool "${name}" — it is owned by "${currentOwner}". ` +
            `Tool capabilities: [${toolCaps.join(', ') || 'none'}]. ` +
            `Plugin toolMutateCapabilities: [${pluginMutateCaps.join(', ') || 'none'}]. ` +
            `Missing required capability to mutate this tool.`,
        );
      }
    };
    this.tools = {
      register: (t: Tool) => {
        this.assertActive();
        assertNotCoreOwner('tool', t.name);
        this.ownRegistration(tr.registerScoped(t, owner));
        toolNamesIRegistered.add(t.name);
        // When a host restricts the direct provider surface (token-saving
        // tiers, `features.tokenSavingMode !== 'off'`), plugin-registered
        // tools must still reach the LLM — otherwise plugins load and their
        // hooks fire, but the model can never invoke their tools because
        // `listForProvider()` only returns the restricted name set.
        // `exposeToProvider` is a no-op when the surface is unrestricted
        // (tier "off"), so this line costs nothing on full-surface hosts.
        tr.exposeToProvider(t.name);
      },
      unregister: (name: string) => {
        this.assertActive();
        assertCanMutateTool(name, 'unregister');
        toolNamesIRegistered.delete(name);
        return tr.unregister(name);
      },
      wrap: (name: string, wrapper: ToolWrapper) => {
        this.assertActive();
        assertCanMutateTool(name, 'wrap');
        this.ownRegistration(tr.wrapScoped(name, wrapper, owner));
      },
      get: (name: string) => tr.get(name),
      list: () => tr.list(),
    };

    const pr = init.providerRegistry;

    // Provider types this plugin itself introduced. `ProviderRegistry` does not
    // track ownership (its `register` is a documented replace, which `registerAll`
    // and the CLI flags rely on), so ownership is tracked here at the untrusted
    // boundary instead.
    const providerTypesIOwn = new Set<string>();

    // The tools surface has `assertCanMutateTool`; providers had no equivalent,
    // even though the blast radius is larger. `pr.register` is a silent
    // `Map.set`, so an external plugin could call
    // `providers.register({type: 'anthropic', ...})` and put every prompt, every
    // API key, and every model response — which in turn drives tool execution —
    // through its own factory. Replacing a provider you did not introduce now
    // requires being an official (first-party) plugin.
    const assertCanMutateProvider = (type: string, op: string): void => {
      if (isOfficial) return;
      if (providerTypesIOwn.has(type)) return;
      if (!pr.has(type)) return; // introducing a new type is fine
      throw new Error(
        `Plugin "${owner}" may not ${op} provider "${type}" — it was not registered by this plugin. ` +
          `Replacing an existing provider would route prompts and credentials through plugin code.`,
      );
    };

    this.providers = {
      register: (f: ProviderFactory) => {
        this.assertActive();
        assertCanMutateProvider(f.type, 'replace');
        this.ownRegistration(pr.registerScoped(f));
        providerTypesIOwn.add(f.type);
      },
      unregister: (type: string) => {
        this.assertActive();
        assertCanMutateProvider(type, 'unregister');
        providerTypesIOwn.delete(type);
        return pr.unregister(type);
      },
      create: (cfg) => pr.create(cfg as { type: string }),
      list: () => pr.list(),
    };

    const authRegistry = init.providerAuthRegistry ?? new ProviderAuthRegistry();
    const authStrategiesIOwn = new Set<string>();
    const assertCanMutateProviderAuth = (id: string, op: string): void => {
      if (isOfficial) return;
      const resolved = authRegistry.resolveId(id);
      if (!resolved) return;
      if (authStrategiesIOwn.has(resolved)) return;
      throw new Error(
        `Plugin "${owner}" may not ${op} provider auth strategy "${id}" — it was not registered by this plugin. ` +
          'Replacing an existing login strategy could intercept provider credentials.',
      );
    };
    this.providerAuth = {
      register: (strategy) => {
        this.assertActive();
        assertCanMutateProviderAuth(strategy.id, 'replace');
        this.ownRegistration(authRegistry.registerScoped(strategy));
        authStrategiesIOwn.add(strategy.id.trim().toLowerCase());
      },
      unregister: (id) => {
        this.assertActive();
        assertCanMutateProviderAuth(id, 'unregister');
        const resolved = authRegistry.resolveId(id);
        if (resolved) authStrategiesIOwn.delete(resolved);
        return authRegistry.unregister(id);
      },
      list: () => authRegistry.list(),
    };

    // MCP servers this plugin started.
    //
    // Scope note, so this is not mistaken for more than it is: an external
    // plugin is in-process Node code and can spawn a child process directly, so
    // gating `start` would not be a security boundary. What this DOES prevent is
    // one plugin reaching across and stopping, restarting or re-targeting a
    // server another plugin (or the host) owns — an in-architecture action with no equivalent
    // outside the API, and the same shape already guarded on `tools`,
    // `providers` and `slashCommands`.
    const mcpRegistry = init.mcpRegistry;
    if (!mcpRegistry) {
      this.mcp = noopMcp;
    } else {
      const mcpServersIStarted = new Set<string>();
      const assertOwnsMcpServer = (name: string, op: string): void => {
        if (isOfficial) return;
        if (mcpServersIStarted.has(name)) return;
        if (!mcpRegistry.list().some((s) => s.name === name)) return; // unknown → let it no-op
        throw new Error(
          `Plugin "${owner}" may not ${op} MCP server "${name}" — it was not started by this plugin.`,
        );
      };
      this.mcp = {
        start: async (cfg: unknown) => {
          const name = (cfg as { name?: unknown } | null)?.name;
          // A start() naming an EXISTING server is not a registration: with
          // `enabled: false` MCPRegistry.start() stops that slot BEFORE any
          // duplicate-name validation, and otherwise the duplicate check
          // rejects it. Both act on a server this plugin may not own, so they
          // go through the same ownership check as stop/restart. Fresh names
          // skip the check — registering new servers is the tool's purpose.
          if (typeof name === 'string' && mcpRegistry.list().some((s) => s.name === name)) {
            assertOwnsMcpServer(name, 'start');
          }
          await mcpRegistry.start(cfg);
          if (typeof name === 'string') mcpServersIStarted.add(name);
        },
        stop: async (name: string) => {
          assertOwnsMcpServer(name, 'stop');
          // Ownership is NOT released here: MCPRegistry.stop() retains the
          // slot (state 'disconnected', still listed), and a later start()
          // with the same name is rejected as a duplicate — releasing the
          // claim would permanently lock this plugin out of restarting its
          // own server while granting nobody else the ability to take over.
          await mcpRegistry.stop(name);
        },
        restart: async (name: string) => {
          assertOwnsMcpServer(name, 'restart');
          await mcpRegistry.restart(name);
        },
        list: () => mcpRegistry.list(),
      };
    }

    const scr = init.slashCommandRegistry;
    const official = init.official === true;
    // Commands this plugin registered. `register` is owner-tagged, but
    // `unregister` takes only a name and deletes every key pointing at that
    // command — so without this an external plugin could remove another
    // plugin's command, or an official/built-in one, and silently substitute
    // its own.
    const commandsIOwn = new Set<string>();

    this.slashCommands = scr
      ? {
          register: (cmd, opts) => {
            this.assertActive();
            assertNotCoreOwner('slash command', cmd.name);
            this.ownRegistration(scr.registerScoped(cmd, owner, { official, bare: opts?.bare }));
            // The registry always indexes a plugin command under its
            // `owner:name` namespaced form and may also index its bare name.
            // Record both candidate forms so callers can legitimately request
            // teardown through either spelling; the registry checks the
            // resolved entry's actual owner before deleting anything.
            for (const key of [cmd.name, ...(cmd.aliases ?? [])]) {
              commandsIOwn.add(key);
              commandsIOwn.add(`${owner}:${key}`);
            }
          },
          unregister: (name) => {
            this.assertActive();
            if (!official && !commandsIOwn.has(name) && scr.get(name) !== undefined) {
              throw new Error(
                `Plugin "${owner}" may not unregister slash command "${name}" — it was not registered by this plugin.`,
              );
            }
            for (const key of [
              name,
              `${owner}:${name}`,
              name.startsWith(`${owner}:`) ? name.slice(owner.length + 1) : name,
            ]) {
              commandsIOwn.delete(key);
            }
            // Pass the plugin's tier through: `name` may resolve to a
            // built-in's entry (a bare name refused a core-owned alias at
            // registration), and the registry decides ownership by caller,
            // not by key spelling.
            return scr.unregister(name, owner);
          },
          get: (name) => scr.get(name),
          list: () => scr.list(),
        }
      : noopSlashCommands;
  }

  onEvent<K extends EventName>(event: K, handler: Listener<K>): () => void {
    this.assertActive();
    const off = this.events.on(event, handler);
    this.pluginCleanupFns.push(off);
    return off;
  }

  onPattern(pattern: string, handler: (event: string, payload: unknown) => void): () => void {
    this.assertActive();
    const off = this.events.onPattern(pattern, handler);
    this.pluginCleanupFns.push(off);
    return off;
  }

  emitCustom(event: string, payload: unknown): void {
    this.assertActive();
    this.events.emitCustom(event, payload);
  }

  onConfigChange(handler: (next: Readonly<Config>, prev: Readonly<Config>) => void): () => void {
    this.assertActive();
    if (!this.configStore) return () => {};
    return this.ownRegistration(
      this.configStore.watch(handler as (next: unknown, prev: unknown) => void),
    );
  }

  private assertActive(): void {
    if (this.lifetime.signal.aborted) throw new Error(`Plugin "${this.ownerName}" unloaded`);
  }

  private ownRegistration(cleanup: () => void): () => void {
    let active = true;
    const dispose = () => {
      if (!active) return;
      active = false;
      const index = this.pluginCleanupFns.indexOf(dispose);
      if (index >= 0) this.pluginCleanupFns.splice(index, 1);
      cleanup();
    };
    this.pluginCleanupFns.push(dispose);
    return dispose;
  }

  /** Called by the plugin loader when uninstalling the plugin. */
  drainCleanup(): void {
    this.lifetime.abort(new Error(`Plugin "${this.ownerName}" unloaded`));
    for (const fn of this.pluginCleanupFns.splice(0).reverse()) {
      try {
        fn();
      } catch {
        /* best-effort */
      }
    }
    // Belt-and-braces: drain any hooks this plugin still owns. If `setup()`
    // threw partway through, the unsubscribe functions above may not cover
    // every registered hook (the push happens *after* registerInProcess
    // returns). Sweeping by owner guarantees no closure outlives its plugin.
    if (this.hookRegistry) this.hookRegistry.drainByOwner(this.ownerName);
  }

  registerSystemPromptContributor(c: SystemPromptContributor): () => void {
    return this.extensions.registerSystemPromptContributor(c);
  }

  registerHook(
    event: HookEvent,
    matcher: HookMatcher | undefined,
    hook: InProcessHook,
    options?: import('@wrongstack/contracts/types/hooks').HookRegistrationOptions | undefined,
  ): () => void {
    this.assertActive();
    if (!this.hookRegistry) return () => {};
    const off = this.hookRegistry.registerInProcess(event, matcher, hook, this.ownerName, options);
    this.pluginCleanupFns.push(off);
    return off;
  }
}

const noopMcp: MCPRegistryView = {
  start: async () => undefined,
  stop: async () => undefined,
  restart: async () => undefined,
  list: () => [],
};

const noopSlashCommands: SlashCommandRegistryView = {
  register() {
    /* noop */
  },
  unregister() {
    return false;
  },
  get() {
    return undefined;
  },
  list() {
    return [];
  },
};

const noopSession: SessionWriterView = {
  append: async () => {
    /* noop */
  },
};

const noopMetrics: MetricsSinkView = {
  counter() {},
  histogram() {},
  gauge() {},
};

/**
 * Wrap a MetricsSinkView so every metric name is prefixed with
 * `plugin.<pluginName>.`. This prevents metric name collisions
 * between plugins and keeps the Prometheus output organized.
 */
function scopedMetrics(sink: MetricsSinkView, pluginName: string): MetricsSinkView {
  const prefix = `plugin.${pluginName}.`;
  return {
    counter(name, value, labels) {
      sink.counter(`${prefix}${name}`, value, labels);
    },
    histogram(name, value, labels) {
      sink.histogram(`${prefix}${name}`, value, labels);
    },
    gauge(name, value, labels) {
      sink.gauge(`${prefix}${name}`, value, labels);
    },
  };
}

/**
 * Define a plugin with automatic `apiVersion` injection and optional
 * TypeScript type inference for the plugin options schema.
 *
 * The `options` generic is inferred from the `factory` function's second
 * parameter, so annotating it gives you fully-typed options throughout:
 *
 * @example
 * ```ts
 * import { definePlugin } from '@wrongstack/core';
 *
 * interface MyOptions {
 *   threshold: number;
 *   enabled: boolean;
 * }
 *
 * const myPlugin = definePlugin(
 *   {
 *     name: 'my-plugin',
 *     version: '0.1.0',
 *     description: 'My example plugin',
 *     capabilities: { tools: true },
 *     configSchema: {
 *       type: 'object',
 *       properties: {
 *         threshold: { type: 'number', default: 100 },
 *         enabled: { type: 'boolean', default: true },
 *       },
 *     },
 *     defaultConfig: { threshold: 100, enabled: true },
 *   },
 *   (api, options) => {
 *     // options.threshold is `number` here, not `unknown`
 *     api.tools.register({
 *       name: 'my-tool',
 *       description: `Threshold is ${options.threshold}`,
 *       // ...
 *     });
 *   },
 * );
 *
 * export default myPlugin;
 * ```
 *
 * Plugins that don't need typed options can omit the interface and let
 * TypeScript infer from `defaultConfig`, or omit `defaultConfig` entirely
 * (options will be `undefined` at runtime, accessible via `api.config`):
 *
 * @example
 * ```ts
 * const simplePlugin = definePlugin(
 *   { name: 'simple' },
 *   (api) => {
 *     api.tools.register({ name: 'ping', description: 'Ping the service' });
 *   },
 * );
 * ```
 *
 * The `apiVersion` is automatically set to the current `KERNEL_API_VERSION`
 * so plugins are always compatible with the kernel that loaded them.
 * Plugins that need to pin to a specific kernel version can override it
 * in the returned object before exporting.
 */
export function definePlugin<const TOptions extends Record<string, unknown> | undefined>(
  metadata: {
    name: string;
    version?: string | undefined;
    description?: string | undefined;
    capabilities?: PluginCapabilities | undefined;
    configSchema?: JSONSchema | undefined;
    defaultConfig?: TOptions | undefined;
    dependsOn?: (string | PluginDependency)[] | undefined;
    optionalDeps?: (string | PluginDependency)[] | undefined;
    conflictsWith?: string[] | undefined;
  },
  factory: (api: PluginAPI, options: TOptions) => void | Promise<void>,
): {
  name: string;
  version?: string | undefined;
  description?: string | undefined;
  apiVersion: string;
  capabilities?: PluginCapabilities | undefined;
  configSchema?: JSONSchema | undefined;
  defaultConfig?: TOptions | undefined;
  dependsOn?: (string | PluginDependency)[] | undefined;
  optionalDeps?: (string | PluginDependency)[] | undefined;
  conflictsWith?: string[] | undefined;
  setup: (api: PluginAPI) => void | Promise<void>;
} {
  return {
    name: metadata.name,
    version: metadata.version,
    description: metadata.description,
    capabilities: metadata.capabilities,
    configSchema: metadata.configSchema,
    defaultConfig: metadata.defaultConfig,
    dependsOn: metadata.dependsOn,
    optionalDeps: metadata.optionalDeps,
    conflictsWith: metadata.conflictsWith,
    apiVersion: KERNEL_API_VERSION,
    // Cast the factory to match the Plugin.setup signature.
    // The opts parameter ({ signal }) is accepted by Plugin.setup but the
    // definePlugin factory doesn't need to declare it — the host always passes
    // it at the call site; the factory just doesn't have to care about it.
    setup: (api: PluginAPI) => factory(api, metadata.defaultConfig as TOptions),
  };
}
