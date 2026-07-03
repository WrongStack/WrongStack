import * as fs from 'node:fs/promises';
import { atomicWrite, type Config, type PluginConfig } from '@wrongstack/core';

export const OFFICIAL_PLUGINS = [
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

export interface PluginAuditEntry {
  name: string;
  risk: 'low' | 'medium' | 'high';
  summary: string;
  defaultState: 'active' | 'inactive';
  canDisable: boolean;
}

export const PLUGIN_AUDIT_ENTRIES: readonly PluginAuditEntry[] = [
  {
    name: 'wstack-prompts',
    risk: 'medium',
    summary: 'Prompt library and prompt authoring commands.',
    defaultState: 'active',
    canDisable: false,
  },
  {
    name: 'wstack-sync',
    risk: 'medium',
    summary: 'Cloud sync commands for prompts, skills, settings, memory, and history.',
    defaultState: 'active',
    canDisable: false,
  },
  {
    name: 'wstack-git',
    risk: 'high',
    summary: 'Git commands for commit, status checks, and push.',
    defaultState: 'active',
    canDisable: false,
  },
  {
    name: 'wstack-observability',
    risk: 'low',
    summary: 'Runtime metrics and health slash commands.',
    defaultState: 'active',
    canDisable: false,
  },
  {
    name: 'wstack-security',
    risk: 'high',
    summary: 'Security scanning backend used by first-party security flows.',
    defaultState: 'active',
    canDisable: false,
  },
  {
    name: 'wstack-chimera',
    risk: 'medium',
    summary: 'Post-session code quality review agent.',
    defaultState: 'active',
    canDisable: false,
  },
  {
    name: 'wstack-skills',
    risk: 'medium',
    summary: 'Skill library, authoring, install, update, and uninstall commands.',
    defaultState: 'active',
    canDisable: false,
  },
  {
    name: 'wstack-plan',
    risk: 'medium',
    summary: 'Strategic plan board slash command.',
    defaultState: 'active',
    canDisable: false,
  },
  {
    name: 'auto-doc',
    risk: 'medium',
    summary: 'Generates JSDoc/TSDoc comments for source files.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'git-autocommit',
    risk: 'high',
    summary: 'Stages files and creates AI-generated conventional commits.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'shell-check',
    risk: 'low',
    summary: 'Runs shellcheck on shell scripts.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'cost-tracker',
    risk: 'low',
    summary: 'Tracks token usage and estimated session cost.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'file-watcher',
    risk: 'medium',
    summary: 'Watches project files and emits change events.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'cron',
    risk: 'medium',
    summary: 'Schedules recurring in-session tasks.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'template-engine',
    risk: 'medium',
    summary: 'Expands and writes file templates.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'semver-bump',
    risk: 'high',
    summary: 'Computes version bumps, changelogs, and tags.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'secret-scanner',
    risk: 'high',
    summary: 'Blocks or redacts credential leaks in tool input and output.',
    defaultState: 'active',
    canDisable: false,
  },
  {
    name: 'todo-tracker',
    risk: 'low',
    summary: 'Persistent project-scoped todo backlog.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'token-budget',
    risk: 'medium',
    summary: 'Warns or stops when token budgets are exceeded.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'lint-gate',
    risk: 'medium',
    summary: 'Runs lint checks before write/edit commits.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'branch-guard',
    risk: 'high',
    summary: 'Blocks commits, pushes, and merges on protected branches.',
    defaultState: 'active',
    canDisable: false,
  },
  {
    name: 'diff-summary',
    risk: 'low',
    summary: 'Injects compact git diff context after edits.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'commit-validator',
    risk: 'medium',
    summary: 'Validates conventional commit format before commits.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'format-on-save',
    risk: 'medium',
    summary: 'Runs formatter after write/edit tool calls.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'test-runner-gate',
    risk: 'medium',
    summary: 'Runs relevant tests after source edits.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'import-organizer',
    risk: 'medium',
    summary: 'Sorts imports and applies safe linter fixes after edits.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'todo-listener',
    risk: 'low',
    summary: 'Broadcasts todo tool updates to the project mailbox.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'session-recap',
    risk: 'low',
    summary: 'Posts a session recap to the project mailbox on stop.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'spec-linker',
    risk: 'low',
    summary: 'Finds unlinked plugin references in markdown edits.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'loop-breaker',
    risk: 'low',
    summary: 'Detects runaway tool-call loops; warns, then blocks repeats.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'path-guard',
    risk: 'medium',
    summary: 'Blocks writes and destructive commands on protected paths.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'context-pins',
    risk: 'low',
    summary: 'Pins durable facts into the system prompt across compactions.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'checkpoint',
    risk: 'medium',
    summary: 'Snapshots files before edits and restores pre-edit states.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'error-lens',
    risk: 'low',
    summary: 'Distills failed command output into compact error digests.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'dep-guard',
    risk: 'medium',
    summary: 'Supervises dependency installs: deny list and typosquat warnings.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'config-validator',
    risk: 'low',
    summary: 'Validates JSON/YAML/TOML files right after write/edit.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'notify-hub',
    risk: 'medium',
    summary: 'Sends session events and ad-hoc notifications to a webhook.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'changelog-writer',
    risk: 'low',
    summary: 'Collects session work and writes Keep-a-Changelog entries.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'injection-shield',
    risk: 'low',
    summary: 'Flags prompt-injection patterns in tool output.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'llm-cache',
    risk: 'medium',
    summary: 'Caches identical provider requests (opt-in; wraps every LLM call).',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'model-router',
    risk: 'medium',
    summary: 'Routes each LLM call to a different model by size/tool rules (opt-in).',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'prompt-firewall',
    risk: 'high',
    summary: 'Detects/redacts credential leaks on the provider wire (opt-in).',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'auto-escalate',
    risk: 'medium',
    summary: 'Retries with an escalated model on transient provider errors (opt-in).',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'token-throttle',
    risk: 'medium',
    summary: 'Rolling-window tokens/min rate limiting via provider-call delays (opt-in).',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: '@wrongstack/plug-lsp',
    risk: 'medium',
    summary: 'Language Server Protocol tools and slash commands.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'telegram',
    risk: 'medium',
    summary: 'Telegram bridge for messages, approvals, and notifications.',
    defaultState: 'active',
    canDisable: true,
  },
];

export interface PluginManagementDeps {
  config: Config;
  configPath: string;
}

export interface PluginManagementResult {
  code: number;
  level: 'output' | 'info' | 'error';
  message: string;
  patch?: {
    plugins?: (string | PluginConfig)[] | undefined;
    features?: Record<string, unknown>;
    /**
     * Full replacement `extensions` map (patchConfig is a SHALLOW merge,
     * so per-plugin llm overrides must ship the whole merged object).
     */
    extensions?: Record<string, Record<string, unknown>> | undefined;
  };
  restartRequired?: boolean | undefined;
}

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
      return errorResult('Usage: wstack plugin add <specifier|official-alias> [--disabled]');
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
  if (sub === 'llm') {
    return runPluginLlmCommand(args.slice(1), deps);
  }
  return errorResult(
    `Unknown plugin subcommand: ${sub}\nUsage: wstack plugin [list|status|report|menu|official|add|install|remove|enable|disable|toggle|llm]`,
  );
}

