import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config, PluginConfig, PluginManagerConfig } from '@wrongstack/contracts/types';
import {
  defaultPluginTrustPath,
  discoverExternalPlugins,
  hashFileContents,
  normalizeTrustKey,
  type PluginEnablementSource,
  pinPluginTrust,
  readPluginTrustStore,
  resolvePluginEnablement,
  resolvePluginTarget,
  unpinPluginTrust,
} from '@wrongstack/core/plugin';
import { atomicWrite } from '@wrongstack/core/utils';
import {
  PLUGIN_AUDIT_ENTRIES,
  type PluginAuditEntry,
} from '@wrongstack/plugins/plugin-audit-catalog';
import {
  errorResult,
  globalPluginsRoot,
  isRecord,
  pluginName,
  readConfig,
  upsertPlugin,
} from './plugin-config.js';
import { runPluginLlmCommand } from './plugin-llm-command.js';
import type { PluginManagementDeps, PluginManagementResult } from './plugin-management-types.js';
import { installPluginPackage } from './plugin-package-install.js';
import { normalizeConfigPath, resolveSpecifierEntry } from './wiring/external-plugins.js';

export type { PluginAuditEntry };
// The plugin audit catalog now lives in @wrongstack/plugins/plugin-audit-catalog
// (host-owned entries joined with the generated official catalog) so the CLI
// plugin manager and the WebUI settings panel share one source of truth.
// Re-exported here for existing CLI consumers (management-tools.ts, /plugin).
export { PLUGIN_AUDIT_ENTRIES };

const OFFICIAL_PLUGINS = [
  {
    alias: 'telegram',
    specifier: '@wrongstack/telegram',
    description: 'Telegram bridge for prompts, notifications, and slash commands.',
  },
  {
    alias: 'lsp',
    specifier: '@wrongstack/plug-lsp',
    description: 'Language Server Protocol tools for code intelligence.',
  },
] as const;

const OFFICIAL_ALIASES = new Map<string, string>(
  OFFICIAL_PLUGINS.flatMap((p) => [
    [p.alias, p.specifier],
    [p.specifier, p.specifier],
  ]),
);

export async function runPluginManagementCommand(
  args: string[],
  deps: PluginManagementDeps,
): Promise<PluginManagementResult> {
  const sub = args[0];
  if (!sub || sub === 'list' || sub === 'status') {
    return {
      code: 0,
      level: 'output',
      message: renderConfiguredPlugins(deps.config),
    };
  }
  if (sub === 'official' || sub === 'officials') {
    return {
      code: 0,
      level: 'output',
      message: renderOfficialPlugins(deps.config),
    };
  }
  if (sub === 'report' || sub === 'audit' || sub === 'menu') {
    return {
      code: 0,
      level: 'output',
      message: renderPluginAuditReport(deps.config),
    };
  }
  if (sub === 'add' || sub === 'install') {
    const spec = args[1];
    if (!spec) {
      return errorResult(
        'Usage: wstack plugin add <specifier|official-alias> [--disabled] [--install [--pm npm|pnpm|yarn|bun] [--run-scripts]]',
      );
    }
    // Official plugins ship with the CLI — installing from npm is a no-op.
    if (args.includes('--install') && !OFFICIAL_ALIASES.has(resolvePluginSpecifier(spec))) {
      return installPluginPackage(spec, args, deps);
    }
    return upsertPlugin(
      resolvePluginSpecifier(spec),
      { enabled: !args.includes('--disabled') },
      deps,
      'Added',
    );
  }
  if (sub === 'remove' || sub === 'rm' || sub === 'uninstall') {
    const spec = args[1];
    if (!spec) {
      return errorResult('Usage: wstack plugin remove <specifier|official-alias>');
    }
    return removePlugin(resolvePluginSpecifier(spec), deps);
  }
  if (sub === 'enable' || sub === 'disable') {
    const spec = args[1];
    if (!spec) {
      return errorResult(`Usage: wstack plugin ${sub} <specifier|official-alias>`);
    }
    return upsertPlugin(
      resolvePluginSpecifier(spec),
      { enabled: sub === 'enable' },
      deps,
      sub === 'enable' ? 'Enabled' : 'Disabled',
    );
  }
  if (sub === 'toggle') {
    const spec = args[1];
    if (!spec) {
      return errorResult('Usage: wstack plugin toggle <plugin-name|official-alias>');
    }
    return togglePlugin(resolvePluginToggleSpecifier(spec), deps);
  }
  if (sub === 'trust') {
    return runPluginTrustCommand(args.slice(1), deps);
  }
  if (sub === 'manager') {
    return runPluginManagerPolicyCommand(args.slice(1), deps);
  }
  if (sub === 'llm') {
    return runPluginLlmCommand(args.slice(1), deps);
  }
  return errorResult(
    `Unknown plugin subcommand: ${sub}\nUsage: wstack plugin [list|status|report|menu|official|add|install|remove|enable|disable|toggle|trust|manager|llm]`,
  );
}

