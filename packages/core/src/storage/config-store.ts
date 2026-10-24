import type { Config, ConfigStore } from '@wrongstack/contracts/types/config';
import { ConfigError, ERROR_CODES } from '@wrongstack/contracts/types/errors';
import { createTypeSafePolicy } from '../typesafe/policy.js';
import { toErrorMessage } from '../utils/error.js';

/**
 * Strip fields that originated from environment variables so they are never
 * persisted back to disk. This prevents an env-sourced secret (e.g.
 * WRONGSTACK_API_KEY) from being accidentally written to a profile config.
 */
function stripEphemeralFields(cfg: Partial<Config>): Partial<Config> {
  const env = (cfg as Partial<Config & { _envSource?: Set<string> | undefined }>)._envSource;
  if (!env?.size) return cfg;
  const out: Partial<Config> = { ...cfg };
  for (const field of env) {
    delete (out as Record<string, unknown>)[field];
  }
  delete (out as Record<string, unknown>)._envSource;
  return out;
}

/**
 * Reference implementation of `ConfigStore`. Stores a single frozen Config
 * and notifies watchers synchronously on every update. Updates use a deep
 * clone so callers can mutate their `partial` argument freely without
 * tainting state.
 *
 * For the CLI: instantiate once at boot, pass the store (not the Config)
 * to subsystems that care about runtime changes (provider switching,
 * extension reload).
 */
export class DefaultConfigStore implements ConfigStore {
  private current: Readonly<Config>;
  private publishTypeSafePolicy: ReturnType<typeof createTypeSafePolicy>;
  private watchers = new Set<(next: Readonly<Config>, prev: Readonly<Config>) => void>();

  constructor(initial: Config) {
    this.current = deepFreeze(structuredClone(initial));
    this.publishTypeSafePolicy = createTypeSafePolicy(this.current);
    this.publishTypeSafePolicy(initial);
    this.publishTypeSafePolicy(this.current);
  }

  get(): Readonly<Config> {
    return this.current;
  }

  getSection<K extends keyof Config>(key: K): Readonly<Config[K]> {
    return this.current[key] as Readonly<Config[K]>;
  }

  getExtension(pluginName: string): Readonly<Record<string, unknown>> {
    const ext = this.current.extensions?.[pluginName];
    return ext ? (ext as Readonly<Record<string, unknown>>) : FROZEN_EMPTY;
  }

  update(partial: Partial<Config>): Readonly<Config> {
    // Strip env-sourced fields before persisting to prevent secrets leaking
    // from in-memory env-derived config values into the on-disk config file.
    const scrubbed = stripEphemeralFields(partial);
    // Shallow merge — top-level fields replace, nested objects do too unless
    // the caller passes a fully-formed sub-object. That matches the JSON
    // config user mental model (replace `tools.maxIterations` by passing
    // the whole `tools` block, or by patching `extensions.<name>`).
    return this.publish({ ...this.current, ...scrubbed }, 'update');
  }

  replace(next: Config): Readonly<Config> {
    // Unlike update(), replacement receives the canonical loader output,
    // including current environment overrides. Do not strip ephemeral fields:
    // this snapshot is never persisted by ConfigStore.
    return this.publish(next, 'replace');
  }

  private publish(nextConfig: Config, operation: 'update' | 'replace'): Readonly<Config> {
    const next = deepFreeze(structuredClone(nextConfig)) as Readonly<Config>;
    if (next.version !== 1) {
      throw new ConfigError({
        message: `ConfigStore.${operation}: version must remain 1, got ${String(next.version)}`,
        code: ERROR_CODES.CONFIG_INVALID,
        context: { field: 'version', actual: next.version },
      });
    }

    const prev = this.current;
    this.current = next;
    this.publishTypeSafePolicy(next);
    // Notify watchers AFTER mutating `current` so re-entrant watcher reads
    // see the new state. Watcher exceptions are caught individually so one
    // misbehaving subscriber can't block the others.
    for (const w of [...this.watchers]) {
      try {
        w(next, prev);
      } catch (err) {
        // A plugin watcher that crashes on /model switch or similar would
        // otherwise leave the system in a quietly-inconsistent state. We
        // still don't propagate (one bad subscriber must not break the
        // others), but we surface the error so it's discoverable.
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'config_store.watcher_threw',
            message: toErrorMessage(err),
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }
    return next;
  }

  watch(cb: (next: Readonly<Config>, prev: Readonly<Config>) => void): () => void {
    this.watchers.add(cb);
    return () => this.watchers.delete(cb);
  }
}

const FROZEN_EMPTY: Readonly<Record<string, unknown>> = Object.freeze({});

function deepFreeze<T>(obj: T): T {
  /* v8 ignore start -- defensive: callers (and the recursion guard below) only pass unfrozen objects */
  if (obj === null || typeof obj !== 'object') return obj;
  if (Object.isFrozen(obj)) return obj;
  /* v8 ignore stop */
  for (const key of Object.keys(obj as object)) {
    const v = (obj as Record<string, unknown>)[key];
    if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
      deepFreeze(v);
    }
  }
  return Object.freeze(obj);
}