const PLUGIN_LLM_USAGE = [
  'Usage:',
  '  wstack plugin llm                               List every per-plugin LLM override.',
  "  wstack plugin llm <plugin>                      Show one plugin's LLM override.",
  '  wstack plugin llm <plugin> <provider> [model]   Route this plugin through a provider (and model).',
  '  wstack plugin llm <plugin> - <model>            Keep the session provider, override only the model.',
  '  wstack plugin llm <plugin> --clear              Remove the override (back to the session default).',
  '',
  'The override is stored as config.extensions.<plugin>.llm and is used by',
  'every api.llm call the plugin makes. Without an override, plugins follow',
  'the active session provider/model (the chat leader).',
].join('\n');

/**
 * Render every configured per-plugin LLM override. Reads
 * `config.extensions.<plugin>.llm` across all plugins so the user can
 * see, at a glance, which plugins deviate from the session default.
 */
function renderPluginLlmOverviews(config: Config, sessionDefault: string): string {
  const rows: Array<{ name: string; provider: string; model: string }> = [];
  for (const [pluginName, ext] of Object.entries(config.extensions ?? {})) {
    const llm = (ext as Record<string, unknown>)?.['llm'];
    if (llm && typeof llm === 'object') {
      const o = llm as { provider?: string; model?: string };
      rows.push({
        name: pluginName,
        provider: o.provider ?? '(session)',
        model: o.model ?? '(session)',
      });
    }
  }
  const lines = [`Per-plugin LLM routing (session default: ${sessionDefault}):`];
  if (rows.length === 0) {
    lines.push(
      '  No plugin overrides — every plugin follows the session default.',
      '  Set one with: wstack plugin llm <plugin> <provider> [model]',
    );
  } else {
    rows.sort((a, b) => a.name.localeCompare(b.name));
    for (const r of rows) {
      lines.push(`  ${r.name.padEnd(24)} provider=${r.provider.padEnd(16)} model=${r.model}`);
    }
    lines.push('', 'Clear one with: wstack plugin llm <plugin> --clear');
  }
  return lines.join('\n');
}

/**
 * `wstack plugin llm …` — per-plugin LLM routing. The chat leader's
 * provider/model stays the DEFAULT; this stores an override under
 * `config.extensions[<plugin>].llm = { provider?, model? }` which
 * `api.llm` resolves ahead of the session default on every call.
 */
