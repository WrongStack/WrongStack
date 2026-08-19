import { decryptConfigSecrets, encryptConfigSecrets, noOpVault } from '@wrongstack/core/security';
import {
  isReasoningEffort,
  REASONING_EFFORT_LEVELS,
  type ReasoningEffort,
  type SlashCommand,
} from '@wrongstack/core/types';
import { atomicWrite, color } from '@wrongstack/core/utils';
import { catalogProviderIdFor } from '@wrongstack/providers';
import type { SlashCommandContext } from './command-context.js';
import * as fs from 'node:fs/promises';
import type { WstackPaths } from '@wrongstack/core/utils';

// REASONING_EFFORT_LEVELS / isReasoningEffort come from
// @wrongstack/core/types — the canonical single source of truth. The
// model-aware path narrows the list to what the ACTIVE model advertises
// (`reasoningConfig.effortLevels`); the full list is only used when
// capabilities are unknown, matching the conservative resolver gate in
// `resolveReasoningForRequest` (unknown → the setting is dropped before it
// reaches the wire, never rejected).

/**
 * `/effort` — view or set the SESSION-WIDE reasoning effort applied to the
 * active leader model. This is the quick, discoverable front-end for
 * `Config.modelRuntime.reasoning.effort` — the same field `/settings
 * reasoning-effort` writes and the WebUI "Reasoning effort" dropdown edits.
 *
 * Distinct from `/setmodel reasoning-effort <key>`, which pins effort onto a
 * model-matrix entry (role/phase/*) for spawned subagents.
 *
 * Model-aware: when the active model's catalog entry advertises
 * `effortLevels`, only those values are accepted and the view highlights the
 * supported set. When capabilities are unknown, any canonical value is
 * accepted (the runtime resolver drops unsupported values with a warning
 * instead of erroring), and the view says so.
 *
 * Subcommands:
 *   (none)        Show current effort, model-supported levels, and usage.
 *   <level>       Set the session effort.
 *   clear         Remove the setting (provider default applies).
 *   matrix        Show per-key (role/phase/*) effort overrides, if any.
 */
