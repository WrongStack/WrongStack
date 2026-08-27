import { noOpVault } from '@wrongstack/core/security';
import type {
  AutoThinConfig,
  DisabledToolMeta,
  SlashCommand,
  ToolDescriptionMode,
  ToolResultRenderMode,
  ToolsConfig,
} from '@wrongstack/core/types';
import {
  color,
  getToolDescriptionMode,
  getToolResultRenderMode,
  normalizeToolDescriptionMode,
  normalizeToolResultRenderMode,
  setToolResultRenderMode,
  toErrorMessage,
} from '@wrongstack/core/utils';
import { activeProfileConfigPath } from '../profile-config-path.js';
import { persistConfigSetting } from '../settings-menu.js';
import type { SlashCommandContext } from './command-context.js';

function fit(text: string, width: number): string {
  if (text.length <= width) return text.padEnd(width);
  return `${text.slice(0, Math.max(0, width - 3))}...`;
}

function formatDescriptionMode(mode: ToolDescriptionMode): string {
  const raw = `desc:${mode}`;
  return mode === 'simple' ? color.amber(raw) : color.cyan(raw);
}

function formatResultRenderMode(mode: ToolResultRenderMode): string {
  const raw = `result:${mode}`;
  return mode === 'simple' ? color.amber(raw) : color.cyan(raw);
}

type ModeAxis = 'desc' | 'result';

