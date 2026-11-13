import type { EventBus } from '@wrongstack/contracts/kernel';
import { ERROR_CODES, PluginError } from '@wrongstack/contracts/types/errors';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { Plugin, PluginAPI } from '@wrongstack/contracts/types/plugin';
import { toErrorMessage } from '../utils/error.js';
import { validateAgainstSchema } from '../utils/json-schema-validate.js';
import { resolvePluginManifestConfig, validatePluginConfigMetadata } from './config.js';
import { normalizeDep, satisfies, topoSort } from './loader-semver.js';
import { wrapApiForCapabilityCheck } from './plugin-capability-wrap.js';

interface PluginRegistration {
  plugin: Plugin;
  api: PluginAPI;
  cleanupApi: PluginAPI & {
    drainCleanup?: (() => void) | undefined;
    abortLifetime?: ((reason?: unknown) => void) | undefined;
  };
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

export interface PluginReloadResult {
  status: 'reloaded' | 'loaded';
  previousVersion?: string | undefined;
  version?: string | undefined;
}

export interface PluginHostHandle {
  loaded: Plugin[];
  failed: PluginLoadFailure[];
  readonly disposed: boolean;
  /**
   * Atomically hot-swap an already-loaded plugin (or load a newly discovered
   * plugin) without restarting the session. Validates metadata/schema before
   * tearing down the previous instance, and rolls back to the previous
   * instance if `setup()` fails.
   */
  reloadPlugin(plugin: Plugin, opts?: { force?: boolean | undefined }): Promise<PluginReloadResult>;
  /** Unload a single active plugin by name, draining all owned registrations. */
  unloadPlugin(name: string): Promise<boolean>;
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
  /** Optional typed EventBus notified when `reloadPlugin` completes. */
  events?: EventBus | undefined;
  /**
   * Optional quiescence gate awaited before `reloadPlugin` tears down an
   * active plugin generation (e.g. waiting for in-flight tool calls owned by
   * `pluginName` to settle). Default deadline: `quiescenceTimeoutMs` (5 000 ms).
   */
  waitForQuiescence?: ((pluginName: string, timeoutMs: number) => Promise<void>) | undefined;
  quiescenceTimeoutMs?: number | undefined;
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
  context: 'shutdown' | 'setup rollback' | 'reload' | 'unload',
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