export function buildEffortCommand(opts: SlashCommandContext): SlashCommand {
  const levelsHint = REASONING_EFFORT_LEVELS.join('|');
  const help = [
    'Usage:',
    '  /effort                       Show current session effort + supported levels',
    `  /effort <level>               Set session effort (${levelsHint})`,
    '  /effort clear                 Remove the setting — provider default applies',
    '  /effort matrix                Show per-role/phase effort overrides (/setmodel)',
    '',
    'Applies to the active model on the next request. Unsupported values for the',
    'current model are rejected up front when its capabilities are known.',
    'Per-subagent overrides: /setmodel reasoning-effort <role|phase|*> <level>.',
  ].join('\n');

  async function loadModelLevels(): Promise<{
    levels: ReasoningEffort[] | undefined;
    supported: boolean;
  }> {
    const registry = opts.modelsRegistry;
    if (!registry) return { levels: undefined, supported: false };
    const config = opts.configStore.get();
    try {
      const catalogId = catalogProviderIdFor(
        config.provider,
        config.providers?.[config.provider]?.type,
      );
      const resolved = await registry.getModel(catalogId, config.model);
      const rc = resolved?.capabilities.reasoningConfig;
      if (!rc) return { levels: undefined, supported: false };
      return {
        levels: rc.effortLevels?.length ? rc.effortLevels : undefined,
        supported: !!rc.effortSupported,
      };
    } catch {
      // Catalog unavailable — capabilities unknown; do not block the command.
      return { levels: undefined, supported: false };
    }
  }

  return {
    name: 'effort',
    category: 'Config',
    description: 'View or set the session-wide reasoning effort for the active model.',
    argsHint: `[${levelsHint}|clear|matrix]`,
    help,
    async run(args) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? '').toLowerCase();

      if (sub === 'help' || sub === '--help') return { message: help };

      if (!opts.configStore || !opts.paths) {
        return { message: `${color.red('Error')} config store not available.` };
      }

      const config = opts.configStore.get();

      // ---- matrix: per-key overrides (read-only summary) ----
      if (sub === 'matrix') {
        const matrix = (config.modelMatrix ?? {}) as Record<
          string,
          {
            modelRuntime?: {
              reasoning?: {
                effort?: ReasoningEffort;
                mode?: string;
                preserve?: boolean;
              };
            };
          }
        >;
        const entries = Object.entries(matrix).filter(([, e]) => e?.modelRuntime?.reasoning);
        if (entries.length === 0) {
          return {
            message: [
              `${color.bold('Effort overrides')} ${color.dim('(model matrix)')}`,
              `  ${color.dim('(none — set one with /setmodel reasoning-effort <role|phase|*> <level>)')}`,
            ].join('\n'),
          };
        }
        const lines = [`${color.bold('Effort overrides')} ${color.dim('(model matrix)')}`];
        for (const [key, entry] of entries.sort(([a], [b]) => a.localeCompare(b))) {
          const reasoning = entry.modelRuntime!.reasoning!;
          const bits = [
            reasoning.effort ? `effort:${reasoning.effort}` : '',
            reasoning.mode ? `mode:${reasoning.mode}` : '',
            reasoning.preserve !== undefined
              ? `preserve:${reasoning.preserve ? 'on' : 'off'}`
              : '',
          ].filter(Boolean);
          lines.push(`  ${color.amber(key.padEnd(22))} → ${bits.join(' ')}`);
        }
        return { message: lines.join('\n') };
      }

      const { levels, supported } = await loadModelLevels();
      const current = config.modelRuntime?.reasoning?.effort;

      // ---- view ----
      if (!sub) {
        const lines = [
          `${color.bold('WrongStack')} ${color.dim('— Session effort')}`,
          '',
          `  ${color.bold('model')}   ${color.cyan(`${config.provider}/${config.model}`)}`,
        ];
        if (current) {
          const ok = !levels || levels.includes(current);
          lines.push(
            `  ${color.bold('effort')}  ${color.bold(current)}${ok ? '' : `  ${color.amber(`(not advertised by this model — supported: ${levels.join(', ')})`)}`}`,
          );
        } else {
          lines.push(`  ${color.bold('effort')}  ${color.dim('(not set — provider default)')}`);
        }
        if (levels) {
          const rendered = REASONING_EFFORT_LEVELS.filter((l) => levels.includes(l)).map((l) =>
            l === current ? color.bold(l) : l,
          );
          lines.push(`  ${color.bold('levels')}  ${rendered.join(' · ')}`);
        } else if (supported) {
          lines.push(
            `  ${color.bold('levels')}  ${color.dim('(model supports effort; no explicit level list)')}`,
          );
        } else {
          lines.push(
            `  ${color.bold('levels')}  ${color.dim('(unknown — the resolver drops unsupported values with a warning)')}`,
          );
        }
        lines.push(
          '',
          `  ${color.dim('/effort <level> · clear · matrix · help')}`,
        );
        return { message: lines.join('\n') };
      }

      // ---- clear ----
      if (sub === 'clear' || sub === 'off-default') {
        if (current === undefined) {
          return { message: `${color.dim('No session effort set — provider default already applies.')}` };
        }
        await patchSessionEffort(undefined, opts.paths, config.activeProfile ?? 'default');
        opts.configStore.update({
          modelRuntime: {
            ...(config.modelRuntime as object),
            reasoning: { ...(config.modelRuntime?.reasoning as object), effort: undefined },
          },
        });
        return {
          message: `${color.green('✓')} session effort cleared ${color.dim('— provider default applies')}`,
        };
      }

      // ---- set ----
      if (!isReasoningEffort(sub)) {
        return {
          message: `${color.amber('Usage:')} /effort ${REASONING_EFFORT_LEVELS.join('|')} | clear | matrix`,
        };
      }
      if (levels && !levels.includes(sub)) {
        return {
          message: [
            `${color.red('Unsupported effort')} for ${config.provider}/${config.model}: "${sub}".`,
            `  ${color.dim(`advertised: ${levels.join(', ')}`)}`,
            `  ${color.dim('the resolver would drop this value with a warning — pick an advertised level, or /effort clear')}`,
          ].join('\n'),
        };
      }

      await patchSessionEffort(sub, opts.paths, config.activeProfile ?? 'default');
      opts.configStore.update({
        modelRuntime: {
          ...(config.modelRuntime as object),
          reasoning: { ...(config.modelRuntime?.reasoning as object), effort: sub },
        },
      });
      return {
        message: `${color.green('✓')} session effort → ${color.bold(sub)}  ${color.dim(`(${config.provider}/${config.model}, next request)`)}`,
      };
    },
  };
}

/**
 * Persist `Config.modelRuntime.reasoning.effort` to the active profile config.
 * `undefined` removes the key entirely (JSON has no undefined). Uses the same
 * read → decrypt → mutate → encrypt → atomicWrite cycle as `/setmodel` and
 * `persistConfigSetting` so encrypted secrets round-trip byte-for-byte.
 */
export async function patchSessionEffort(
  effort: ReasoningEffort | undefined,
  paths: WstackPaths,
  activeProfile: string,
): Promise<void> {
  const targetPath = paths.profileConfig(activeProfile);
  let raw = '{}';
  try {
    raw = await fs.readFile(targetPath, 'utf8');
  } catch {
    // ENOENT — start from an empty config, same as /setmodel.
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const decrypted = decryptConfigSecrets(parsed, noOpVault) as Record<string, unknown>;
  const mr = (decrypted.modelRuntime ?? {}) as {
    reasoning?: { effort?: ReasoningEffort };
  };
  const reasoning = { ...(mr.reasoning ?? {}) };
  if (effort === undefined) delete reasoning.effort;
  else reasoning.effort = effort;
  mr.reasoning = reasoning;
  decrypted.modelRuntime = mr;
  const encrypted = encryptConfigSecrets(decrypted, noOpVault);
  await atomicWrite(targetPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
}