export function buildToolCommand(opts: SlashCommandContext): SlashCommand {
  const help = [
    'Usage:',
    '  /tool                                  Show tool description + result-mode overrides',
    '  /tool list                             List every tool and its two modes',
    '  /tool <name>                           Show one tool mode (both axes)',
    '  /tool <name> simple|extend             Set BOTH description and result modes (legacy alias)',
    '  /tool <name> desc simple|extend        Set ONLY the description mode (LLM prompt)',
    '  /tool <name> result simple|extend      Set ONLY the on-screen result mode',
    '  /tool disable <name>                   Hide a tool from the registry and system prompt',
    '  /tool enable <name>                    Restore a disabled tool',
    '  /tool <name> disable|enable            Same as above, noun-first alias',
    '  /tool enable-all                       Restore all disabled tools',
    '',
    'Auto-thinning (off by default — enable with /settings autothin on):',
    '  /tool autothin status                  Show current config + disabled counts',
    '  /tool autothin candidates              Dry-run: list what WOULD be thinned',
    '  /tool autothin apply                   Disable every candidate now',
    '  /tool autothin undo                    Re-enable everything auto-thinned',
    '  /tool autothin config <key> <value>    Tune enabled|applyOnBoot|idleDays|minInvocations|neverAutoThin',
    '',
    'Modes:',
    '  simple   short prose / meta-only display',
    '  extend   full description / full preview (default)',
    '',
    'Axes are independent — `/tool read result simple` does NOT affect the LLM-side',
    'description, and `/tool read desc simple` does NOT change on-screen rendering.',
    'The legacy form `/tool read simple` sets both axes at once.',
    '',
    'Examples:',
    '  /tool read result simple',
    '  /tool bash desc simple',
    '  /tool disable bash',
    '  /tool enable bash',
    '  /tool enable-all',
    '  /tool autothin candidates',
  ].join('\n');

  function getCurrentTools(): ToolsConfig {
    return opts.configStore.get().tools;
  }

  /**
   * Compute the next ToolsConfig snapshot when toggling a single axis
   * (description or result) for a single tool. The other axis is left
   * untouched — `/tool read desc simple` must NOT wipe out a previously
   * set `resultRenderMode[read]`.
   *
   * `from` is an optional seed snapshot; pass it to chain multiple axis
   * updates onto one ToolsConfig (used by the legacy both-at-once alias
   * `/tool <name> simple` which sets desc + result in one pass).
   */
  function nextToolsConfigForAxis(
    name: string,
    axis: ModeAxis,
    mode: ToolDescriptionMode | ToolResultRenderMode,
    from?: ToolsConfig,
  ): ToolsConfig {
    const current = from ?? getCurrentTools();
    if (axis === 'desc') {
      const descriptionMode = { ...(current.descriptionMode ?? {}) };
      if (mode === 'extend') delete descriptionMode[name];
      else descriptionMode[name] = mode as ToolDescriptionMode;
      return { ...current, descriptionMode };
    }
    const resultRenderMode = { ...(current.resultRenderMode ?? {}) };
    if (mode === 'extend') delete resultRenderMode[name];
    else resultRenderMode[name] = mode as ToolResultRenderMode;
    return { ...current, resultRenderMode };
  }

  /**
   * Variant of `nextToolsConfigForAxis` that always builds off the
   * supplied snapshot (does not re-read `getCurrentTools()`). Used to
   * chain multiple axis updates onto one immutable ToolsConfig.
   */
  function nextToolsConfigForAxisFrom(
    from: ToolsConfig,
    name: string,
    axis: ModeAxis,
    mode: ToolDescriptionMode | ToolResultRenderMode,
  ): ToolsConfig {
    return nextToolsConfigForAxis(name, axis, mode, from);
  }

  /**
   * Legacy alias: `/tool <name> simple|extend` sets BOTH axes at once.
   * Used by users who still rely on the pre-split command shape. Goes
   * through the same per-axis persistence path so the config stays
   * canonical (no combined field).
   */
  function nextToolsConfigBoth(name: string, mode: ToolDescriptionMode): ToolsConfig {
    // Both axes in one immutable ToolsConfig: start from a snapshot with
    // the desc entry set, then chain the result axis on top so the final
    // object carries both. Each helper reads `getCurrentTools()` itself,
    // so chaining on `withDesc` is required to preserve the desc entry.
    const withDesc = nextToolsConfigForAxis(name, 'desc', mode);
    return nextToolsConfigForAxisFrom(withDesc, name, 'result', mode);
  }

  async function persistConfig(next: ToolsConfig): Promise<boolean> {
    if (!opts.paths) {
      opts.configStore.update({ tools: next });
      return false;
    }
    await persistConfigSetting(
      {
        configStore: opts.configStore,
        profileConfigPath: activeProfileConfigPath(opts.paths, opts.configStore.get()),
        inProjectConfigPath: opts.paths.inProjectConfig,
        vault: noOpVault,
      },
      (cfg) => {
        cfg.tools = next;
      },
    );
    return true;
  }

  async function persistModeForAxis(
    name: string,
    axis: ModeAxis,
    mode: ToolDescriptionMode | ToolResultRenderMode,
  ): Promise<boolean> {
    return persistConfig(nextToolsConfigForAxis(name, axis, mode));
  }

  async function persistModeBoth(name: string, mode: ToolDescriptionMode): Promise<boolean> {
    return persistConfig(nextToolsConfigBoth(name, mode));
  }

  // ── Disable / enable helpers ─────────────────────────────────────

  function currentDisabledSet(): Set<string> {
    return new Set(getCurrentTools().disabledTools ?? []);
  }

  function persistDisabled(names: string[]): Promise<void> {
    const current = getCurrentTools();
    const nextTools: ToolsConfig = { ...current, disabledTools: names };
    if (!opts.paths) {
      opts.configStore.update({ tools: nextTools });
      return Promise.resolve();
    }
    return persistConfigSetting(
      {
        configStore: opts.configStore,
        profileConfigPath: activeProfileConfigPath(opts.paths, opts.configStore.get()),
        inProjectConfigPath: opts.paths.inProjectConfig,
        vault: noOpVault,
      },
      (cfg) => {
        cfg.tools = nextTools;
      },
    );
  }

  // ── Formatting helpers ───────────────────────────────────────────

  function formatOverrides(): string {
    const configured = opts.configStore.get().tools;
    const descSimple = Object.entries(configured.descriptionMode ?? {})
      .filter(([, mode]) => normalizeToolDescriptionMode(mode) === 'simple')
      .map(([name]) => name)
      .sort();
    const resultSimple = Object.entries(configured.resultRenderMode ?? {})
      .filter(([, mode]) => normalizeToolResultRenderMode(mode) === 'simple')
      .map(([name]) => name)
      .sort();
    const disabled = opts.toolRegistry.listDisabled();
    const lines: string[] = [
      `${color.bold('Tool modes')} ${color.dim('(default: extend on both axes)')}`,
      '',
      `${formatDescriptionMode('simple')}: ${
        descSimple.length > 0 ? descSimple.map((n) => color.cyan(n)).join(', ') : color.dim('none')
      }`,
      `${formatResultRenderMode('simple')}: ${
        resultSimple.length > 0
          ? resultSimple.map((n) => color.cyan(n)).join(', ')
          : color.dim('none')
      }`,
      '',
    ];
    if (disabled.length > 0) {
      lines.push(
        `${color.bold('Disabled tools')}`,
        '',
        `  ${color.red('disabled')}: ${disabled.map(({ tool }) => color.dim(tool.name)).join(', ')}`,
        '',
      );
    }
    lines.push(
      color.dim(
        '  /tool <name> desc simple · /tool <name> result simple · /tool list · /tool disable|enable <name>',
      ),
    );
    return lines.join('\n');
  }

  function formatList(): string {
    const header =
      `  ${color.dim(fit('tool', 28))} ` +
      `${color.dim(fit('owner', 28))} ` +
      `${color.dim(fit('status', 10))} ` +
      `${color.dim(fit('desc', 14))} ` +
      color.dim('result');
    const rows = opts.toolRegistry.listWithOwner().map(({ tool }) => {
      const descMode = getToolDescriptionMode(opts.toolRegistry, tool.name);
      const resultMode = getToolResultRenderMode(opts.toolRegistry, tool.name);
      const owner = opts.toolRegistry.ownerOf(tool.name) ?? 'core';
      const status = opts.toolRegistry.isDisabled(tool.name)
        ? color.red('disabled')
        : color.green('active');
      return (
        `  ${fit(tool.name, 28)} ` +
        `${color.dim(fit(`[${owner}]`, 28))} ` +
        `${fit(status, 10)} ` +
        `${fit(formatDescriptionMode(descMode), 14)} ` +
        formatResultRenderMode(resultMode)
      );
    });
    return [
      `${color.bold('Tool modes')} ${color.dim('(default: extend on both axes)')}`,
      '',
      header,
      ...rows,
    ].join('\n');
  }

  function formatOne(name: string): string {
    const reg = opts.toolRegistry;
    const tool = reg.get(name);
    if (!tool) {
      if (reg.isDisabled(name)) {
        return `${color.amber(name)} is disabled. Use ${color.dim(`/tool enable ${name}`)} to restore.`;
      }
      return `${color.red('Unknown tool')}: ${name}. Use ${color.dim('/tools')} to list registered tools.`;
    }
    const descMode = getToolDescriptionMode(reg, name);
    const resultMode = getToolResultRenderMode(reg, name);
    const status = reg.isDisabled(name) ? color.red('disabled') : color.green('active');
    return [
      `${color.bold(name)} ${status}`,
      `description mode: ${formatDescriptionMode(descMode)}`,
      `result mode:     ${formatResultRenderMode(resultMode)}`,
      '',
      color.dim(tool.description),
    ].join('\n');
  }

  // ── Sub-command dispatch ────────────────────────────────────────

  async function cmdEnable(name: string): Promise<string> {
    const reg = opts.toolRegistry;
    if (!reg.isDisabled(name)) {
      return `${color.amber(name)} is not disabled.`;
    }
    const ok = reg.enable(name);
    if (!ok) return `${color.red('Could not enable')}: ${name}.`;

    const disabled = currentDisabledSet();
    disabled.delete(name);
    await persistDisabled(Array.from(disabled));

    return `${color.green('✓')} ${color.cyan(name)} re-enabled — will appear in next provider request.`;
  }

  async function cmdEnableAll(): Promise<string> {
    const reg = opts.toolRegistry;
    const count = reg.enableAll();
    if (count === 0) return `${color.amber('No disabled tools to re-enable.')}`;
    await persistDisabled([]);
    return `${color.green('✓')} All ${count} disabled tool(s) re-enabled.`;
  }

  async function cmdDisable(name: string): Promise<string> {
    const reg = opts.toolRegistry;
    const tool = reg.get(name);
    if (!tool) {
      if (reg.isDisabled(name)) {
        return `${color.amber(name)} is already disabled.`;
      }
      return `${color.red('Unknown tool')}: ${name}. Use ${color.dim('/tools')} to list registered tools.`;
    }
    const ok = reg.disable(name);
    if (!ok) return `${color.red('Could not disable')}: ${name}.`;

    const disabled = currentDisabledSet();
    disabled.add(name);
    await persistDisabledWithMeta(Array.from(disabled), {
      [name]: { reason: 'user', at: Date.now() },
    });

    return `${color.green('✓')} ${color.cyan(name)} disabled — removed from system prompt and tool registry.`;
  }

  // ── Auto-thin pipeline ──────────────────────────────────────────────

  function getAutoThin(): AutoThinConfig {
    const raw = getCurrentTools().autoThin;
    return {
      enabled: raw?.enabled === true,
      idleDays: typeof raw?.idleDays === 'number' ? raw.idleDays : 30,
      minInvocations: typeof raw?.minInvocations === 'number' ? raw.minInvocations : 3,
      ...(Array.isArray(raw?.neverAutoThin) ? { neverAutoThin: raw!.neverAutoThin } : {}),
      applyOnBoot: raw?.applyOnBoot === true,
    };
  }

  async function persistAutoThin(next: AutoThinConfig): Promise<void> {
    const current = getCurrentTools();
    const merged: ToolsConfig = { ...current, autoThin: next };
    if (!opts.paths) {
      opts.configStore.update({ tools: merged });
      return;
    }
    await persistConfigSetting(
      {
        configStore: opts.configStore,
        profileConfigPath: activeProfileConfigPath(opts.paths, opts.configStore.get()),
        inProjectConfigPath: opts.paths.inProjectConfig,
        vault: noOpVault,
      },
      (cfg) => {
        cfg.tools = merged;
      },
    );
  }

  async function persistDisabledWithMeta(
    names: string[],
    metaDelta: Record<string, DisabledToolMeta>,
  ): Promise<void> {
    const current = getCurrentTools();
    const nextMeta: Record<string, DisabledToolMeta> = { ...(current.disabledToolMeta ?? {}) };
    for (const [name, entry] of Object.entries(metaDelta)) {
      nextMeta[name] = entry;
    }
    if (!opts.paths) {
      opts.configStore.update({
        tools: { ...current, disabledTools: names, disabledToolMeta: nextMeta },
      });
      return;
    }
    await persistConfigSetting(
      {
        configStore: opts.configStore,
        profileConfigPath: activeProfileConfigPath(opts.paths, opts.configStore.get()),
        inProjectConfigPath: opts.paths.inProjectConfig,
        vault: noOpVault,
      },
      (cfg) => {
        cfg.tools = { ...(cfg.tools ?? {}), disabledTools: names, disabledToolMeta: nextMeta };
      },
    );
  }

  async function runAutoThinDryRun(): Promise<{
    candidates: { name: string; invocations: number; daysSinceLastUse: number | null }[];
    source: string;
  }> {
    const { runBootAutoThin } = await import('../boot/boot-auto-thin.js');
    const cfg = getAutoThin();
    const result = await runBootAutoThin({
      toolRegistry: opts.toolRegistry,
      events: opts.events,
      configStore: opts.configStore,
      config: cfg,
      ...(opts.getChronicle ? { chronicle: opts.getChronicle() } : {}),
      ...(opts.getToolUsage ? { bridge: opts.getToolUsage() } : {}),
      dryRun: true,
    });
    return {
      candidates: result.candidates.map((c) => ({
        name: c.name,
        invocations: c.invocations,
        daysSinceLastUse: c.daysSinceLastUse,
      })),
      source: result.source,
    };
  }

  async function cmdAutoThinStatus(): Promise<string> {
    const cfg = getAutoThin();
    const allDisabled = opts.toolRegistry.listDisabled();
    const userCount = allDisabled.filter((d) => d.meta.reason === 'user').length;
    const autoCount = allDisabled.filter((d) => d.meta.reason === 'auto-thinned').length;
    const lines = [
      `${color.bold('Auto-thinning')} ${color.dim('(`tools.autoThin`)')}`,
      '',
      `  enabled:      ${cfg.enabled ? color.green('on') : color.amber('off')}`,
      `  applyOnBoot:  ${cfg.applyOnBoot ? color.green('on') : color.amber('off')}`,
      `  idleDays:     ${color.cyan(String(cfg.idleDays))}`,
      `  minInvocations: ${color.cyan(String(cfg.minInvocations))}`,
      `  neverAutoThin: ${cfg.neverAutoThin && cfg.neverAutoThin.length > 0 ? cfg.neverAutoThin.map((n) => color.cyan(n)).join(', ') : color.dim('none')}`,
      '',
      `${color.bold('Disabled tools')}: ${color.cyan(String(allDisabled.length))} ` +
        `(${color.cyan(String(userCount))} ${color.dim('user')}, ${color.cyan(String(autoCount))} ${color.dim('auto-thinned')})`,
    ];
    return lines.join('\n');
  }

  async function cmdAutoThinCandidates(): Promise<string> {
    const cfg = getAutoThin();
    if (!cfg.enabled) {
      return `${color.amber('Auto-thinning is off')}. Run ${color.cyan('/settings autothin on')} first.`;
    }
    const { candidates, source } = await runAutoThinDryRun();
    if (candidates.length === 0) {
      return `${color.green('No candidates')} (source: ${color.cyan(source)}, idle ${cfg.idleDays}d, min ${cfg.minInvocations}).`;
    }
    const rows = candidates.map((c) => {
      const idle = c.daysSinceLastUse === null ? 'never' : `${c.daysSinceLastUse}d`;
      return `  ${color.cyan(c.name.padEnd(28))} ${color.dim('invocations=')} ${color.cyan(String(c.invocations).padStart(3))} ${color.dim('idle=')} ${color.cyan(idle)}`;
    });
    return [
      `${color.bold('Auto-thin candidates')} ${color.dim(`(source: ${source})`)}`,
      '',
      ...rows,
      '',
      `${color.dim(`Run ${color.cyan('/tool autothin apply')} to disable, or ${color.cyan('/tool autothin undo')} to re-enable auto-thinned tools.`)}`,
    ].join('\n');
  }

  async function cmdAutoThinApply(): Promise<string> {
    const cfg = getAutoThin();
    if (!cfg.enabled) {
      return `${color.amber('Auto-thinning is off')}. Run ${color.cyan('/settings autothin on')} first.`;
    }
    const { runBootAutoThin } = await import('../boot/boot-auto-thin.js');
    const result = await runBootAutoThin({
      toolRegistry: opts.toolRegistry,
      events: opts.events,
      configStore: opts.configStore,
      config: cfg,
      ...(opts.getChronicle ? { chronicle: opts.getChronicle() } : {}),
      ...(opts.getToolUsage ? { bridge: opts.getToolUsage() } : {}),
      dryRun: false,
    });
    if (result.applied.length === 0) {
      return `${color.green('No tools to thin')} (source: ${color.cyan(result.source)}).`;
    }
    return [
      `${color.green('✓')} Thinned ${color.cyan(String(result.applied.length))} tool(s) (source: ${color.cyan(result.source)}):`,
      '',
      ...result.applied.map((n) => `  ${color.cyan(n)}`),
      '',
      `${color.dim(`Re-enable with ${color.cyan('/tool autothin undo')}.`)}`,
    ].join('\n');
  }

  async function cmdAutoThinUndo(): Promise<string> {
    const restored = opts.toolRegistry.enableAutoThinned();
    if (restored.length === 0) {
      return `${color.amber('No auto-thinned tools to restore')}.`;
    }
    const current = getCurrentTools();
    const disabled = (current.disabledTools ?? []).filter((n) => !restored.includes(n));
    const meta: Record<string, DisabledToolMeta> = { ...(current.disabledToolMeta ?? {}) };
    for (const name of restored) delete meta[name];
    if (!opts.paths) {
      opts.configStore.update({
        tools: { ...current, disabledTools: disabled, disabledToolMeta: meta },
      });
    } else {
      await persistConfigSetting(
        {
          configStore: opts.configStore,
          profileConfigPath: activeProfileConfigPath(opts.paths, opts.configStore.get()),
          inProjectConfigPath: opts.paths.inProjectConfig,
          vault: noOpVault,
        },
        (cfg) => {
          cfg.tools = {
            ...(cfg.tools ?? {}),
            disabledTools: disabled,
            disabledToolMeta: meta,
          };
        },
      );
    }
    return [
      `${color.green('✓')} Re-enabled ${color.cyan(String(restored.length))} auto-thinned tool(s):`,
      '',
      ...restored.map((n) => `  ${color.cyan(n)}`),
    ].join('\n');
  }

  async function cmdAutoThinConfig(rest: string): Promise<string> {
    const parts = rest.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      const cfg = getAutoThin();
      return [
        `${color.bold('Auto-thin config')}`,
        '',
        `  ${color.dim('enabled')}        ${cfg.enabled ? color.green('true') : color.amber('false')}`,
        `  ${color.dim('applyOnBoot')}    ${cfg.applyOnBoot ? color.green('true') : color.amber('false')}`,
        `  ${color.dim('idleDays')}       ${color.cyan(String(cfg.idleDays))}`,
        `  ${color.dim('minInvocations')} ${color.cyan(String(cfg.minInvocations))}`,
        `  ${color.dim('neverAutoThin')}  ${cfg.neverAutoThin && cfg.neverAutoThin.length > 0 ? cfg.neverAutoThin.join(', ') : color.dim('none')}`,
        '',
        `${color.dim('Usage: /tool autothin config <key> <value>')}`,
        `  ${color.dim('keys: enabled | applyOnBoot | idleDays | minInvocations | neverAutoThin')}`,
      ].join('\n');
    }
    const [key, valueRaw, ...restTokens] = parts;
    if (restTokens.length > 0) {
      return `${color.amber('Usage:')} /tool autothin config <key> <value>`;
    }
    const value = valueRaw ?? '';
    const cfg = getAutoThin();
    switch (key) {
      case 'enabled': {
        const on = ['on', 'true', '1', 'yes'].includes(value.toLowerCase());
        await persistAutoThin({ ...cfg, enabled: on });
        return `${color.green('✓')} autoThin.enabled = ${color.cyan(String(on))}`;
      }
      case 'applyOnBoot': {
        const on = ['on', 'true', '1', 'yes'].includes(value.toLowerCase());
        await persistAutoThin({ ...cfg, applyOnBoot: on });
        return `${color.green('✓')} autoThin.applyOnBoot = ${color.cyan(String(on))}`;
      }
      case 'idleDays': {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) {
          return `${color.amber('idleDays must be a non-negative number')}`;
        }
        await persistAutoThin({ ...cfg, idleDays: n });
        return `${color.green('✓')} autoThin.idleDays = ${color.cyan(String(n))}`;
      }
      case 'minInvocations': {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) {
          return `${color.amber('minInvocations must be a non-negative number')}`;
        }
        await persistAutoThin({ ...cfg, minInvocations: n });
        return `${color.green('✓')} autoThin.minInvocations = ${color.cyan(String(n))}`;
      }
      case 'neverAutoThin': {
        const list = value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        await persistAutoThin({ ...cfg, neverAutoThin: list });
        return `${color.green('✓')} autoThin.neverAutoThin = ${color.cyan(list.join(', ') || 'none')}`;
      }
      default:
        return `${color.amber('Unknown key')}: ${key}. Use: enabled | applyOnBoot | idleDays | minInvocations | neverAutoThin`;
    }
  }

  /**
   * Apply the desc-mode change for `name` to the in-memory tool
   * registry so the next provider request picks it up. Persists to
   * config first so the boot path re-applies it on the next launch.
   */
  function applyDescMode(name: string, mode: ToolDescriptionMode): void {
    // Reuse the description-mode utility — it wraps the tool with the
    // simplified description. Same call site as the original /tool
    // command, kept here so this remains the single entry point for
    // desc-mode toggling.
    opts.toolRegistry.setDescriptionMode?.(name, mode);
  }

  /**
   * Apply the result-render-mode change for `name` to the registry
   * so the executor reads it on the next tool invocation.
   */
  function applyResultMode(name: string, mode: ToolResultRenderMode): void {
    setToolResultRenderMode(opts.toolRegistry, name, mode);
  }

  return {
    name: 'tool',
    category: 'Config',
    description:
      'Set per-tool description mode (LLM prompt) and/or on-screen result mode. Disable/enable tools.',
    argsHint: '[<name> desc|result simple|extend | disable | enable]',
    help,
    async run(args) {
      if (!opts.configStore) {
        return { message: `${color.red('Error')} config store not available.` };
      }

      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? '').toLowerCase();
      if (!sub) return { message: formatOverrides() };
      if (sub === 'help' || sub === '--help') return { message: this.help ?? '' };

      // ── Sub-command routing ──────────────────────────────────────

      if (sub === 'list') return { message: formatList() };

      // enable-all
      if (sub === 'enable-all') {
        try {
          return { message: await cmdEnableAll() };
        } catch (err) {
          return { message: `${color.red('Error')}: ${toErrorMessage(err)}` };
        }
      }

      // autothin — stats-driven tool disable pipeline
      if (sub === 'autothin' || sub === 'auto-thin') {
        const action = (parts[1] ?? 'status').toLowerCase();
        try {
          switch (action) {
            case 'status':
              return { message: await cmdAutoThinStatus() };
            case 'candidates':
            case 'list':
            case 'dry-run':
            case 'dryrun':
              return { message: await cmdAutoThinCandidates() };
            case 'apply':
              return { message: await cmdAutoThinApply() };
            case 'undo':
            case 'revert':
              return { message: await cmdAutoThinUndo() };
            case 'config':
            case 'set':
              return { message: await cmdAutoThinConfig(parts.slice(2).join(' ')) };
            default:
              return {
                message: `${color.amber('Usage:')} /tool autothin <status|candidates|apply|undo|config>`,
              };
          }
        } catch (err) {
          return { message: `${color.red('Error')}: ${toErrorMessage(err)}` };
        }
      }

      const name = parts[0] ?? '';
      if (!name) return { message: formatOverrides() };

      // disable <name...> — accepts one or more tool names
      if (sub === 'disable') {
        const targets = parts.slice(1);
        if (targets.length === 0)
          return { message: `${color.amber('Usage:')} /tool disable <name> [name...]` };
        try {
          // Sequential: each call reads+persists the disabled set, so parallel
          // runs would race on the persisted list.
          const results: string[] = [];
          for (const t of targets) results.push(await cmdDisable(t));
          return { message: results.join('\n') };
        } catch (err) {
          return { message: `${color.red('Error')}: ${toErrorMessage(err)}` };
        }
      }

      // enable <name...> — accepts one or more tool names
      if (sub === 'enable') {
        const targets = parts.slice(1);
        if (targets.length === 0)
          return { message: `${color.amber('Usage:')} /tool enable <name> [name...]` };
        try {
          const results: string[] = [];
          for (const t of targets) results.push(await cmdEnable(t));
          return { message: results.join('\n') };
        } catch (err) {
          return { message: `${color.red('Error')}: ${toErrorMessage(err)}` };
        }
      }

      // `/tool <name> disable|enable` — noun-first alias for the documented
      // verb-first form. This mirrors how people naturally read a specific
      // tool row: "bash, disable it".
      const action = parts[1]?.toLowerCase();
      if (action === 'disable' || action === 'enable') {
        if (parts.length > 2) {
          return {
            message: `${color.amber('Usage:')} /tool ${name} ${action}`,
          };
        }
        try {
          return { message: action === 'disable' ? await cmdDisable(name) : await cmdEnable(name) };
        } catch (err) {
          return { message: `${color.red('Error')}: ${toErrorMessage(err)}` };
        }
      }

      // ── Tool lookup gate (for desc/result/bare-simple) ─────────

      if (!opts.toolRegistry.get(name) && !opts.toolRegistry.isDisabled(name)) {
        return {
          message: `${color.red('Unknown tool')}: ${name}. Use ${color.dim('/tools')} to list registered tools.`,
        };
      }

      // `/tool <name>` — show both axes for one tool
      if (parts.length === 1) return { message: formatOne(name) };

      // `/tool <name> desc|result simple|extend`
      const axis = parts[1]?.toLowerCase();
      if (axis === 'desc' || axis === 'result') {
        const rawMode = parts[2];
        if (!rawMode) {
          return {
            message: `${color.amber('Usage:')} /tool ${name} ${axis} simple|extend`,
          };
        }
        const mode = normalizeToolDescriptionMode(rawMode);
        if (!mode) {
          return {
            message: `${color.amber('Usage:')} /tool ${name} ${axis} simple|extend`,
          };
        }
        try {
          if (axis === 'desc') {
            const persisted = await persistModeForAxis(name, 'desc', mode);
            applyDescMode(name, mode);
            const persistence = persisted
              ? color.dim('saved')
              : color.dim('runtime only; config paths unavailable');
            return {
              message: `${color.green('✓')} ${color.cyan(name)} ${formatDescriptionMode(mode)} ${persistence}`,
            };
          }
          const persisted = await persistModeForAxis(name, 'result', mode);
          applyResultMode(name, mode);
          const persistence = persisted
            ? color.dim('saved')
            : color.dim('runtime only; config paths unavailable');
          return {
            message: `${color.green('✓')} ${color.cyan(name)} ${formatResultRenderMode(mode)} ${persistence}`,
          };
        } catch (err) {
          return {
            message: `${color.red('Could not save tool setting')}: ${toErrorMessage(err)}`,
          };
        }
      }

      // `/tool <name> simple|extend` — legacy alias that sets BOTH
      // axes at once. Intentionally NOT split: users who already have
      // muscle memory for the old form keep working. New users get the
      // explicit desc/result form from the help text.
      const mode = normalizeToolDescriptionMode(axis);
      if (!mode) {
        return {
          message: `${color.amber('Usage:')} /tool ${name} [desc|result] simple|extend`,
        };
      }
      try {
        const persisted = await persistModeBoth(name, mode);
        applyDescMode(name, mode);
        applyResultMode(name, mode);
        const persistence = persisted
          ? color.dim('saved (both axes)')
          : color.dim('runtime only; config paths unavailable');
        return {
          message: `${color.green('✓')} ${color.cyan(name)} ${formatDescriptionMode(mode)} + ${formatResultRenderMode(mode)} ${persistence}`,
        };
      } catch (err) {
        return {
          message: `${color.red('Could not save tool setting')}: ${toErrorMessage(err)}`,
        };
      }
    },
  };
}