async function runPluginLlmCommand(
  args: string[],
  deps: PluginManagementDeps,
): Promise<PluginManagementResult> {
  const sessionDefault = `${deps.config.provider ?? '?'} / ${deps.config.model ?? '?'}`;

  // ── List: `plugin llm` (no name) or `plugin llm list` ──────────────
  if (args.length === 0 || args[0] === 'list') {
    return {
      code: 0,
      level: 'output',
      message: renderPluginLlmOverviews(deps.config, sessionDefault),
    };
  }

  const name = args[0];
  if (!name || name.startsWith('-')) return errorResult(PLUGIN_LLM_USAGE);

  const currentOverride = deps.config.extensions?.[name]?.['llm'];

  // ── Show ───────────────────────────────────────────────────────────
  if (args.length === 1) {
    const lines = [`LLM routing for plugin "${name}":`];
    if (currentOverride && typeof currentOverride === 'object') {
      const o = currentOverride as { provider?: string; model?: string };
      lines.push(
        `  override: provider=${o.provider ?? '(session)'} model=${o.model ?? '(session)'}`,
        `  session default: ${sessionDefault}`,
      );
    } else {
      lines.push(
        `  no override — follows the session default (${sessionDefault}).`,
        `  Set one with: wstack plugin llm ${name} <provider> [model]`,
      );
    }
    return { code: 0, level: 'output', message: lines.join('\n') };
  }

  const existing = await readConfig(deps.configPath);
  const fileExtensions = isRecord(existing.extensions)
    ? (existing.extensions as Record<string, unknown>)
    : {};
  const pluginExt = isRecord(fileExtensions[name])
    ? { ...(fileExtensions[name] as Record<string, unknown>) }
    : {};

  // ── Clear ──────────────────────────────────────────────────────────
  if (args[1] === '--clear' || args[1] === 'clear') {
    if (!('llm' in pluginExt) && !currentOverride) {
      return { code: 0, level: 'info', message: `Plugin "${name}" has no LLM override.` };
    }
    delete pluginExt['llm'];
    if (Object.keys(pluginExt).length === 0) delete fileExtensions[name];
    else fileExtensions[name] = pluginExt;
    existing.extensions = fileExtensions;
    await atomicWrite(deps.configPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
    const merged = mergeExtensionsForPatch(deps.config, fileExtensions);
    // The in-memory config may still carry the old override — the merge
    // above unions both sources, so drop the key explicitly.
    const mergedEntry = merged[name];
    if (mergedEntry) {
      delete mergedEntry['llm'];
      if (Object.keys(mergedEntry).length === 0) delete merged[name];
    }
    return {
      code: 0,
      level: 'info',
      message:
        `Cleared LLM override for "${name}" — it now follows the session default (${sessionDefault}). ` +
        'Takes effect immediately for api.llm calls.',
      patch: { extensions: merged },
    };
  }

  // ── Set ────────────────────────────────────────────────────────────
  const providerArg = args[1];
  const modelArg = args[2];
  if (!providerArg || providerArg.startsWith('--')) return errorResult(PLUGIN_LLM_USAGE);
  const provider = providerArg === '-' ? undefined : providerArg;
  const model = modelArg && modelArg !== '-' ? modelArg : undefined;
  if (!provider && !model) return errorResult(PLUGIN_LLM_USAGE);

  const llm: Record<string, unknown> = {};
  if (provider) llm['provider'] = provider;
  if (model) llm['model'] = model;
  pluginExt['llm'] = llm;
  fileExtensions[name] = pluginExt;
  existing.extensions = fileExtensions;
  await atomicWrite(deps.configPath, JSON.stringify(existing, null, 2), { mode: 0o600 });

  // Soft sanity note: an unknown provider name still works if the
  // models.dev catalog knows it, but flag likely typos against the
  // user's configured providers.
  const configured = Object.keys(deps.config.providers ?? {});
  const note =
    provider && configured.length > 0 && !configured.includes(provider)
      ? `\nNote: "${provider}" is not in config.providers (configured: ${configured.join(', ')}). ` +
        'Catalog providers (anthropic, openai, …) still resolve if credentials are available.'
      : '';

  const merged = mergeExtensionsForPatch(deps.config, fileExtensions);
  return {
    code: 0,
    level: 'info',
    message:
      `Plugin "${name}" now routes api.llm calls via ` +
      `provider=${provider ?? '(session)'} model=${model ?? '(session)'}. ` +
      `Session default stays ${sessionDefault}. Takes effect immediately for api.llm calls.${note}`,
    patch: { extensions: merged },
  };
}

/**
 * patchConfig is a shallow merge — build the FULL extensions map:
 * in-memory config first, then the file's (just-written) entries win.
 */
function mergeExtensionsForPatch(
  config: Config,
  fileExtensions: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(config.extensions ?? {})) {
    merged[k] = { ...v };
  }
  for (const [k, v] of Object.entries(fileExtensions)) {
    if (isRecord(v)) merged[k] = { ...(merged[k] ?? {}), ...v };
  }
  // A cleared plugin entry must disappear from the merged view too.
  for (const k of Object.keys(merged)) {
    if (!(k in fileExtensions) && !(k in (config.extensions ?? {}))) delete merged[k];
  }
  return merged;
}