const PLUGIN_MANAGER_POLICY_USAGE = [
  'Usage:',
  '  wstack plugin manager                         List plugins locked against LLM state changes.',
  '  wstack plugin manager lock <plugin|*>         Prevent plugin_manager from enabling/disabling it.',
  '  wstack plugin manager unlock <plugin|*>       Restore plugin_manager enable/disable access.',
  '',
  'This policy affects only the LLM-facing plugin_manager tool. Human /plugin and',
  'wstack plugin enable/disable commands remain available.',
].join('\n');

async function runPluginManagerPolicyCommand(
  args: string[],
  deps: PluginManagementDeps,
): Promise<PluginManagementResult> {
  const action = args[0] ?? 'list';
  if (action === 'list') {
    const locked = deps.config.pluginManager?.locked ?? [];
    return {
      code: 0,
      level: 'output',
      message:
        locked.length === 0
          ? 'LLM plugin-manager policy: no plugins are locked.'
          : `LLM plugin-manager policy — locked (${locked.length}):\n${locked.map((name) => `  ${name}`).join('\n')}`,
    };
  }

  if (action !== 'lock' && action !== 'unlock') {
    return errorResult(PLUGIN_MANAGER_POLICY_USAGE);
  }
  const rawName = args[1];
  if (!rawName) return errorResult(PLUGIN_MANAGER_POLICY_USAGE);
  const name = rawName === '*' ? '*' : resolvePluginToggleSpecifier(rawName);

  const existing = await readConfig(deps.configPath);
  const filePolicy = isRecord(existing.pluginManager) ? existing.pluginManager : undefined;
  const current = Array.isArray(filePolicy?.['locked'])
    ? filePolicy['locked'].filter((entry): entry is string => typeof entry === 'string')
    : [...(deps.config.pluginManager?.locked ?? [])];
  const canonical = canonicalPolicyName(name);
  const next =
    action === 'lock'
      ? current.some((entry) => canonicalPolicyName(entry) === canonical)
        ? current
        : [...current, name]
      : current.filter((entry) => canonicalPolicyName(entry) !== canonical);

  const pluginManager: PluginManagerConfig = { locked: next };
  existing.pluginManager = { ...(filePolicy ?? {}), ...pluginManager };
  await atomicWrite(deps.configPath, JSON.stringify(existing, null, 2), { mode: 0o600 });

  return {
    code: 0,
    level: 'info',
    message:
      action === 'lock'
        ? `Locked "${name}" against LLM enable/disable changes. Human plugin commands still work.`
        : `Unlocked "${name}" for LLM enable/disable changes.`,
    patch: { pluginManager },
  };
}

function canonicalPolicyName(name: string): string {
  if (name === '*') return name;
  return resolvePluginToggleSpecifier(name).trim().toLowerCase();
}

function resolvePluginSpecifier(input: string): string {
  return OFFICIAL_ALIASES.get(input.toLowerCase()) ?? input;
}

function resolvePluginToggleSpecifier(input: string): string {
  if (input.toLowerCase() === '@wrongstack/telegram') return 'telegram';
  if (auditEntryFor(input)) return input;
  return resolvePluginSpecifier(input);
}

function renderOfficialPlugins(config?: Config): string {
  return [
    'Official plugins:',
    ...OFFICIAL_PLUGINS.map((p) => {
      const state = config ? officialPluginState(config, p.specifier) : '';
      const status = state ? `${state.padEnd(14)} ` : '';
      return `  ${p.alias.padEnd(12)} ${status}${p.specifier.padEnd(24)} ${p.description}`;
    }),
    '',
    'Use `wstack plugin add <alias>` or `/plugin install <alias>`.',
  ].join('\n');
}

