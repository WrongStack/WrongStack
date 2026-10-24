import type { AutoThinConfig, DisabledToolMeta, ToolsConfig } from '@wrongstack/contracts/types';
import { noOpVault } from '@wrongstack/core/security';
import { color } from '@wrongstack/core/utils';
import { activeProfileConfigPath } from '../profile-config-path.js';
import { persistConfigSetting } from '../settings-menu.js';

interface CreateToolAutoThinCommandsInput {
  getCurrentTools: () => import('@wrongstack/contracts/types').ToolsConfig;
  opts: import('./command-context.js').SlashCommandContext;
}

export function createToolAutoThinCommands({
  getCurrentTools,
  opts,
}: CreateToolAutoThinCommandsInput) {
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
  return {
    persistDisabledWithMeta,
    cmdAutoThinStatus,
    cmdAutoThinCandidates,
    cmdAutoThinApply,
    cmdAutoThinUndo,
    cmdAutoThinConfig,
  };
}
