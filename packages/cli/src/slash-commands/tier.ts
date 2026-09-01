/**
 * `/tier` — the CLI/TUI surface for the deterministic model-tier layer.
 *
 * Sibling to `/fallback profile`: a profile answers "which models, in what
 * order", and a tier answers "how expensive should this job be", binding a
 * profile to a spend budget and to a routing rule. Everything this command
 * writes lands in `modelTiers` in the active profile config, so the TUI menu,
 * the WebUI editor and this command all read and write one place.
 */

import * as fs from 'node:fs/promises';
import { leaderTierPolicy, listTierIds, resolveTier } from '@wrongstack/core/coordination';
import type { Config, ModelTierLevel, SlashCommand } from '@wrongstack/core/types';
import { ConfigError } from '@wrongstack/core/types';
import { atomicWrite, color, toErrorMessage } from '@wrongstack/core/utils';
import { activeProfileConfigPath } from '../profile-config-path.js';
import type { SlashCommandContext } from './command-context.js';

const LEADER_MODES = ['off', 'propose', 'auto'] as const;

async function patchGlobalConfig(
  globalConfigPath: string,
  mutate: (cfg: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  let raw = '{}';
  let fileExists = true;
  try {
    raw = await fs.readFile(globalConfigPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    fileExists = false;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if (fileExists) {
      throw new ConfigError({
        code: 'CONFIG_PARSE_FAILED',
        message: `Config at ${globalConfigPath} is not valid JSON: ${(err as Error).message}`,
      });
    }
    parsed = {};
  }
  mutate(parsed);
  await atomicWrite(globalConfigPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

/** Read the tiers object out of a raw config record, creating it if absent. */
function tiersOf(cfg: Record<string, unknown>): Record<string, unknown> {
  const existing = cfg['modelTiers'];
  if (existing && typeof existing === 'object') return existing as Record<string, unknown>;
  const created: Record<string, unknown> = {};
  cfg['modelTiers'] = created;
  return created;
}

function levelsOf(tiers: Record<string, unknown>): Record<string, ModelTierLevel> {
  const existing = tiers['levels'];
  if (existing && typeof existing === 'object') return existing as Record<string, ModelTierLevel>;
  const created: Record<string, ModelTierLevel> = {};
  tiers['levels'] = created;
  return created;
}

function routingOf(tiers: Record<string, unknown>): Record<string, string> {
  const existing = tiers['routing'];
  if (existing && typeof existing === 'object') return existing as Record<string, string>;
  const created: Record<string, string> = {};
  tiers['routing'] = created;
  return created;
}

export function buildTierCommand(opts: SlashCommandContext): SlashCommand {
  function currentView(): string {
    const config = opts.configStore.get();
    const tiers = config.modelTiers;
    const lines: string[] = [];

    if (!tiers?.enabled) {
      lines.push(
        `${color.amber('Model tiers are off.')} Turn them on with ${color.dim('/tier on')}, then define levels:`,
        color.dim('  /tier set budget cheap-profile  ·  /tier budget budget 0.25'),
        '',
      );
    }

    const ids = tiers?.enabled ? listTierIds(config) : Object.keys(tiers?.levels ?? {});
    if (ids.length === 0) {
      lines.push(color.dim('  (no levels configured)'));
    } else {
      lines.push(color.bold('  Levels'));
      for (const id of ids) {
        const level = tiers?.levels?.[id];
        const resolved = tiers?.enabled ? resolveTier(config, { tier: id }) : undefined;
        const target = resolved?.model
          ? `${resolved.provider ?? config.provider}/${resolved.model}`
          : color.dim(level?.fallbackProfile ? `profile: ${level.fallbackProfile}` : '(empty)');
        const budget = [
          level?.maxCostUsd !== undefined ? `$${level.maxCostUsd}` : '',
          level?.maxIterations !== undefined ? `${level.maxIterations} iters` : '',
          level?.maxToolCalls !== undefined ? `${level.maxToolCalls} tools` : '',
        ].filter(Boolean);
        lines.push(
          `    ${color.cyan(id)}: ${target}${budget.length ? color.dim(`  [${budget.join(' · ')}]`) : ''}`,
        );
      }
    }

    const routing = tiers?.routing ?? {};
    lines.push('', color.bold('  Routing'));
    const routingKeys = Object.keys(routing);
    if (routingKeys.length === 0) {
      lines.push(
        color.dim(`    (none — everything uses the default tier: ${tiers?.default ?? 'standard'})`),
      );
    } else {
      for (const key of routingKeys) lines.push(`    ${key} → ${color.cyan(routing[key] ?? '')}`);
    }

    const policy = leaderTierPolicy(config);
    lines.push(
      '',
      color.bold('  Leader self-switching'),
      `    mode: ${color.cyan(policy.mode)}${policy.mode === 'propose' ? color.dim(' (asks before switching)') : ''}`,
      color.dim(
        `    dwell ${policy.dwellTurns} turn(s) · min saving $${policy.minSavingsUsd} · ` +
          `context cap ${Math.round(policy.maxContextFillForSwitch * 100)}%` +
          (policy.maxTier ? ` · ceiling ${policy.maxTier}` : ''),
      ),
      '',
      color.dim('  /tier help for the full command list'),
    );
    return lines.join('\n');
  }

  const help = [
    color.bold('/tier — deterministic cost levels for models'),
    '',
    'A tier binds a fallback profile (which models), a budget (how much it may spend)',
    'and a runtime setting (how hard it thinks) under one name, then routes work to it',
    'by role or phase. Subagents, Kanban dispatch and the leader all read the same table.',
    '',
    color.bold('  Levels'),
    '  /tier                          show everything',
    '  /tier on | off                 enable or disable the whole layer',
    '  /tier set <tier> <profile>     point a level at a fallback profile',
    '  /tier budget <tier> <usd> [iters] [tools]',
    '                                 set the spend budget for a level',
    '  /tier remove <tier>            delete a level',
    '',
    color.bold('  Routing'),
    '  /tier route <role|phase|*> <tier>   route work to a level',
    '  /tier unroute <role|phase|*>        drop a routing rule',
    '  /tier default <tier>                tier used when nothing matches',
    '',
    color.bold('  Leader'),
    `  /tier leader <${LEADER_MODES.join('|')}>   how much authority the leader has over its own tier`,
    '  /tier leader dwell <turns>          minimum turns between switches',
    '  /tier leader ceiling <tier|none>    highest tier the leader may pick alone',
    '',
    color.dim('  Levels are ordered by declaration: the first is the cheapest rung.'),
  ].join('\n');

  return {
    name: 'tier',
    category: 'Config',
    description: 'View or change model cost tiers (budget/standard/premium) and their routing.',
    argsHint: '[on|off | set <tier> <profile> | route <key> <tier> | leader <mode>]',
    help,
    async run(args) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? '').toLowerCase();

      if (sub === 'help' || sub === '--help') return { message: this.help ?? '' };
      if (!opts.paths) return { message: `${color.red('Error')} config paths not available.` };
      if (!sub) return { message: currentView() };

      const config = opts.configStore.get();
      const globalConfigPath = activeProfileConfigPath(opts.paths, config);

      const persist = async (
        mutate: (tiers: Record<string, unknown>) => void,
      ): Promise<void> => {
        const parsed = await patchGlobalConfig(globalConfigPath, (cfg) => {
          mutate(tiersOf(cfg));
        });
        opts.configStore.update({
          modelTiers: parsed['modelTiers'] as Config['modelTiers'],
        });
      };

      try {
        if (sub === 'on' || sub === 'off') {
          const enabled = sub === 'on';
          await persist((tiers) => {
            tiers['enabled'] = enabled;
          });
          return {
            message:
              `${color.green('✓')} model tiers ${enabled ? color.green('on') : color.dim('off')}` +
              (enabled && Object.keys(config.modelTiers?.levels ?? {}).length === 0
                ? `\n  ${color.dim('No levels yet — try /tier set budget <profile>')}`
                : ''),
          };
        }

        if (sub === 'set') {
          const tier = parts[1];
          const profile = parts[2];
          if (!tier || !profile) {
            return { message: `${color.amber('Usage:')} /tier set <tier> <fallback-profile>` };
          }
          if (!config.fallbackProfiles?.[profile]) {
            const known = Object.keys(config.fallbackProfiles ?? {});
            return {
              message:
                `${color.red('Unknown fallback profile')} "${profile}"` +
                (known.length
                  ? `. Known: ${known.join(', ')}`
                  : `. Create one first: ${color.dim('/fallback profile set <name> a,b')}`),
            };
          }
          await persist((tiers) => {
            const levels = levelsOf(tiers);
            levels[tier] = { ...(levels[tier] ?? {}), fallbackProfile: profile };
          });
          return {
            message: `${color.green('✓')} tier ${color.cyan(tier)} → profile ${color.cyan(profile)}`,
          };
        }

        if (sub === 'budget') {
          const tier = parts[1];
          if (!tier) {
            return {
              message: `${color.amber('Usage:')} /tier budget <tier> <maxCostUsd> [maxIterations] [maxToolCalls]`,
            };
          }
          const usd = Number.parseFloat(parts[2] ?? '');
          if (!Number.isFinite(usd) || usd < 0) {
            return { message: `${color.red('Invalid')} maxCostUsd: "${parts[2] ?? ''}"` };
          }
          // maxIterations/maxToolCalls get the same validation as maxCostUsd: a
          // negative value stored here propagates through resolveTier().budget →
          // applyTierToSubagentConfig into every agent spawned under the tier,
          // where `iterations >= maxIterations` is instantly true — the agent
          // does zero work while this command reported ✓. A non-numeric value
          // must not be silently dropped either: the ✓ reply would hide it.
          const iters = parts[3] !== undefined ? Number.parseInt(parts[3], 10) : undefined;
          if (iters !== undefined && (!Number.isFinite(iters) || iters < 0)) {
            return { message: `${color.red('Invalid')} maxIterations: "${parts[3]}"` };
          }
          const tools = parts[4] !== undefined ? Number.parseInt(parts[4], 10) : undefined;
          if (tools !== undefined && (!Number.isFinite(tools) || tools < 0)) {
            return { message: `${color.red('Invalid')} maxToolCalls: "${parts[4]}"` };
          }
          await persist((tiers) => {
            const levels = levelsOf(tiers);
            levels[tier] = {
              ...(levels[tier] ?? {}),
              maxCostUsd: usd,
              ...(iters !== undefined && Number.isFinite(iters) ? { maxIterations: iters } : {}),
              ...(tools !== undefined && Number.isFinite(tools) ? { maxToolCalls: tools } : {}),
            };
          });
          return {
            message:
              `${color.green('✓')} tier ${color.cyan(tier)} budget → $${usd}` +
              (iters !== undefined && Number.isFinite(iters) ? ` · ${iters} iters` : '') +
              (tools !== undefined && Number.isFinite(tools) ? ` · ${tools} tools` : ''),
          };
        }

        if (sub === 'remove' || sub === 'rm') {
          const tier = parts[1];
          if (!tier) return { message: `${color.amber('Usage:')} /tier remove <tier>` };
          if (!config.modelTiers?.levels?.[tier]) {
            return { message: `${color.red('No such tier')}: "${tier}"` };
          }
          await persist((tiers) => {
            const levels = levelsOf(tiers);
            delete levels[tier];
            // A routing rule pointing at a deleted level would silently fall
            // through to the default, so drop those rules with it.
            const routing = routingOf(tiers);
            for (const [key, value] of Object.entries(routing)) {
              if (value === tier) delete routing[key];
            }
          });
          return { message: `${color.green('✓')} tier ${color.cyan(tier)} removed` };
        }

        if (sub === 'route') {
          const key = parts[1];
          const tier = parts[2];
          if (!key || !tier) {
            return { message: `${color.amber('Usage:')} /tier route <role|phase|*> <tier>` };
          }
          if (!config.modelTiers?.levels?.[tier]) {
            const known = Object.keys(config.modelTiers?.levels ?? {});
            return {
              message:
                `${color.red('Unknown tier')} "${tier}"` +
                (known.length ? `. Known: ${known.join(', ')}` : '. Define one with /tier set.'),
            };
          }
          await persist((tiers) => {
            routingOf(tiers)[key] = tier;
          });
          return {
            message: `${color.green('✓')} ${color.cyan(key)} → tier ${color.cyan(tier)}`,
          };
        }

        if (sub === 'unroute') {
          const key = parts[1];
          if (!key) return { message: `${color.amber('Usage:')} /tier unroute <role|phase|*>` };
          if (config.modelTiers?.routing?.[key] === undefined) {
            return { message: `${color.red('No routing rule for')} "${key}"` };
          }
          await persist((tiers) => {
            delete routingOf(tiers)[key];
          });
          return { message: `${color.green('✓')} routing rule for ${color.cyan(key)} removed` };
        }

        if (sub === 'default') {
          const tier = parts[1];
          if (!tier) return { message: `${color.amber('Usage:')} /tier default <tier>` };
          if (!config.modelTiers?.levels?.[tier]) {
            return { message: `${color.red('Unknown tier')} "${tier}".` };
          }
          await persist((tiers) => {
            tiers['default'] = tier;
          });
          return { message: `${color.green('✓')} default tier → ${color.cyan(tier)}` };
        }

        if (sub === 'leader') {
          const action = (parts[1] ?? '').toLowerCase();

          if ((LEADER_MODES as readonly string[]).includes(action)) {
            await persist((tiers) => {
              const leader = (tiers['leader'] ?? {}) as Record<string, unknown>;
              leader['mode'] = action;
              tiers['leader'] = leader;
            });
            const note =
              action === 'auto'
                ? `\n  ${color.amber('The leader may now change its own model without asking.')} ` +
                  color.dim('Guard rails (dwell, context window, ceiling, break-even) still apply.')
                : action === 'off'
                  ? `\n  ${color.dim('Tiers still route subagents and Kanban dispatch.')}`
                  : '';
            return {
              message: `${color.green('✓')} leader tier mode → ${color.cyan(action)}${note}`,
            };
          }

          if (action === 'dwell') {
            const turns = Number.parseInt(parts[2] ?? '', 10);
            if (!Number.isFinite(turns) || turns < 0) {
              return { message: `${color.amber('Usage:')} /tier leader dwell <turns>` };
            }
            await persist((tiers) => {
              const leader = (tiers['leader'] ?? {}) as Record<string, unknown>;
              leader['dwellTurns'] = turns;
              tiers['leader'] = leader;
            });
            return { message: `${color.green('✓')} leader dwell → ${turns} turn(s)` };
          }

          if (action === 'ceiling') {
            const tier = parts[2];
            if (!tier) {
              return { message: `${color.amber('Usage:')} /tier leader ceiling <tier|none>` };
            }
            if (tier !== 'none' && !config.modelTiers?.levels?.[tier]) {
              return { message: `${color.red('Unknown tier')} "${tier}".` };
            }
            await persist((tiers) => {
              const leader = (tiers['leader'] ?? {}) as Record<string, unknown>;
              if (tier === 'none') delete leader['maxTier'];
              else leader['maxTier'] = tier;
              tiers['leader'] = leader;
            });
            return {
              message: `${color.green('✓')} leader ceiling → ${tier === 'none' ? color.dim('none') : color.cyan(tier)}`,
            };
          }

          return {
            message: `${color.amber('Usage:')} /tier leader <${LEADER_MODES.join('|')}> | dwell <turns> | ceiling <tier|none>`,
          };
        }

        return {
          message: `${color.red('Unknown subcommand')} "${sub}". Try ${color.dim('/tier')} or ${color.dim('/tier help')}.`,
        };
      } catch (err) {
        return { message: `${color.red('tier error')}: ${toErrorMessage(err)}` };
      }
    },
  };
}
