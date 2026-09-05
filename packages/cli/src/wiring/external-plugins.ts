/**
 * External (third-party) plugin loading for the CLI host.
 *
 * Three source kinds, in precedence order:
 *   1. `config.plugins` entries with a bare/npm specifier — dynamically
 *      imported exactly as before (module resolution via the host).
 *   2. `config.plugins` entries with an explicit `path` — resolved against
 *      the project root and imported via `file:` URL.
 *   3. Directory discovery — `<globalRoot>/plugins/*` (user-global, active
 *      by default) and `<projectRoot>/.wrongstack/plugins/*` (project-local,
 *      INACTIVE by default: a cloned repo must not auto-execute plugin code
 *      the user never opted into).
 *
 * Every external plugin passes through, in order:
 *   - enablement resolution (same `resolvePluginEnablement` as built-ins),
 *   - deprecation + builtin-spec guards (passed in by the wiring so this
 *     module stays acyclic with wiring/plugins.ts),
 *   - a PRE-IMPORT TOFU trust gate keyed by the resolved entry file:
 *     the module is hashed before any of its code executes, first load
 *     pins the hash, a changed hash refuses the load until the user
 *     re-pins with `wstack plugin trust <name>`,
 *   - a shape check (default-exported object with name/apiVersion/setup),
 *   - a spoof guard (external plugins may not claim built-in names).
 *
 * First-party/built-in plugins never enter this module.
 */

import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  defaultPluginTrustPath,
  discoverExternalPlugins,
  hashFileContents,
  normalizeTrustKey,
  type PluginTrustStore,
  pinPluginTrust,
  readPluginTrustStore,
  resolvePluginEnablement,
  resolvePluginTarget,
  verifyPluginTrust,
} from '@wrongstack/core/plugin';
import type { Config, Logger, Plugin } from '@wrongstack/core/types';

/** Policy for the external-plugin trust gate. See FeaturesConfig.pluginsTrust. */
export type ExternalPluginTrustMode = 'off' | 'required' | 'tofu' | 'advisory';

/**
 * Resolve the trust mode from config. `true`, `undefined`, and `'tofu'` all
 * map to the documented default (trust on first use); `false` skips the
 * gate; unknown strings fall back to the default rather than inventing
 * behavior.
 */
export function resolveExternalPluginTrustMode(
  raw: boolean | string | undefined,
): ExternalPluginTrustMode {
  if (raw === false) return 'off';
  if (raw === 'required') return 'required';
  if (raw === 'advisory') return 'advisory';
  return 'tofu';
}

/** Resolve a `file:` URL / absolute / relative path to an absolute fs path. */
export function normalizeConfigPath(raw: string, projectRoot: string): string {
  if (raw.startsWith('file:')) return fileURLToPath(raw);
  return isAbsolute(raw) ? raw : resolve(projectRoot, raw);
}

/**
 * Resolve a bare/npm specifier to its entry file WITHOUT importing it.
 * Returns undefined when resolution is unavailable (bundled hosts, exotic
 * specs) — callers then proceed without the pre-import trust gate.
 */
export function resolveSpecifierEntry(spec: string): string | undefined {
  const metaResolve = (import.meta as { resolve?: (specifier: string) => string }).resolve;
  if (typeof metaResolve !== 'function') return undefined;
  try {
    const url = metaResolve(spec);
    return url.startsWith('file:') ? fileURLToPath(url) : undefined;
  } catch {
    return undefined;
  }
}

interface ExternalPluginHooks {
  /** Normalize a config spec to its bare plugin name (null for paths/URLs). */
  nameFromSpec(spec: string): string | null;
  /** True when the spec refers to a built-in plugin (loaded elsewhere). */
  isBuiltinSpec(spec: string): boolean;
  /** Warn-once deprecation check; returns true when the spec is deprecated. */
  warnIfDeprecated(name: string): boolean;
}

interface LoadExternalPluginsContext {
  config: Config;
  log: Logger;
  /** `~/.wrongstack` — anchors global discovery + the default trust store. */
  globalRoot?: string | undefined;
  projectRoot: string;
  /** Plugin names claimed by built-ins — external plugins may not spoof them. */
  reservedNames: ReadonlySet<string>;
  /** Override for tests. Defaults to `~/.wrongstack/plugin-trust.json`. */
  trustStorePath?: string | undefined;
  /** Override for tests. Defaults to native dynamic import. */
  importModule?: ((url: string) => Promise<unknown>) | undefined;
}