  const loadedNames = new Set<string>();
  for (const plugin of sorted) {
    const failedDep = (plugin.dependsOn ?? [])
      .map(normalizeDep)
      .find((dep) => !loadedNames.has(dep.name));
    if (failedDep) {
      const err = new PluginError({
        message: `Plugin "${plugin.name}" depends on failed plugin "${failedDep.name}"`,
        code: ERROR_CODES.PLUGIN_MISSING_DEPENDENCY,
        pluginName: plugin.name,
        context: { dependency: failedDep.name },
      });
      opts.log.error(err.message);
      failed.push({ plugin, err });
      continue;
    }
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
      const api =
        plugin.capabilities !== undefined || enforceForPlugin
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
      loadedNames.add(plugin.name);
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
  const activeTransitions = new Map<string, Promise<unknown>>();

  const runPluginTransition = async <T>(pluginName: string, task: () => Promise<T>): Promise<T> => {
    const prev = activeTransitions.get(pluginName) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    const tracked = next.then(
      () => undefined,
      () => undefined,
    );
    activeTransitions.set(pluginName, tracked);
    try {
      return await next;
    } finally {
      if (activeTransitions.get(pluginName) === tracked) {
        activeTransitions.delete(pluginName);
      }
    }
  };

  const activateSinglePlugin = async (plugin: Plugin): Promise<PluginRegistration> => {
    const resolution = resolvePluginManifestConfig(
      plugin,
      undefined,
      opts.pluginOptions?.[plugin.name],
    );
    const hasResolvedOptions = plugin.defaultConfig !== undefined || resolution.configured;
    if (opts.pluginOptions && hasResolvedOptions) {
      opts.pluginOptions[plugin.name] = resolution.options;
    }
    const rawApi = opts.apiFactory(plugin, resolution.options) as PluginRegistration['cleanupApi'];
    const enforceForPlugin =
      typeof opts.enforceCapabilities === 'function'
        ? opts.enforceCapabilities(plugin)
        : (opts.enforceCapabilities ?? false);
    const api =
      plugin.capabilities !== undefined || enforceForPlugin
        ? wrapApiForCapabilityCheck(plugin, rawApi, opts.log, enforceForPlugin)
        : rawApi;
    const reg: PluginRegistration = {
      plugin,
      api,
      cleanupApi: rawApi,
      cleanupDrained: false,
      disposed: false,
    };
    try {
      const setupTimeoutMs = lifecycleTimeoutMs(opts.setupTimeoutMs, 30_000, 'setup');
      await runWithDeadline(plugin, 'setup', setupTimeoutMs, (signal) =>
        plugin.setup(api, { signal }),
      );
      return reg;
    } catch (err) {
      await disposeRegistration(reg, opts, 'setup rollback');
      throw err;
    }
  };

  const validateSinglePluginPreFlight = (plugin: Plugin): void => {
    if (!satisfies(plugin.apiVersion, kernelVersion)) {
      throw new PluginError({
        message: `Plugin "${plugin.name}" requires apiVersion ${plugin.apiVersion}; kernel is ${kernelVersion}`,
        code: ERROR_CODES.PLUGIN_API_MISMATCH,
        pluginName: plugin.name,
        context: { required: plugin.apiVersion, kernel: kernelVersion },
      });
    }
    const metadataIssues = validatePluginConfigMetadata(plugin);
    if (metadataIssues.length > 0) {
      throw new PluginError({
        message: `Plugin "${plugin.name}" config metadata invalid — ${metadataIssues.join('; ')}`,
        code: ERROR_CODES.PLUGIN_LOAD_FAILED,
        pluginName: plugin.name,
        context: { issues: metadataIssues },
      });
    }
    const resolution = resolvePluginManifestConfig(
      plugin,
      undefined,
      opts.pluginOptions?.[plugin.name],
    );
    const hasResolvedOptions = plugin.defaultConfig !== undefined || resolution.configured;
    if (plugin.configSchema && hasResolvedOptions) {
      const result = validateAgainstSchema(resolution.options, plugin.configSchema);
      if (!result.ok) {
        const firstErr = result.errors[0];
        const detail = firstErr ? `${firstErr.path}: ${firstErr.message}` : 'config invalid';
        throw new PluginError({
          message: `Plugin "${plugin.name}" config invalid — ${detail}`,
          code: ERROR_CODES.PLUGIN_LOAD_FAILED,
          pluginName: plugin.name,
          context: { errors: result.errors },
        });
      }
    }
    for (const conflict of plugin.conflictsWith ?? []) {
      if (conflict !== plugin.name && loadedNames.has(conflict)) {
        throw new PluginError({
          message: `Plugin "${plugin.name}" conflicts with loaded plugin "${conflict}"`,
          code: ERROR_CODES.PLUGIN_LOAD_FAILED,
          pluginName: plugin.name,
          context: { conflictsWith: conflict },
        });
      }
    }
    const missingDep = (plugin.dependsOn ?? [])
      .map(normalizeDep)
      .find((dep) => dep.name !== plugin.name && !loadedNames.has(dep.name));
    if (missingDep) {
      throw new PluginError({
        message: `Plugin "${plugin.name}" depends on unloaded plugin "${missingDep.name}"`,
        code: ERROR_CODES.PLUGIN_MISSING_DEPENDENCY,
        pluginName: plugin.name,
        context: { dependency: missingDep.name },
      });
    }
  };

  return {
    loaded,
    failed,
    get disposed() {
      return disposed;
    },
    async reloadPlugin(
      nextPlugin: Plugin,
      reloadOpts?: { force?: boolean | undefined },
    ): Promise<PluginReloadResult> {
      return runPluginTransition(nextPlugin.name, async () => {
        const startedAt = Date.now();
        const throwDisposed = (): never => {
          throw new PluginError({
            message: `Cannot reload plugin "${nextPlugin.name}" after plugin host disposal`,
            code: ERROR_CODES.PLUGIN_LOAD_FAILED,
            pluginName: nextPlugin.name,
          });
        };
        if (disposed) throwDisposed();

        // Phase 1: Pre-flight validation BEFORE touching any running instance.
        validateSinglePluginPreFlight(nextPlugin);

        const previousReg = registrations.find(
          (r) => !r.disposed && r.plugin.name === nextPlugin.name,
        );
        let removedRegIdx = -1;
        let removedLoadedIdx = -1;

        // Phase 2: Await optional quiescence gate (unless `--force` is set, which aborts
        // plugin-owned background tasks immediately), then drain old registration.
        if (previousReg) {
          if (reloadOpts?.force === true) {
            previousReg.cleanupApi.abortLifetime?.(
              new Error(`Plugin "${nextPlugin.name}" force-reloaded`),
            );
          } else if (typeof opts.waitForQuiescence === 'function') {
            const quiesceMs = opts.quiescenceTimeoutMs ?? 5_000;
            await opts.waitForQuiescence(nextPlugin.name, quiesceMs);
          }
          await disposeRegistration(previousReg, opts, 'reload');
          removedRegIdx = registrations.indexOf(previousReg);
          if (removedRegIdx >= 0) registrations.splice(removedRegIdx, 1);
          removedLoadedIdx = loaded.indexOf(previousReg.plugin);
          if (removedLoadedIdx >= 0) loaded.splice(removedLoadedIdx, 1);
          loadedNames.delete(nextPlugin.name);
        }

        if (disposed) throwDisposed();

        // Phase 3: Activate new plugin; roll back to previous plugin on failure.
        try {
          const nextReg = await activateSinglePlugin(nextPlugin);
          if (disposed) {
            await disposeRegistration(nextReg, opts, 'shutdown');
            throwDisposed();
          }
          if (removedRegIdx >= 0 && removedRegIdx <= registrations.length) {
            registrations.splice(removedRegIdx, 0, nextReg);
          } else {
            registrations.push(nextReg);
          }
          registerLegacy(nextReg);
          if (removedLoadedIdx >= 0 && removedLoadedIdx <= loaded.length) {
            loaded.splice(removedLoadedIdx, 0, nextPlugin);
          } else {
            loaded.push(nextPlugin);
          }
          loadedNames.add(nextPlugin.name);
          const durationMs = Math.max(0, Date.now() - startedAt);
          opts.log.info(
            `Plugin "${nextPlugin.name}" ${previousReg ? 'reloaded' : 'loaded dynamically'}`,
          );
          opts.events?.emit('plugin.reloaded', {
            name: nextPlugin.name,
            version: nextPlugin.version,
            durationMs,
          });
          return {
            status: previousReg ? 'reloaded' : 'loaded',
            previousVersion: previousReg?.plugin.version,
            version: nextPlugin.version,
          };
        } catch (setupErr) {
          if (previousReg && !disposed) {
            try {
              const restoredReg = await activateSinglePlugin(previousReg.plugin);
              if (disposed) {
                await disposeRegistration(restoredReg, opts, 'shutdown');
              } else {
                if (removedRegIdx >= 0 && removedRegIdx <= registrations.length) {
                  registrations.splice(removedRegIdx, 0, restoredReg);
                } else {
                  registrations.push(restoredReg);
                }
                registerLegacy(restoredReg);
                if (removedLoadedIdx >= 0 && removedLoadedIdx <= loaded.length) {
                  loaded.splice(removedLoadedIdx, 0, previousReg.plugin);
                } else {
                  loaded.push(previousReg.plugin);
                }
                loadedNames.add(previousReg.plugin.name);
                opts.log.warn(
                  `Plugin "${nextPlugin.name}" reload failed; rolled back to previous active instance`,
                );
              }
            } catch (rollbackErr) {
              opts.log.error(
                `Plugin "${nextPlugin.name}" rollback after reload failure also failed`,
                {
                  rollbackErr,
                },
              );
            }
          }
          throw setupErr;
        }
      });
    },
    async unloadPlugin(name: string): Promise<boolean> {
      return runPluginTransition(name, async () => {
        if (disposed) return false;
        const reg = registrations.find((r) => !r.disposed && r.plugin.name === name);
        if (!reg) return false;
        await disposeRegistration(reg, opts, 'unload');
        const regIdx = registrations.indexOf(reg);
        if (regIdx >= 0) registrations.splice(regIdx, 1);
        const loadedIdx = loaded.indexOf(reg.plugin);
        if (loadedIdx >= 0) loaded.splice(loadedIdx, 1);
        if (!registrations.some((r) => !r.disposed && r.plugin.name === name)) {
          loadedNames.delete(name);
        }
        return true;
      });
    },
    dispose() {
      if (!disposePromise) {
        disposed = true;
        const pendingTransitions = [...activeTransitions.values()];
        disposePromise = (async () => {
          await disposeRegistrations(registrations, opts);
          if (pendingTransitions.length > 0) {
            await Promise.allSettled(pendingTransitions);
            await disposeRegistrations(registrations, opts);
          }
        })();
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
