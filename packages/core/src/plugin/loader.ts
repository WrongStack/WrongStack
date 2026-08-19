import { ERROR_CODES, PluginError } from '../types/errors.js';
import type { Logger } from '../types/logger.js';
import type { Plugin, PluginAPI, PluginDependency } from '../types/plugin.js';
import { toErrorMessage } from '../utils/error.js';
import { validateAgainstSchema } from '../utils/json-schema-validate.js';
import { resolvePluginManifestConfig, validatePluginConfigMetadata } from './config.js';

interface PluginRegistration {
  plugin: Plugin;
  api: PluginAPI;
  cleanupApi: PluginAPI & { drainCleanup?: (() => void) | undefined };
  cleanupDrained: boolean;
  disposed: boolean;
}

/**
 * Compatibility registry for callers that still use `unloadPlugins(loaded)`.
 * New hosts should use the handle returned by `loadPlugins`; that handle owns
 * an exact, isolated registration set even when two hosts load the same Plugin
 * object concurrently.
 */
const legacyRegistrations = new WeakMap<Plugin, PluginRegistration[]>();

export interface PluginLoadFailure {
  plugin: Plugin;
  err: unknown;
}

export interface PluginHostHandle {
  loaded: Plugin[];
  failed: PluginLoadFailure[];
  readonly disposed: boolean;
  /** Dispose successfully loaded plugins in reverse dependency order. */
  dispose(): Promise<void>;
}

class PluginLifecycleTimeoutError extends Error {
  constructor(
    readonly pluginName: string,
    readonly phase: 'setup' | 'teardown',
    readonly timeoutMs: number,
  ) {
    super(`Plugin "${pluginName}" ${phase} exceeded ${timeoutMs} ms`);
    this.name = 'PluginLifecycleTimeoutError';
  }
}

/**
 * Stable plugin API contract version. This is intentionally independent of
 * the package version: bump only when the surface visible to plugins
 * (PluginAPI, types/plugin) changes in a way that breaks existing setup
 * functions. Plugins declare `apiVersion: "^1.0"` to opt into this contract.
 *
 * 0.1.9: additive — `FleetSpawnBudgetError|FleetCostCapError` plus `FLEET_ROSTER` and the
 * pre-built fleet agent configs (Audit Log, Bug Hunter, Refactor Planner,
 * Security Scanner) now exported from `@wrongstack/core`.
 * 0.1.10: additive — extended-thinking stream events, core subpath
 * exports, tool output size chips on `tool.executed`. Plugin contract
 * unchanged otherwise; 0.1.x range still loads cleanly.
 *
 * Note: the package shipped as 0.2.0, but the *plugin contract* didn't
 * change in a breaking way — `SubagentError`, `subagent.tool_executed`,
 * `transcriptPath`, `planTool`, `delegate`, `runText`, and Director
 * sessionWriter are all additive to the surface. We deliberately keep
 * the kernel API at 0.1.10 so plugins pinning `apiVersion: "^0.1"`
 * keep loading. Bump to 1.0 when we stabilize and want the freedom to
 * remove deprecated surfaces.
 */
export const KERNEL_API_VERSION = '0.1.10';

export interface LoadPluginsOptions {
  apiFactory: (plugin: Plugin, resolvedOptions: Readonly<Record<string, unknown>>) => PluginAPI;
  log: Logger;
  kernelApiVersion?: string | undefined;
  /**
   * Per-plugin options keyed by plugin name. When a plugin declares
   * `configSchema`, the loader validates `pluginOptions[plugin.name]`
   * against it before calling `setup`. Pass `Config.plugins` shaped
   * `{ [name]: { options } }` or any flat record.
   */
  pluginOptions?: Record<string, Record<string, unknown>>;
  /**
   * When true, the loader throws a PluginError if a plugin calls an API
   * method that contradicts its declared `capabilities` — instead of
   * just logging a warning. Use in CI/strict deployments to enforce
   * manifest honesty. Default: false (log-only, backward-compatible).
   *
   * A predicate form is also accepted so hosts can enforce selectively —
   * e.g. strictly for external (third-party) plugins while keeping
   * first-party plugins warn-only.
   */
  enforceCapabilities?: boolean | ((plugin: Plugin) => boolean) | undefined;
  /**
   * Timeout in milliseconds for each plugin's `setup()` call. If the
   * plugin's setup exceeds this deadline it is treated as a failure
   * and the plugin is not loaded. Default: 30 000 ms.
   */
  setupTimeoutMs?: number | undefined;
  /**
   * Timeout in milliseconds for each plugin's `teardown()` call. If the
   * plugin's teardown exceeds this deadline it is treated as a best-effort
   * failure (logged but not propagated). Default: 10 000 ms.
   */
  teardownTimeoutMs?: number | undefined;
}