export function resolvePluginSpecifier(input: string): string {
  return OFFICIAL_ALIASES.get(input.toLowerCase()) ?? input;
}

function resolvePluginToggleSpecifier(input: string): string {
  if (input.toLowerCase() === '@wrongstack/telegram') return 'telegram';
  if (auditEntryFor(input)) return input;
  return resolvePluginSpecifier(input);
}

export function renderOfficialPlugins(config?: Config): string {
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
      const suffix = official ? ` (${official.alias})` : '';
      return `  ${`${name}${suffix}`.padEnd(44)} ${enabled}`;
    })
    .join('\n');
}

export function renderPluginAuditReport(config: Config): string {
  const configured = config.plugins ?? [];
  const lines = [
    'Plugin audit report:',
    '  State shows the effective boot state. Default-active plugins run unless disabled in config.',
    '  Locked rows are visible in the menu but cannot be toggled there.',
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
      lines.push(
        `  ${name.padEnd(24)} ${state.padEnd(8)} config   risk=custom user-configured plugin`,
      );
    }
  }

  lines.push(
    '',
    'Use `/plugin menu` in the TUI, or `wstack plugin toggle <name>` for toggleable rows.',
  );
  return lines.join('\n');
}

async function readConfig(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function pluginName(p: string | PluginConfig): string {
  return typeof p === 'string' ? p : p.name;
}

function pluginEntry(spec: string, enabled: boolean): string | PluginConfig {
  return enabled ? spec : { name: spec, enabled: false };
}

function pluginMatchesToggleSpec(p: string | PluginConfig, spec: string): boolean {
  const name = pluginName(p);
  if (spec === 'telegram') return name === 'telegram' || name === '@wrongstack/telegram';
  return name === spec;
}

function effectiveAuditState(
  config: Config,
  entry: PluginAuditEntry,
): { state: 'enabled' | 'disabled'; source: 'config' | 'default' } {
  const configured = (config.plugins ?? []).find((plugin) =>
    pluginMatchesToggleSpec(plugin, entry.name),
  );
  if (configured) {
    return {
      state:
        typeof configured === 'object' && configured.enabled === false ? 'disabled' : 'enabled',
      source: 'config',
    };
  }
  return {
    state: entry.defaultState === 'active' ? 'enabled' : 'disabled',
    source: 'default',
  };
}

function lockedReason(entry: PluginAuditEntry): string {
  if (entry.canDisable) return 'toggleable';
  if (entry.name === 'secret-scanner' || entry.name === 'branch-guard') {
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
  return typeof match === 'object' && match.enabled === false ? 'disabled' : 'enabled';
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
  const enabled = configured
    ? !(typeof configured === 'object' && configured.enabled === false)
    : auditEntry?.defaultState === 'active';

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
    nextPlugins.push({ name: spec, enabled: false });
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
  return {
    code: 0,
    level: 'info',
    message: `${nextEnabled ? 'Enabled' : 'Disabled'} "${spec}". Config written to ${deps.configPath}.`,
    patch: { plugins: nextPlugins, features },
    restartRequired: true,
  };
}

async function upsertPlugin(
  spec: string,
  opts: { enabled: boolean },
  deps: PluginManagementDeps,
  verb: string,
): Promise<PluginManagementResult> {
  const existing = await readConfig(deps.configPath);
  const plugins = Array.isArray(existing.plugins)
    ? (existing.plugins as Array<string | PluginConfig>)
    : [];
  const idx = plugins.findIndex((p) => pluginName(p) === spec);
  const nextEntry = pluginEntry(spec, opts.enabled);
  if (idx >= 0) plugins[idx] = nextEntry;
  else plugins.push(nextEntry);
  const features = {
    ...(isRecord(deps.config.features) ? deps.config.features : {}),
    ...(isRecord(existing.features) ? existing.features : {}),
    plugins: true,
  };
  existing.plugins = plugins;
  existing.features = features;
  await atomicWrite(deps.configPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
  return {
    code: 0,
    level: 'info',
    message: `${verb} "${spec}" (${opts.enabled ? 'enabled' : 'disabled'}). Config written to ${deps.configPath}.`,
    patch: { plugins, features },
    restartRequired: true,
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

function errorResult(message: string): PluginManagementResult {
  return { code: 1, level: 'error', message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