export function renderConfiguredPlugins(config: Config): string {
  const plugins = config.plugins ?? [];
  if (plugins.length === 0) {
    return [
      'No plugins configured.',
      'Use `wstack plugin add <specifier>` or `/plugin install <official-alias>`.',
    ].join('\n');
  }
  return plugins
    .map((p) => {
      const name = pluginName(p);
      const enabled = typeof p === 'object' && p.enabled === false ? 'disabled' : 'enabled';
      const official = OFFICIAL_PLUGINS.find((entry) => entry.specifier === name);
      const isExternalPath = typeof p === 'object' && p.path !== undefined;
      const suffix = official ? ` (${official.alias})` : isExternalPath ? ' (external)' : '';
      return `  ${`${name}${suffix}`.padEnd(44)} ${enabled}`;
    })
    .join('\n');
}

export function renderPluginAuditReport(config: Config): string {
  const configured = config.plugins ?? [];
  const lines = [
    'Plugin audit report:',
    '  State shows the effective boot state. Default-active plugins run unless disabled in config.',
    '  Source: config = plugins[] entry, ext = extensions.<name>.enabled, feature = features.plugins.',
    '  Built-in audit rows are toggleable unless a future row explicitly marks itself locked.',
    '',
    '  Built-in audit entries:',
  ];

  for (const entry of PLUGIN_AUDIT_ENTRIES) {
    const { state, source } = effectiveAuditState(config, entry);
    const policy = entry.canDisable ? 'toggleable' : lockedReason(entry);
    lines.push(
      `  ${entry.name.padEnd(24)} ${state.padEnd(8)} ${source.padEnd(8)} risk=${entry.risk.padEnd(6)} ${policy.padEnd(24)} ${entry.summary}`,
    );
  }

  const extra = configured.filter(
    (plugin) => !PLUGIN_AUDIT_ENTRIES.some((entry) => pluginMatchesToggleSpec(plugin, entry.name)),
  );
  if (extra.length > 0) {
    lines.push('', '  Configured plugins outside the audit list:');
    for (const plugin of extra) {
      const name = pluginName(plugin);
      const state = typeof plugin === 'object' && plugin.enabled === false ? 'disabled' : 'enabled';
      const path = typeof plugin === 'object' && plugin.path !== undefined ? plugin.path : '';
      const risk = path ? 'external' : 'custom';
      const note = path ? `user-configured external plugin (${path})` : 'user-configured plugin';
      lines.push(`  ${name.padEnd(24)} ${state.padEnd(8)} config   risk=${risk.padEnd(6)} ${note}`);
    }
  }

  lines.push(
    '',
    'Use `/plugin menu` in the TUI, or `wstack plugin toggle <name>` for toggleable rows.',
  );
  return lines.join('\n');
}

function pluginMatchesToggleSpec(p: string | PluginConfig, spec: string): boolean {
  const name = pluginName(p);
  if (spec === 'telegram') return name === 'telegram' || name === '@wrongstack/telegram';
  return name === spec;
}

/** Column label for the audit report's `source` field. */
const AUDIT_STATE_SOURCE_LABEL: Record<PluginEnablementSource, string> = {
  'feature-flag': 'feature',
  'plugin-entry': 'config',
  extension: 'ext',
  default: 'default',
};

function effectiveAuditState(
  config: Config,
  entry: PluginAuditEntry,
): { state: 'enabled' | 'disabled'; source: string } {
  // Shares one precedence with the loader (cli/wiring/plugins.ts) and the
  // plugin_manager tool — see resolvePluginEnablement. Reading only
  // `config.plugins` here is what let a plugin enabled through
  // `extensions.<name>.enabled` run while this report called it disabled.
  const { enabled, source } = resolvePluginEnablement({
    name: entry.name,
    defaultState: entry.defaultState,
    config,
    matches: (spec) => pluginMatchesToggleSpec(spec, entry.name),
  });
  return {
    state: enabled ? 'enabled' : 'disabled',
    source: AUDIT_STATE_SOURCE_LABEL[source],
  };
}

function lockedReason(entry: PluginAuditEntry): string {
  if (entry.canDisable) return 'toggleable';
  if (entry.name === 'secret-scanner') {
    return 'locked: safety guard';
  }
  return 'locked: core surface';
}

function auditEntryFor(spec: string): PluginAuditEntry | undefined {
  return PLUGIN_AUDIT_ENTRIES.find((entry) => entry.name === spec);
}