function parseSemver(v: string): [number, number, number] {
  const parts = v
    .replace(/^[^0-9]*/, '')
    .split('.')
    .map((s) => Number.parseInt(s, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function satisfies(range: string, version: string): boolean {
  const [vMaj, vMin, vPatch] = parseSemver(version);
  const trimmed = range.trim();
  const op = trimmed.startsWith('^') ? '^' : trimmed.startsWith('~') ? '~' : '=';
  const ver = trimmed.replace(/^[\^~=]/, '');
  const [rMaj, rMin, rPatch] = parseSemver(ver);
  if (op === '^') {
    if (rMaj === 0) return vMaj === 0 && vMin === rMin && vPatch >= rPatch;
    return vMaj === rMaj && (vMin > rMin || (vMin === rMin && vPatch >= rPatch));
  }
  if (op === '~') {
    return vMaj === rMaj && vMin === rMin && vPatch >= rPatch;
  }
  return vMaj === rMaj && vMin === rMin && vPatch === rPatch;
}

/** Normalize either `string` or `PluginDependency` into the structured form. */
function normalizeDep(d: string | PluginDependency): PluginDependency {
  return typeof d === 'string' ? { name: d } : d;
}

/**
 * Shallow-merge defaults with overrides. Override keys take precedence;
 * defaults fill in where overrides are missing. Nested objects are
 * NOT deep-merged — the override value replaces wholesale.
 */
function topoSort(plugins: Plugin[]): Plugin[] {
  const map = new Map<string, Plugin>();
  for (const p of plugins) map.set(p.name, p);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: Plugin[] = [];

  const visit = (p: Plugin, stack: string[]) => {
    if (visited.has(p.name)) return;
    if (visiting.has(p.name)) {
      throw new PluginError({
        message: `Plugin dependency cycle: ${[...stack, p.name].join(' -> ')}`,
        code: ERROR_CODES.PLUGIN_LOAD_FAILED,
        pluginName: p.name,
      });
    }
    visiting.add(p.name);
    for (const raw of p.dependsOn ?? []) {
      const dep = normalizeDep(raw);
      const d = map.get(dep.name);
      if (!d) {
        throw new PluginError({
          message: `Plugin "${p.name}" depends on missing plugin "${dep.name}"`,
          code: ERROR_CODES.PLUGIN_MISSING_DEPENDENCY,
          pluginName: p.name,
          context: { dependency: dep.name },
        });
      }
      // Version constraint check — only when both declared range and the
      // dependency's actual version are available. Missing either side is
      // tolerated: plugins without `version` are treated as wildcard.
      if (dep.version && d.version && !satisfies(dep.version, d.version)) {
        throw new PluginError({
          message: `Plugin "${p.name}" requires "${dep.name}@${dep.version}", found ${d.version}`,
          code: ERROR_CODES.PLUGIN_LOAD_FAILED,
          pluginName: p.name,
          context: { dependency: dep.name, required: dep.version, found: d.version },
        });
      }
      visit(d, [...stack, p.name]);
    }
    // Optional deps are silently skipped if the plugin is not loaded.
    for (const raw of p.optionalDeps ?? []) {
      const dep = normalizeDep(raw);
      const d = map.get(dep.name);
      if (d) {
        if (dep.version && d.version && !satisfies(dep.version, d.version)) {
          throw new PluginError({
            message: `Plugin "${p.name}" optional dep "${dep.name}@${dep.version}" found ${d.version}`,
            code: ERROR_CODES.PLUGIN_LOAD_FAILED,
            pluginName: p.name,
            context: { dependency: dep.name, required: dep.version, found: d.version },
          });
        }
        visit(d, [...stack, p.name]);
      }
    }
    visiting.delete(p.name);
    visited.add(p.name);
    order.push(p);
  };

  for (const p of plugins) visit(p, []);
  return order;
}

function lifecycleTimeoutMs(
  configured: number | undefined,
  fallback: number,
  phase: 'setup' | 'teardown',
): number {
  const value = configured ?? fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`Plugin ${phase} timeout must be a finite non-negative number`);
  }
  return value;
}

async function runWithDeadline(
  plugin: Plugin,
  phase: 'setup' | 'teardown',
  timeoutMs: number,
  operation: (signal: AbortSignal) => void | Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new PluginLifecycleTimeoutError(plugin.name, phase, timeoutMs);
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  const work = Promise.resolve().then(() => operation(controller.signal));
  try {
    await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function registerLegacy(registration: PluginRegistration): void {
  const registrations = legacyRegistrations.get(registration.plugin) ?? [];
  registrations.push(registration);
  legacyRegistrations.set(registration.plugin, registrations);
}

function unregisterLegacy(registration: PluginRegistration): void {
  const registrations = legacyRegistrations.get(registration.plugin);
  if (!registrations) return;
  const index = registrations.indexOf(registration);
  if (index >= 0) registrations.splice(index, 1);
  if (registrations.length === 0) legacyRegistrations.delete(registration.plugin);
}

function drainCleanup(registration: PluginRegistration, log: Logger): void {
  if (registration.cleanupDrained) return;
  registration.cleanupDrained = true;
  try {
    registration.cleanupApi.drainCleanup?.call(registration.cleanupApi);
  } catch (err) {
    log.error(`Plugin "${registration.plugin.name}" cleanup drain failed`, { err });
  }
}

async function disposeRegistration(
  registration: PluginRegistration,
  opts: LoadPluginsOptions,
  context: 'shutdown' | 'setup rollback',
): Promise<void> {
  if (registration.disposed) return;
  registration.disposed = true;
  const { plugin, api } = registration;
  try {
    if (typeof plugin.teardown === 'function') {
      const timeoutMs = lifecycleTimeoutMs(opts.teardownTimeoutMs, 10_000, 'teardown');
      await runWithDeadline(plugin, 'teardown', timeoutMs, (signal) =>
        plugin.teardown!(api, { signal }),
      );
    }
    opts.log.info(`Plugin "${plugin.name}" disposed (${context})`);
  } catch (err) {
    opts.log.error(`Plugin "${plugin.name}" teardown failed during ${context}`, {
      err,
      reason: err instanceof PluginLifecycleTimeoutError ? 'teardown deadline exceeded' : undefined,
    });
  } finally {
    drainCleanup(registration, opts.log);
    unregisterLegacy(registration);
  }
}

async function disposeRegistrations(
  registrations: PluginRegistration[],
  opts: LoadPluginsOptions,
): Promise<void> {
  for (const registration of [...registrations].reverse()) {
    await disposeRegistration(registration, opts, 'shutdown');
  }
}

export async function loadPlugins(
  plugins: Plugin[],
  opts: LoadPluginsOptions,
): Promise<PluginHostHandle> {
  const kernelVersion = opts.kernelApiVersion ?? KERNEL_API_VERSION;
  const loaded: Plugin[] = [];
  const failed: PluginLoadFailure[] = [];
  const registrations: PluginRegistration[] = [];

  // Conflict check
  const names = new Set(plugins.map((p) => p.name));
  for (const p of plugins) {
    for (const c of p.conflictsWith ?? []) {
      if (names.has(c)) {
        throw new PluginError({
          message: `Plugin "${p.name}" conflicts with loaded plugin "${c}"`,
          code: ERROR_CODES.PLUGIN_LOAD_FAILED,
          pluginName: p.name,
          context: { conflictsWith: c },
        });
      }
    }
  }

  let sorted: Plugin[];
  try {
    sorted = topoSort(plugins);
  } catch (err) {
    const message = toErrorMessage(err);
    opts.log.error('Plugin dependency sort failed', message);
    throw new PluginError({
      message: `Plugin dependency sort failed: ${message}`,
      code: ERROR_CODES.PLUGIN_LOAD_FAILED,
      pluginName: '(topological sort)',
      context: { pluginCount: plugins.length },
      cause: err,
    });
  }

  for (const plugin of sorted) {
    if (!satisfies(plugin.apiVersion, kernelVersion)) {
      const err = new PluginError({
        message: `Plugin "${plugin.name}" requires apiVersion ${plugin.apiVersion}; kernel is ${kernelVersion}`,
        code: ERROR_CODES.PLUGIN_API_MISMATCH,
        pluginName: plugin.name,
        context: { required: plugin.apiVersion, kernel: kernelVersion },
      });
      opts.log.error(err.message);
      failed.push({ plugin, err });
      continue;
    }
    const metadataIssues = validatePluginConfigMetadata(plugin);
    if (metadataIssues.length > 0) {
      const err = new PluginError({
        message: `Plugin "${plugin.name}" config metadata invalid — ${metadataIssues.join('; ')}`,
        code: ERROR_CODES.PLUGIN_LOAD_FAILED,
        pluginName: plugin.name,
        context: { issues: metadataIssues },
      });
      opts.log.error(err.message);
      failed.push({ plugin, err });
      continue;
    }

    const resolution = resolvePluginManifestConfig(
      plugin,
      undefined,
      opts.pluginOptions?.[plugin.name],
    );
    const hasResolvedOptions = plugin.defaultConfig !== undefined || resolution.configured;
    if (opts.pluginOptions && hasResolvedOptions) {
      opts.pluginOptions[plugin.name] = resolution.options;
    }

    // configSchema validation — runs before setup() so a bad config never
    // reaches plugin code. The plugin's options are looked up by plugin name
    // in the host-supplied options bag.
    if (plugin.configSchema && hasResolvedOptions) {
      const result = validateAgainstSchema(resolution.options, plugin.configSchema);
      if (!result.ok) {
        const firstErr = result.errors[0];
        const detail = firstErr ? `${firstErr.path}: ${firstErr.message}` : 'config invalid';
        const err = new PluginError({
          message: `Plugin "${plugin.name}" config invalid — ${detail}`,
          code: ERROR_CODES.PLUGIN_LOAD_FAILED,
          pluginName: plugin.name,
          context: { errors: result.errors },
        });
        opts.log.error(err.message);
        failed.push({ plugin, err });
        continue;
      }
    }
    let registration: PluginRegistration | undefined;
    try {
      const rawApi = opts.apiFactory(
        plugin,
        resolution.options,
      ) as PluginRegistration['cleanupApi'];
      const enforceForPlugin =
        typeof opts.enforceCapabilities === 'function'
          ? opts.enforceCapabilities(plugin)
          : (opts.enforceCapabilities ?? false);
      const api = plugin.capabilities
        ? wrapApiForCapabilityCheck(plugin, rawApi, opts.log, enforceForPlugin)
        : rawApi;
      registration = {
        plugin,
        api,
        cleanupApi: rawApi,
        cleanupDrained: false,
        disposed: false,
      };
      const setupTimeoutMs = lifecycleTimeoutMs(opts.setupTimeoutMs, 30_000, 'setup');
      await runWithDeadline(plugin, 'setup', setupTimeoutMs, (signal) =>
        plugin.setup(api, { signal }),
      );
      registrations.push(registration);
      registerLegacy(registration);
      loaded.push(plugin);
      opts.log.info(`Plugin "${plugin.name}" loaded`);
    } catch (err) {
      opts.log.error(`Plugin "${plugin.name}" setup failed`, {
        err,
        reason: err instanceof PluginLifecycleTimeoutError ? 'setup deadline exceeded' : undefined,
      });
      failed.push({ plugin, err });
      if (registration) await disposeRegistration(registration, opts, 'setup rollback');
    }
  }
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  return {
    loaded,
    failed,
    get disposed() {
      return disposed;
    },
    dispose() {
      if (!disposePromise) {
        disposed = true;
        disposePromise = disposeRegistrations(registrations, opts);
      }
      return disposePromise;
    },
  };
}

/**
 * Tear down loaded plugins in reverse-dependency order. `teardown()` is
 * best-effort: errors are caught and logged so a single misbehaving plugin
 * can't abort the host shutdown sequence.
 *
 * @deprecated Prefer `loadPlugins(...).dispose()`. The handle has exact host
 * ownership and remains unambiguous when the same Plugin object is loaded by
 * more than one host. This legacy path shares a process-wide registry, so
 * when multiple hosts load the same Plugin object, `unloadPlugins` may
 * dispose another host's registration. Use the handle's `dispose()` instead.
 */
export async function unloadPlugins(
  loadedPlugins: Plugin[],
  opts: LoadPluginsOptions,
): Promise<void> {
  const ordered = [...loadedPlugins].reverse();
  for (const plugin of ordered) {
    const candidates = legacyRegistrations.get(plugin);
    let registration: PluginRegistration | undefined;
    if (candidates) {
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        if (!candidates[index]!.disposed) {
          registration = candidates[index];
          break;
        }
      }
    }
    if (!registration) {
      opts.log.error(`Plugin "${plugin.name}" has no active loader registration`);
      continue;
    }
    await disposeRegistration(registration, opts, 'shutdown');
  }
}

/**
 * Wrap the PluginAPI so calls that contradict the plugin's declared
 * capabilities are caught. By default violations are logged as warnings
 * (backward-compatible). When `enforce` is true, violations throw a
 * PluginError so the host can reject misbehaving plugins at setup time.
 */
function wrapApiForCapabilityCheck(
  plugin: Plugin,
  api: PluginAPI,
  log: {
    error(msg: string, ctx?: unknown): void | undefined;
    warn?(msg: string, ctx?: unknown): void | undefined;
    info?(msg: string, ctx?: unknown): void | undefined;
  },
  enforce = false,
): PluginAPI {
  const caps = plugin.capabilities ?? {};
  const violate = (subsystem: string, detail: string) => {
    const msg = `Plugin "${plugin.name}" used ${subsystem} without declaring capabilities.${subsystem} — ${detail}`;
    if (enforce) {
      throw new PluginError({
        message: msg,
        code: ERROR_CODES.PLUGIN_LOAD_FAILED,
        pluginName: plugin.name,
        context: { subsystem, detail },
      });
    }
    if (typeof log.warn === 'function') log.warn(msg);
    else log.error(msg);
  };

  // Wrap tools.register
  const wrappedTools =
    caps.tools !== false
      ? api.tools
      : new Proxy(api.tools, {
          get(target, prop, receiver) {
            if (prop === 'register') {
              return (t: unknown) => {
                violate(
                  'tools',
                  `register(${(t as { name?: string | undefined })?.name ?? '<unknown>'})`,
                );
                return (target.register as (x: unknown) => unknown)(t);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
  // Wrap providers.register
  const wrappedProviders =
    caps.providers !== false
      ? api.providers
      : new Proxy(api.providers, {
          get(target, prop, receiver) {
            if (prop === 'register') {
              return (f: unknown) => {
                violate(
                  'providers',
                  `register(${(f as { type?: string | undefined })?.type ?? '<unknown>'})`,
                );
                return (target.register as (x: unknown) => unknown)(f);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
  // Wrap slashCommands.register
  const wrappedSlash =
    caps.slashCommands !== false
      ? api.slashCommands
      : new Proxy(api.slashCommands, {
          get(target, prop, receiver) {
            if (prop === 'register') {
              return (c: unknown) => {
                violate(
                  'slashCommands',
                  `register(${(c as { name?: string | undefined })?.name ?? '<unknown>'})`,
                );
                return (target.register as (x: unknown) => unknown)(c);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
  // Wrap mcp.start
  const wrappedMcp =
    caps.mcp !== false
      ? api.mcp
      : new Proxy(api.mcp, {
          get(target, prop, receiver) {
            if (prop === 'start') {
              return (cfg: unknown) => {
                violate(
                  'mcp',
                  `start(${(cfg as { name?: string | undefined })?.name ?? '<unknown>'})`,
                );
                return (target.start as (x: unknown) => unknown)(cfg);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
  // Wrap api.llm.complete. The facade is optional on minimal hosts; when it
  // exists, an explicit `llm: false` declaration is treated like the other
  // capability contradictions while still preserving warn-only compatibility.
  const wrappedLlm =
    caps.llm !== false || !api.llm
      ? api.llm
      : new Proxy(api.llm, {
          get(target, prop, receiver) {
            if (prop === 'complete' || prop === 'council') {
              return (prompt: string, options?: unknown) => {
                violate('llm', `${String(prop)}(${prompt.length} chars)`);
                const method = target[prop] as ((p: string, o?: unknown) => unknown) | undefined;
                if (!method) return undefined;
                return options === undefined
                  ? method.call(target, prompt)
                  : method.call(target, prompt, options);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
  // Wrap registerHook — same pattern as the other subsystems. A plugin that
  // explicitly declared `hooks: false` gets warned/throws on registerHook.
  // Per-hook matchers and payloads are unchanged; only the call is gated.
  const wrappedHooks =
    caps.hooks !== false
      ? api
      : new Proxy(api, {
          get(target, prop, receiver) {
            if (prop === 'registerHook') {
              return (event: unknown, matcher: unknown, hook: unknown, options?: unknown) => {
                const ev = typeof event === 'string' ? event : '<unknown>';
                const m = typeof matcher === 'string' ? matcher : '*';
                violate('hooks', `registerHook(${ev}, ${m})`);
                const register = target.registerHook as (
                  e: unknown,
                  m: unknown,
                  h: unknown,
                  o?: unknown,
                ) => unknown;
                return options === undefined
                  ? register(event, matcher, hook)
                  : register(event, matcher, hook, options);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });

  return new Proxy(api, {
    get(target, prop, receiver) {
      switch (prop) {
        case 'tools':
          return wrappedTools;
        case 'providers':
          return wrappedProviders;
        case 'slashCommands':
          return wrappedSlash;
        case 'mcp':
          return wrappedMcp;
        case 'llm':
          return wrappedLlm;
        case 'registerHook':
          // The hooks gate wraps the API itself (because registerHook is on
          // the API, not on a sub-registry). Forward to wrappedHooks so the
          // capability check fires.
          return (wrappedHooks as unknown as Record<PropertyKey, unknown>)[prop];
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  });
}