type ExternalSource =
  | { kind: 'spec'; spec: string; label: string }
  | { kind: 'path'; spec: string; entryPath: string; label: string }
  | { kind: 'discovery'; spec: string; entryPath: string; label: string };

function validateExternalPluginModule(mod: unknown): { plugin: Plugin } | { error: string } {
  const candidate = (mod as { default?: unknown } | null | undefined)?.default;
  if (candidate === null || typeof candidate !== 'object') {
    return {
      error: `default export missing (got ${candidate === null ? 'null' : typeof candidate}) — external plugin modules must default-export a Plugin object`,
    };
  }
  const p = candidate as Record<string, unknown>;
  if (typeof p.name !== 'string' || p.name.length === 0) {
    return { error: 'plugin.name must be a non-empty string' };
  }
  if (typeof p.apiVersion !== 'string' || p.apiVersion.length === 0) {
    return { error: 'plugin.apiVersion must be a non-empty string (e.g. "^0.1")' };
  }
  if (typeof p.setup !== 'function') {
    return { error: 'plugin.setup(api) must be a function' };
  }
  return { plugin: candidate as Plugin };
}

export async function loadExternalPlugins(
  ctx: LoadExternalPluginsContext,
  hooks: ExternalPluginHooks,
): Promise<Plugin[]> {
  const { config, log } = ctx;
  if (config.features?.plugins === false) return [];

  const importModule = ctx.importModule ?? ((url: string) => import(url));
  const trustMode = resolveExternalPluginTrustMode(config.features?.pluginsTrust);
  if (
    trustMode === 'required' &&
    ctx.globalRoot === undefined &&
    ctx.trustStorePath === undefined
  ) {
    // `required` without a trust store cannot be honored — silently loading
    // untrusted code would defeat the mode, so fail closed with an
    // actionable error instead.
    log.error(
      '[plugins] features.pluginsTrust is "required" but no trust store location is available (no globalRoot) — refusing all external plugins. Configure a global root, or set features.pluginsTrust to "tofu"/"advisory".',
    );
    return [];
  }
  // Without a globalRoot there is nowhere to persist pins — TOFU would
  // re-trust on every boot, so the gate is skipped rather than pretend.
  // (`required` already returned above; for tofu/advisory the downgrade is
  // a warning, not silent trust.)
  const trustEnabled = trustMode !== 'off';
  const trustStorePath =
    ctx.trustStorePath ??
    (ctx.globalRoot !== undefined ? defaultPluginTrustPath(ctx.globalRoot) : undefined);
  let trustStore: PluginTrustStore | undefined;
  // `trustUsable` starts true only when a store location exists and turns
  // false when `advisory` downgrades an unreadable store to warn-and-proceed.
  let trustUsable = trustEnabled && trustStorePath !== undefined;
  if (trustEnabled && !trustUsable) {
    // Trust is on but there is nowhere to persist pins (no globalRoot): the
    // integrity gate cannot run. Never silent — tofu/advisory operators must
    // know their plugins load unpinned (`required` already refused above).
    log.warn(
      '[plugins] features.pluginsTrust is enabled but no trust store location is available (no globalRoot) — external plugins load WITHOUT integrity checks. Configure a global root to enable trust-on-first-use.',
    );
  }
  if (trustUsable && trustStorePath !== undefined) {
    try {
      trustStore = await readPluginTrustStore(trustStorePath);
    } catch (err) {
      // A corrupt trust store must not silently downgrade every pin to
      // "unpinned" (that would re-trust changed code). `required`/`tofu`
      // refuse external plugins entirely until the user fixes the file;
      // `advisory` proceeds ungated with a loud warning.
      const message = err instanceof Error ? err.message : String(err);
      if (trustMode === 'advisory') {
        log.warn(
          `[plugins] trust store unreadable (${message}) — features.pluginsTrust is 'advisory', loading external plugins WITHOUT integrity checks`,
        );
        trustUsable = false;
      } else {
        log.error(`[plugins] ${message}`);
        return [];
      }
    }
  }

  const sources: ExternalSource[] = [];
  const configNames = new Set<string>();

  // ── 1+2. config.plugins entries (specifier or explicit path) ──────────
  for (const p of config.plugins ?? []) {
    const spec = typeof p === 'string' ? p : p.name;
    const configuredPath = typeof p === 'string' || p.path === undefined ? undefined : p.path;
    // Same resolver the built-in path uses: `extensions.<name>.enabled`,
    // explicit plugin entries, and the feature flag must all agree.
    const { enabled } = resolvePluginEnablement({
      name: hooks.nameFromSpec(spec) ?? (typeof p === 'string' ? spec : p.name),
      aliases: [spec],
      defaultState: 'active',
      config,
      matches: (configuredName) => configuredName === spec,
    });
    if (!enabled) continue;
    if (hooks.warnIfDeprecated(hooks.nameFromSpec(spec) ?? '')) continue;
    if (hooks.isBuiltinSpec(spec)) continue;
    if (configuredPath !== undefined) {
      const target = normalizeConfigPath(configuredPath, ctx.projectRoot);
      const entryPath = await resolvePluginTarget(target);
      if (entryPath === null) {
        log.warn(
          `[plugins] config entry "${spec}" path "${configuredPath}" has no resolvable entry (not a file, and no package.json/index fallbacks)`,
        );
        continue;
      }
      sources.push({ kind: 'path', spec, entryPath, label: spec });
      if (typeof p !== 'string') configNames.add(p.name);
    } else {
      sources.push({ kind: 'spec', spec, label: spec });
      const bare = hooks.nameFromSpec(spec);
      if (bare) configNames.add(bare);
    }
  }

  // ── 3. directory discovery ─────────────────────────────────────────────
  const roots = [
    ctx.globalRoot !== undefined
      ? { dir: join(ctx.globalRoot, 'plugins'), defaultState: 'active' as const }
      : undefined,
    {
      dir: join(ctx.projectRoot, '.wrongstack', 'plugins'),
      // Project-local plugins are opt-in: a cloned repository must not
      // auto-execute plugin code the user never enabled.
      defaultState: 'inactive' as const,
    },
  ].filter((r): r is { dir: string; defaultState: 'active' | 'inactive' } => r !== undefined);
  const discovery = await discoverExternalPlugins(roots.map((r) => r.dir));
  for (const skipped of discovery.skipped) {
    log.warn(
      `[plugins] discovered candidate "${skipped.name}" in ${skipped.root} skipped — ${skipped.reason}`,
    );
  }
  for (const candidate of discovery.candidates) {
    const root = roots.find((r) => r.dir === candidate.root);
    const defaultState = root?.defaultState ?? 'inactive';
    const { enabled, source: enablementSource } = resolvePluginEnablement({
      name: candidate.name,
      aliases: [candidate.name],
      defaultState,
      config,
      matches: (configuredName) => configuredName === candidate.name,
    });
    if (!enabled) {
      if (enablementSource !== 'default') {
        log.info(`[plugins] discovered plugin "${candidate.name}" disabled by ${enablementSource}`);
      }
      continue;
    }
    if (configNames.has(candidate.name)) {
      log.info(
        `[plugins] discovered plugin "${candidate.name}" also configured in config.plugins — config entry wins`,
      );
      continue;
    }
    sources.push({
      kind: 'discovery',
      spec: candidate.entryPath,
      entryPath: candidate.entryPath,
      label: candidate.name,
    });
  }

  // ── import + trust gate + validation ───────────────────────────────────
  const loaded: Plugin[] = [];
  const seenNames = new Set<string>();
  for (const source of sources) {
    // Entry resolution without executing module code.
    const entryPath: string | undefined =
      source.kind === 'spec' ? resolveSpecifierEntry(source.spec) : source.entryPath;

    if (trustUsable && trustStorePath !== undefined && entryPath !== undefined) {
      const gate = await gateExternalPluginTrust({
        entryPath,
        spec: source.spec,
        label: source.label,
        store: trustStore,
        storePath: trustStorePath,
        mode: trustMode,
        log,
      });
      if (!gate.ok) continue;
      if (gate.pinned) trustStore = gate.store;
    } else if (trustUsable && entryPath === undefined) {
      if (trustMode === 'required') {
        log.error(
          `[plugins] REFUSING external plugin "${source.label}" — features.pluginsTrust is 'required' and its entry file could not be resolved pre-import (spec "${source.spec}"). Install it so its entry file resolves, or load it by explicit path.`,
        );
        continue;
      }
      log.warn(
        `[plugins] trust check skipped for "${source.label}" — entry file could not be resolved pre-import`,
      );
    }

    const importTarget =
      source.kind === 'spec' ? source.spec : pathToFileURL(source.entryPath).href;
    let mod: unknown;
    try {
      mod = await importModule(importTarget);
    } catch (err) {
      log.warn(`[plugins] external plugin "${source.label}" failed to load`, err);
      continue;
    }
    const validated = validateExternalPluginModule(mod);
    if ('error' in validated) {
      log.warn(`[plugins] external plugin "${source.label}" invalid — ${validated.error}`);
      continue;
    }
    const plugin = validated.plugin;
    if (ctx.reservedNames.has(plugin.name)) {
      log.warn(
        `[plugins] external plugin "${source.label}" declares reserved name "${plugin.name}" — built-in plugins own that name; rename the plugin`,
      );
      continue;
    }
    if (seenNames.has(plugin.name)) {
      log.warn(
        `[plugins] external plugin "${source.label}" duplicates already-loaded plugin "${plugin.name}" — first one wins`,
      );
      continue;
    }
    seenNames.add(plugin.name);
    loaded.push(plugin);
  }
  return loaded;
}

