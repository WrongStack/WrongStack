import type { Config, PluginConfig } from '../types/config.js';
import type {
  Plugin,
  PluginConfigFieldLifecycle,
  PluginConfigFieldMetadata,
} from '../types/plugin.js';

export interface ResolvePluginConfigInput {
  name: string;
  aliases?: readonly string[] | undefined;
  defaults?: Readonly<Record<string, unknown>> | undefined;
  config?: Partial<Pick<Config, 'plugins' | 'extensions'>> | undefined;
  /** Highest-precedence host override, primarily for embedding APIs. */
  explicitOptions?: Readonly<Record<string, unknown>> | undefined;
}

export type PluginConfigSource =
  | 'legacy-plugin-map'
  | 'plugin-entry'
  | 'extension'
  | 'explicit-options';

export interface ResolvedPluginConfig {
  options: Record<string, unknown>;
  configured: boolean;
  sources: PluginConfigSource[];
}

export interface PluginConfigChange {
  key: string;
  lifecycle: PluginConfigFieldLifecycle;
  secret: boolean;
  previous: unknown;
  next: unknown;
}

/**
 * Resolve one plugin namespace with a single shallow precedence rule:
 * defaults < legacy plugin map < ordered plugin entries < aliases/canonical
 * extension namespaces < explicit host options. Canonical extension names
 * beat aliases, making migrations deterministic regardless of object order.
 */
export function resolvePluginConfig(input: ResolvePluginConfigInput): ResolvedPluginConfig {
  const names = [...new Set([...(input.aliases ?? []), input.name])];
  const options: Record<string, unknown> = { ...(input.defaults ?? {}) };
  const sources: PluginConfigSource[] = [];
  let configured = false;
  const merge = (value: unknown, source: PluginConfigSource): void => {
    if (!isRecord(value)) return;
    Object.assign(options, value);
    configured = true;
    if (!sources.includes(source)) sources.push(source);
  };

  const plugins = input.config?.plugins as unknown;
  if (isRecord(plugins)) {
    for (const name of names) merge(plugins[name], 'legacy-plugin-map');
  } else if (Array.isArray(plugins)) {
    for (const candidate of plugins) {
      if (!isPluginEntry(candidate) || !names.includes(candidate.name)) continue;
      merge(candidate.options, 'plugin-entry');
    }
  }

  const extensions = input.config?.extensions;
  for (const name of names) merge(extensions?.[name], 'extension');
  merge(input.explicitOptions, 'explicit-options');

  return { options, configured, sources };
}

/**
 * Default `config.plugins` name matcher: the canonical name, a declared
 * alias, or the `@wrongstack/plugins/<name>` subpath spelling of either.
 *
 * Surfaces that know more pass their own `matches` — the loader has an alias
 * table (`lsp` → `@wrongstack/plug-lsp`), the CLI folds `telegram` and
 * `@wrongstack/telegram` into one row. This is the floor, not the ceiling.
 */
export function pluginEntryMatchesName(
  configuredName: string,
  name: string,
  aliases: readonly string[] = [],
): boolean {
  for (const candidate of [name, ...aliases]) {
    if (configuredName === candidate) return true;
    if (configuredName === `@wrongstack/plugins/${candidate}`) return true;
  }
  return false;
}

export type PluginEnablementSource = 'feature-flag' | 'plugin-entry' | 'extension' | 'default';

export interface ResolvedPluginEnablement {
  enabled: boolean;
  source: PluginEnablementSource;
}

export interface ResolvePluginEnablementInput {
  name: string;
  aliases?: readonly string[] | undefined;
  /**
   * `'active'` — runs unless something turns it off.
   * `'inactive'` — runs only when something explicitly turns it on.
   * Omitted behaves like `'inactive'`.
   */
  defaultState?: 'active' | 'inactive' | undefined;
  config?: Partial<Pick<Config, 'plugins' | 'extensions' | 'features'>> | undefined;
  /**
   * Overrides how a `config.plugins` entry name is matched against this
   * plugin. Surfaces normalize specs differently (the loader maps
   * `@wrongstack/plugins/foo` → `foo`, the CLI treats `telegram` and
   * `@wrongstack/telegram` as one row), so matching is per-surface —
   * only the PRECEDENCE below is shared. Defaults to name/alias equality.
   */
  matches?: ((configuredName: string) => boolean) | undefined;
}

