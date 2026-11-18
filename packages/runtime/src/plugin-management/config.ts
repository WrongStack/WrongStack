import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfig } from '@wrongstack/contracts/types';
import { atomicWrite, withFileLock } from '@wrongstack/core/utils';
import type { PluginManagementDeps, PluginManagementResult } from './types.js';

/**
 * Read the profile config for a read-modify-write. Only a MISSING file reads as
 * `{}`: callers write the result back over the whole profile, so treating an
 * unreadable or corrupt file as empty wiped every provider, key and setting.
 * A leading UTF-8 BOM is ignorable (RFC 8259) — the config loader accepts it.
 */
export async function readConfig(file: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(
      `Profile config "${file}" is not valid JSON — fix or remove it before changing plugins`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Profile config "${file}" must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function pluginName(p: string | PluginConfig): string {
  return typeof p === 'string' ? p : p.name;
}

export function pluginMatchesSpec(p: string | PluginConfig, spec: string): boolean {
  const name = pluginName(p);
  if (spec === 'telegram' || spec === '@wrongstack/telegram') {
    return name === 'telegram' || name === '@wrongstack/telegram';
  }
  return name === spec;
}

export async function mutateConfigFile<T>(
  file: string,
  backup: PluginManagementDeps['backupConfig'],
  fn: (
    existing: Record<string, unknown>,
  ) => { write: boolean; value: T } | Promise<{ write: boolean; value: T }>,
): Promise<T> {
  return withFileLock(file, async () => {
    const existing = await readConfig(file);
    const outcome = await fn(existing);
    if (outcome.write) {
      await backup?.(file);
      await atomicWrite(file, JSON.stringify(existing, null, 2), { mode: 0o600 });
    }
    return outcome.value;
  });
}

function pluginEntry(spec: string, enabled: boolean, path?: string): string | PluginConfig {
  if (path !== undefined) return { name: spec, path, enabled };
  return enabled ? spec : { name: spec, enabled: false };
}

export async function upsertPlugin(
  spec: string,
  opts: { enabled: boolean; path?: string },
  deps: PluginManagementDeps,
  verb: string,
): Promise<PluginManagementResult> {
  const { plugins, features } = await mutateConfigFile(
    deps.configPath,
    deps.backupConfig,
    (existing) => {
      const current = Array.isArray(existing.plugins)
        ? (existing.plugins as Array<string | PluginConfig>)
        : [];
      const nextEntry = pluginEntry(spec, opts.enabled, opts.path);
      const firstIdx = current.findIndex((p) => pluginMatchesSpec(p, spec));
      let nextPlugins: Array<string | PluginConfig>;
      if (firstIdx >= 0) {
        nextPlugins = current
          .map((p, i) => (i === firstIdx ? nextEntry : p))
          .filter((p, i) => i === firstIdx || !pluginMatchesSpec(p, spec));
      } else {
        nextPlugins = [...current, nextEntry];
      }
      const nextFeatures = {
        ...(isRecord(deps.config.features) ? deps.config.features : {}),
        ...(isRecord(existing.features) ? existing.features : {}),
        plugins: true,
      };
      existing.plugins = nextPlugins;
      existing.features = nextFeatures;
      return { write: true, value: { plugins: nextPlugins, features: nextFeatures } };
    },
  );
  const restartRequired = spec === 'branch-guard' && !opts.enabled ? undefined : true;
  return {
    code: 0,
    level: 'info',
    message:
      `${verb} "${spec}" (${opts.enabled ? 'enabled' : 'disabled'}). Config written to ${deps.configPath}.` +
      (spec === 'branch-guard' && !opts.enabled
        ? ' The running branch-guard hook will disable itself on config update.'
        : ''),
    patch: { plugins, features },
    restartRequired,
  };
}

export function errorResult(message: string): PluginManagementResult {
  return { code: 1, level: 'error', message };
}

// ---------------------------------------------------------------------------
// External plugin trust (TOFU re-pin / listing)
// ---------------------------------------------------------------------------

export function globalPluginsRoot(deps: PluginManagementDeps): string {
  return join(deps.globalRoot ?? join(homedir(), '.wrongstack'), 'plugins');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