function officialPluginState(
  config: Config,
  spec: string,
): 'enabled' | 'disabled' | 'not configured' {
  const match = (config.plugins ?? []).find((p) => pluginName(p) === spec);
  if (!match) return 'not configured';
  // Configured in `plugins[]`, so report the EFFECTIVE state rather than
  // re-deriving it from that one array — `extensions.<name>.enabled` can
  // override it, and this listing disagreeing with the loader is the whole
  // bug class `resolvePluginEnablement` exists to end.
  const { enabled } = resolvePluginEnablement({
    name: spec,
    config,
    matches: (candidate) => pluginMatchesToggleSpec(candidate, spec),
  });
  return enabled ? 'enabled' : 'disabled';
}

async function togglePlugin(
  spec: string,
  deps: PluginManagementDeps,
): Promise<PluginManagementResult> {
  const auditEntry = auditEntryFor(spec);
  if (auditEntry?.canDisable === false) {
    return errorResult(`Plugin "${spec}" is locked and cannot be toggled from the plugin menu.`);
  }

  const existing = await readConfig(deps.configPath);
  const plugins = Array.isArray(existing.plugins)
    ? (existing.plugins as Array<string | PluginConfig>)
    : [];
  const idx = plugins.findIndex((p) => pluginMatchesToggleSpec(p, spec));
  const configured = idx >= 0 ? plugins[idx] : undefined;
  // The SAME precedence the report path uses (`effectiveAuditState` above
  // calls it) and the loader uses. The inline form here ignored
  // `extensions.<name>.enabled` and `features.plugins`, so with
  // `extensions: {"wstack-prompts": {"enabled": false}}` and no `plugins[]`
  // entry, `plugin report` correctly said disabled while `toggle` computed
  // `enabled = true`, wrote `{enabled: false}` and printed "Disabled" — the
  // user who meant to ENABLE it had to toggle twice.
  //
  // Resolve against the config FILE, not `deps.config`. `toggle` reads the
  // file, flips one entry and writes it back, so the file is the state being
  // toggled; the in-memory snapshot can be older (another surface edited it,
  // or the session started before the last change) and is missing `plugins`
  // entirely in the CLI's own callers. `deps.config` still supplies the layers
  // the file omits — `extensions`, `features` — which is the whole reason this
  // goes through the shared resolver.
  const effectiveConfig = { ...deps.config, ...existing } as Config;
  const { enabled } = resolvePluginEnablement({
    name: spec,
    defaultState: auditEntry?.defaultState,
    config: effectiveConfig,
    matches: (candidate) => pluginMatchesToggleSpec(candidate, spec),
  });

  if (!configured && !auditEntry) {
    return errorResult(
      `Plugin "${spec}" is not configured. Use "wstack plugin add ${spec}" first.`,
    );
  }

  let nextPlugins: Array<string | PluginConfig>;
  let nextEnabled: boolean;
  if (enabled) {
    nextEnabled = false;
    nextPlugins = plugins.filter((p) => !pluginMatchesToggleSpec(p, spec));
    if (auditEntry?.defaultState !== 'inactive') {
      nextPlugins.push({ name: spec, enabled: false });
    }
  } else {
    nextEnabled = true;
    if (auditEntry?.defaultState === 'active') {
      nextPlugins = plugins.filter((p) => !pluginMatchesToggleSpec(p, spec));
    } else {
      nextPlugins = plugins.filter((p) => !pluginMatchesToggleSpec(p, spec));
      nextPlugins.push(spec);
    }
  }

  const features = {
    ...(isRecord(deps.config.features) ? deps.config.features : {}),
    ...(isRecord(existing.features) ? existing.features : {}),
    plugins: true,
  };
  existing.plugins = nextPlugins;
  existing.features = features;
  await atomicWrite(deps.configPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
  const restartRequired = spec === 'branch-guard' && !nextEnabled ? undefined : true;
  return {
    code: 0,
    level: 'info',
    message:
      `${nextEnabled ? 'Enabled' : 'Disabled'} "${spec}". Config written to ${deps.configPath}.` +
      (spec === 'branch-guard' && !nextEnabled
        ? ' The running branch-guard hook will disable itself on config update.'
        : ''),
    patch: { plugins: nextPlugins, features },
    restartRequired,
  };
}

async function removePlugin(
  spec: string,
  deps: PluginManagementDeps,
): Promise<PluginManagementResult> {
  const existing = await readConfig(deps.configPath);
  const plugins = Array.isArray(existing.plugins)
    ? (existing.plugins as Array<string | PluginConfig>)
    : [];
  const next = plugins.filter((p) => pluginName(p) !== spec);
  if (next.length === plugins.length) {
    return errorResult(`Plugin "${spec}" not in config.`);
  }
  existing.plugins = next;
  await atomicWrite(deps.configPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
  return {
    code: 0,
    level: 'info',
    message: `Removed "${spec}" from config.`,
    patch: { plugins: next },
    restartRequired: true,
  };
}

/**
 * Resolve the entry file an external plugin name refers to, so the trust
 * command can hash and pin exactly what the loader would import. Order:
 * explicit `path` config entries, then directory discovery roots, then npm
 * specifiers via module resolution.
 */
async function resolveExternalPluginEntry(
  name: string,
  deps: PluginManagementDeps,
): Promise<string | undefined> {
  const projectRoot = process.cwd();
  for (const p of deps.config.plugins ?? []) {
    if (typeof p === 'object' && p.name === name && p.path !== undefined) {
      const target = normalizeConfigPath(p.path, projectRoot);
      const entry = await resolvePluginTarget(target);
      if (entry) return entry;
    }
  }
  const { candidates } = await discoverExternalPlugins([
    globalPluginsRoot(deps),
    join(projectRoot, '.wrongstack', 'plugins'),
  ]);
  const discovered = candidates.find((c) => c.name === name);
  if (discovered) return discovered.entryPath;
  for (const p of deps.config.plugins ?? []) {
    const spec = typeof p === 'string' ? p : p.name;
    if (spec === name) {
      const resolved = resolveSpecifierEntry(spec);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

const PLUGIN_TRUST_USAGE = [
  'Usage:',
  '  wstack plugin trust                       List pinned external plugins.',
  '  wstack plugin trust <name>                Re-pin an external plugin whose code changed.',
  '  wstack plugin trust <name> --remove       Drop the pin (plugin re-trusts on next load).',
].join('\n');

async function runPluginTrustCommand(
  args: string[],
  deps: PluginManagementDeps,
): Promise<PluginManagementResult> {
  const storePath = defaultPluginTrustPath(join(deps.globalRoot ?? join(homedir(), '.wrongstack')));
  const positional = args.filter((a) => !a.startsWith('--'));
  const name = positional[0];
  const remove = args.includes('--remove') || args.includes('--unpin');

  if (args.includes('--list') || (name === undefined && !remove && args.length === 0)) {
    const store = await readPluginTrustStore(storePath);
    const entries = Object.entries(store.pinned);
    if (entries.length === 0) {
      return { code: 0, level: 'output', message: 'No external plugins pinned yet.' };
    }
    return {
      code: 0,
      level: 'output',
      message: [
        `Pinned external plugins (${entries.length}):`,
        ...entries.map(
          ([entry, pin]) =>
            `  ${entry}\n      pinned ${pin.pinnedAt}${pin.spec ? ` from ${pin.spec}` : ''}`,
        ),
      ].join('\n'),
    };
  }
  if (!name) return errorResult(PLUGIN_TRUST_USAGE);

  // Pins are keyed by entry file path; accept either a plugin name (resolved
  // through config/discovery) or a raw entry path for cleanup of stale pins.
  const store = await readPluginTrustStore(storePath);
  let entry: string | undefined;
  if (store.pinned[name] !== undefined) {
    entry = name;
  } else if (store.pinned[normalizeTrustKey(name)] !== undefined) {
    entry = normalizeTrustKey(name);
  } else {
    entry = await resolveExternalPluginEntry(name, deps);
  }

  if (remove) {
    if (!entry) return errorResult(`No trust pin found for "${name}".`);
    await unpinPluginTrust(storePath, normalizeTrustKey(entry));
    return { code: 0, level: 'info', message: `Removed trust pin for "${entry}".` };
  }
  if (!entry) {
    return errorResult(
      `Could not resolve an external plugin named "${name}" — check config.plugins entries and the plugins directories.`,
    );
  }
  const canonical = normalizeTrustKey(entry);
  let integrity: string;
  try {
    integrity = await hashFileContents(canonical);
  } catch (err) {
    return errorResult(
      `Could not read "${canonical}" (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  await pinPluginTrust(storePath, canonical, canonical, integrity, name);
  return {
    code: 0,
    level: 'info',
    message: `Re-pinned "${name}" → ${integrity.slice(0, 19)}… (${canonical}).`,
  };
}