/**
 * Resolve whether a plugin boots, under ONE precedence shared by every
 * surface that reports or acts on plugin state:
 *
 *   1. `features.plugins === false` — kills every plugin.
 *   2. a matching `config.plugins` entry — `{ enabled: false }` is off,
 *      anything else is on. This is what `wstack plugin enable|disable`
 *      writes, so it stays the highest per-plugin authority.
 *   3. `config.extensions[name].enabled`, when it is a boolean — the
 *      plugin's own master switch.
 *   4. the catalog `defaultState`.
 *
 * Rule 3 used to be read only by the loader, and only in its `=== true`
 * direction: a plugin switched on via `extensions` ran while every
 * reporting surface — which looked at `config.plugins` alone — called it
 * disabled, and `extensions[name].enabled = false` turned nothing off.
 * Both directions now resolve here, so "what runs" and "what the report
 * says" cannot drift apart again.
 */
export function resolvePluginEnablement(
  input: ResolvePluginEnablementInput,
): ResolvedPluginEnablement {
  if (input.config?.features?.plugins === false) {
    return { enabled: false, source: 'feature-flag' };
  }

  const names = [...new Set([input.name, ...(input.aliases ?? [])])];
  const matches =
    input.matches ??
    ((configuredName: string) =>
      pluginEntryMatchesName(configuredName, input.name, input.aliases ?? []));

  const plugins = input.config?.plugins;
  if (Array.isArray(plugins)) {
    for (const candidate of plugins) {
      if (typeof candidate === 'string') {
        if (matches(candidate)) return { enabled: true, source: 'plugin-entry' };
        continue;
      }
      if (!isPluginEntry(candidate) || !matches(candidate.name)) continue;
      return { enabled: candidate.enabled !== false, source: 'plugin-entry' };
    }
  }

  for (const name of names) {
    const enabled = input.config?.extensions?.[name]?.['enabled'];
    if (typeof enabled === 'boolean') return { enabled, source: 'extension' };
  }

  return { enabled: input.defaultState === 'active', source: 'default' };
}

export function resolvePluginManifestConfig(
  plugin: Pick<Plugin, 'name' | 'configAliases' | 'defaultConfig'>,
  config?: ResolvePluginConfigInput['config'],
  explicitOptions?: Readonly<Record<string, unknown>>,
): ResolvedPluginConfig {
  return resolvePluginConfig({
    name: plugin.name,
    aliases: plugin.configAliases,
    defaults: plugin.defaultConfig,
    config,
    explicitOptions,
  });
}

/** Unknown fields are immutable by default so a new option cannot silently hot-reload. */
export function diffPluginConfig(
  previous: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
  fields: Readonly<Record<string, PluginConfigFieldMetadata>>,
): PluginConfigChange[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const changes: PluginConfigChange[] = [];
  for (const key of keys) {
    if (valuesEqual(previous[key], next[key])) continue;
    const metadata = fields[key];
    changes.push({
      key,
      lifecycle: metadata?.lifecycle ?? 'immutable',
      secret: metadata?.secret === true,
      previous: metadata?.secret === true ? '[REDACTED]' : previous[key],
      next: metadata?.secret === true ? '[REDACTED]' : next[key],
    });
  }
  return changes;
}

export function redactPluginConfig(
  options: Readonly<Record<string, unknown>>,
  fields: Readonly<Record<string, PluginConfigFieldMetadata>>,
): Record<string, unknown> {
  const redacted = { ...options };
  for (const [key, metadata] of Object.entries(fields)) {
    if (metadata.secret === true && key in redacted) redacted[key] = '[REDACTED]';
  }
  return redacted;
}

/** Validate an opted-in metadata map against the manifest's schema/default keys. */
export function validatePluginConfigMetadata(
  plugin: Pick<Plugin, 'configFields' | 'configSchema' | 'defaultConfig'>,
): string[] {
  if (!plugin.configFields) return [];
  const declared = plugin.configFields;
  const expected = new Set([
    ...Object.keys(plugin.configSchema?.properties ?? {}),
    ...Object.keys(plugin.defaultConfig ?? {}),
  ]);
  const issues: string[] = [];
  for (const key of expected) {
    if (!declared[key]) issues.push(`missing configFields metadata for "${key}"`);
  }
  for (const [key, metadata] of Object.entries(declared)) {
    if (!['hot', 'restart', 'immutable'].includes(metadata.lifecycle)) {
      issues.push(`invalid lifecycle for configFields."${key}"`);
    }
  }
  return issues;
}

function isPluginEntry(value: unknown): value is PluginConfig {
  return isRecord(value) && typeof value['name'] === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => valuesEqual(value, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => key in right && valuesEqual(left[key], right[key]))
    );
  }
  return false;
}
