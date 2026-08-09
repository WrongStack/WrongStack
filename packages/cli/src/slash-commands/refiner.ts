import { noOpVault } from '@wrongstack/core/security';
import type { SlashCommand } from '@wrongstack/core/types';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import { activeProfileConfigPath } from '../profile-config-path.js';
import { persistAutonomySetting } from '../settings-menu.js';
import type { SlashCommandContext } from './command-context.js';
import { parseSubcommand, unknownSubcommand } from './helpers.js';

/**
 * `/refiner` — view or change the goal-refiner provider/model.
 *
 * Subcommands:
 *   (none) / show     — show current refiner config
 *   set provider <id> — set the refiner provider
 *   set model <id>    — set the refiner model
 *   clear             — clear both (use session defaults)
 *
 * Same config backend as /settings refiner-provider and /settings refiner-model.
 */
export function buildRefinerCommand(opts: SlashCommandContext): SlashCommand {
  const help = [
    'Usage:',
    '  /refiner                                    Show current refiner config',
    '  /refiner show                               Show current refiner config',
    '  /refiner set provider <id>                   Set the refiner provider (e.g. "opencode-go")',
    '  /refiner set model <id>                      Set the refiner model (e.g. "deepseek-v4-flash")',
    '  /refiner set fallback-profile <name>         Set the refiner fallback profile (e.g. "default")',
    '  /refiner clear                               Clear all refiner config (use session defaults)',
    '',
    'When refiner-provider and refiner-model are set, goal refinement uses that',
    'dedicated provider+model instead of the session main model. When a fallback-profile',
    'is set, the first valid entry from that named profile chain is used instead.',
    'Falls back to the session model when all are unset or unavailable.',
    '',
    'Also configurable via /settings refiner-provider <id>, /settings refiner-model <id>,',
    'and /settings refiner-fallback-profile <name>.',
  ].join('\n');

  return {
    name: 'refiner',
    category: 'Config',
    description:
      'View or change the goal-refiner provider/model. Falls back to session defaults when unset.',
    help,
    async run(args) {
      const { cmd, rest } = parseSubcommand(args);

      if (cmd === 'help' || cmd === '--help') {
        return { message: this.help ?? '' };
      }

      if (!opts.configStore || !opts.paths) {
        return { message: `${color.red('Error')} config store not available.` };
      }

      // ── show / bare ──
      if (!cmd || cmd === 'show') {
        const cfg = opts.configStore.get();
        const autonomy = cfg.autonomy as Record<string, unknown> | undefined;
        const provider = autonomy?.refinerProvider as string | undefined;
        const model = autonomy?.refinerModel as string | undefined;
        const fallbackProfile = autonomy?.refinerFallbackProfile as string | undefined;
        const msg = [
          `${color.bold('Refiner Config')}`,
          '',
          `  provider:         ${provider ? color.cyan(provider) : color.dim('(unset — uses session provider)')}`,
          `  model:            ${model ? color.cyan(model) : color.dim('(unset — uses session model)')}`,
          `  fallback-profile: ${fallbackProfile ? color.cyan(fallbackProfile) : color.dim('(unset)')}`,
          '',
          color.dim(
            'Change: /refiner set provider|model|fallback-profile <value> · /refiner clear',
          ),
        ].join('\n');
        return { message: msg };
      }

      // ── set ──
      if (cmd === 'set') {
        const field = rest[0]?.toLowerCase();
        const value = rest.slice(1).join(' ').trim();

        if (!field) {
          return {
            message: `${color.amber('Usage:')} /refiner set provider|model|fallback-profile <value>`,
          };
        }

        if (!value) {
          return {
            message: `${color.amber('Usage:')} /refiner set ${field} <value>   ${color.dim('(missing value)')}`,
          };
        }

        const persistDeps = {
          configStore: opts.configStore,
          profileConfigPath: activeProfileConfigPath(opts.paths, opts.configStore.get()),
          inProjectConfigPath: opts.paths.inProjectConfig,
          vault: noOpVault,
        };

        try {
          if (field === 'provider') {
            await persistAutonomySetting(persistDeps, (autonomy) => {
              (autonomy as Record<string, unknown>).refinerProvider = value;
            });
            return {
              message: `${color.green('✓')} refiner-provider → ${color.cyan(value)}   ${color.dim('goal refinement will use this provider when refiner-model is also set')}`,
            };
          }

          if (field === 'model') {
            await persistAutonomySetting(persistDeps, (autonomy) => {
              (autonomy as Record<string, unknown>).refinerModel = value;
            });
            return {
              message: `${color.green('✓')} refiner-model → ${color.cyan(value)}   ${color.dim('goal refinement will use this model when it passes favorites/active validation')}`,
            };
          }

          if (field === 'fallback-profile' || field === 'fallbackprofile' || field === 'profile') {
            await persistAutonomySetting(persistDeps, (autonomy) => {
              (autonomy as Record<string, unknown>).refinerFallbackProfile = value;
            });
            return {
              message: `${color.green('✓')} refiner-fallback-profile → ${color.cyan(value)}   ${color.dim('goal refinement will use the first valid entry from this profile chain')}`,
            };
          }

          return {
            message: `${color.red('Unknown field')} "${field}". ${unknownSubcommand(field, ['provider', 'model', 'fallback-profile'], 'refiner set')}`,
          };
        } catch (err) {
          return {
            message: `${color.red('refiner error')}: ${toErrorMessage(err)}`,
          };
        }
      }

      // ── clear ──
      if (cmd === 'clear') {
        const persistDeps = {
          configStore: opts.configStore,
          profileConfigPath: activeProfileConfigPath(opts.paths, opts.configStore.get()),
          inProjectConfigPath: opts.paths.inProjectConfig,
          vault: noOpVault,
        };
        try {
          await persistAutonomySetting(persistDeps, (autonomy) => {
            (autonomy as Record<string, unknown>).refinerProvider = undefined;
            (autonomy as Record<string, unknown>).refinerModel = undefined;
            (autonomy as Record<string, unknown>).refinerFallbackProfile = undefined;
          });
          return {
            message: `${color.green('✓')} Refiner config cleared   ${color.dim('goal refinement will use the session provider+model')}`,
          };
        } catch (err) {
          return {
            message: `${color.red('refiner error')}: ${toErrorMessage(err)}`,
          };
        }
      }

      // ── unknown ──
      return {
        message: `${color.red('Unknown subcommand')} "${cmd}". ${unknownSubcommand(cmd, ['show', 'set', 'clear'], 'refiner')}`,
      };
    },
  };
}