type TrustGateResult =
  | { ok: true; pinned: false }
  | { ok: true; pinned: true; store: PluginTrustStore }
  | { ok: false; pinned: false };

async function gateExternalPluginTrust(args: {
  entryPath: string;
  spec: string;
  label: string;
  store: PluginTrustStore | undefined;
  storePath: string;
  mode: ExternalPluginTrustMode;
  log: Logger;
}): Promise<TrustGateResult> {
  const { spec, label, store, storePath, mode, log } = args;
  // Pin keys are canonical forward-slash paths regardless of how the entry
  // was resolved (config path, discovery, module resolution).
  const entryPath = normalizeTrustKey(args.entryPath);
  if (!store) return { ok: true, pinned: false };
  let integrity: string;
  try {
    integrity = await hashFileContents(entryPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (mode === 'required') {
      log.error(
        `[plugins] REFUSING external plugin "${label}" — features.pluginsTrust is 'required' and its entry file could not be read (${message})`,
      );
      return { ok: false, pinned: false };
    }
    log.warn(`[plugins] trust check skipped for "${label}" — entry could not be read (${message})`);
    return { ok: true, pinned: false };
  }
  const verification = verifyPluginTrust(entryPath, integrity, store);
  if (verification.status === 'trusted') return { ok: true, pinned: false };
  if (verification.status === 'unpinned') {
    try {
      const next = await pinPluginTrust(storePath, entryPath, entryPath, integrity, spec);
      log.info(
        `[plugins] external plugin "${label}" trusted on first use (pinned ${integrity.slice(0, 19)}…)`,
      );
      return { ok: true, pinned: true, store: next };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Pinning is best-effort by default: failing to persist the pin must
      // not block a load the user explicitly configured. `required` flips
      // that — an unpersistable pin would mean the plugin runs unverified.
      if (mode === 'required') {
        log.error(
          `[plugins] REFUSING external plugin "${label}" — features.pluginsTrust is 'required' and its first-use pin could not be persisted (${message})`,
        );
        return { ok: false, pinned: false };
      }
      log.warn(`[plugins] could not persist trust pin for "${label}" (${message})`);
      return { ok: true, pinned: false };
    }
  }
  const changedMessage =
    `its entry file changed since it was first trusted (pinned ${verification.pinnedAt}). ` +
    `If you expected this update, re-pin it: wstack plugin trust ${label}`;
  if (mode === 'advisory') {
    log.warn(
      `[plugins] external plugin "${label}" — ${changedMessage} features.pluginsTrust is 'advisory', loading anyway WITHOUT integrity enforcement`,
    );
    return { ok: true, pinned: false };
  }
  log.error(`[plugins] REFUSING external plugin "${label}" — ${changedMessage}`);
  return { ok: false, pinned: false };
}
