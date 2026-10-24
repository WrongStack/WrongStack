import type { ProviderErrorKind, SlashCommand } from '@wrongstack/contracts/types';
import {
  diagnoseFallbackConfig,
  normalizeModelRef,
  parseModelRef,
  simulateFallbackFailover,
} from '@wrongstack/core/agent';
import { color, toErrorMessage, updateJsonObjectFile } from '@wrongstack/core/utils';
import { backupCurrent } from '../config-history.js';
import { activeProfileConfigPath } from '../profile-config-path.js';
import type { SlashCommandContext } from './command-context.js';
import { renderFallbackView } from './fallback-chain-view.js';
import { refInvalidReason, refStaleModelListWarning } from './fallback-ref-validation.js';

/**
 * Canonicalize a model reference so equivalent spellings dedupe:
 * collapses whitespace around the provider/model slash and trims.
 * `anthropic / claude-x` and `anthropic/claude-x` become the same key.
 */
function normalizeRef(ref: string): string {
  return ref
    .trim()
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ');
}

function splitRefs(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => normalizeRef(s))
    .filter(Boolean);
}

/**
 * Read the global config, apply `mutate`, write it back atomically, and
 * mirror the change into the in-memory config store. Mirrors the helper in
 * `setmodel.ts` — pure I/O, safe under both the plain REPL and the Ink TUI.
 */
async function patchGlobalConfig(
  globalConfigPath: string,
  mutate: (cfg: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  return updateJsonObjectFile(globalConfigPath, async (config) => {
    await backupCurrent(undefined, globalConfigPath);
    mutate(config);
    return config;
  });
}

/**
 * `/fallback` — view or change the cross-provider fallback chain that the
 * agent rotates to when the primary model is rate-limited / overloaded
 * (429/529/5xx) and its own retries are exhausted. Argument-driven (never
 * blocks on readline) so it behaves identically in the REPL and the TUI.
 * Persists to the active profile config.
 *
 * Subcommands:
 *   (none)              Show the active chain (explicit or smart-default
 *                       preview) and the smart-default toggle.
 *   add <provider/model> Append a model reference to the explicit chain.
 *   remove <n|ref>      Remove by 1-based index or by exact reference.
 *   clear               Empty the explicit chain (smart default takes over
 *                       again when `auto` is on).
 *   bridge set <ref>    Set the single continuity route tried before the chain.
 *   bridge clear        Disable the continuity bridge.
 *   auto on|off         Toggle the smart default (config.fallbackAuto).
 *   profile use <name>  Select a named profile (config.fallbackProfile).
 *   profile none        Deselect it.
 *
 * Resolution order at runtime: explicit `fallbackModels` → selected profile →
 * smart default. The view renders the real `resolveCandidates` order, not just
 * the explicit list.
 */
export function buildFallbackCommand(opts: SlashCommandContext): SlashCommand {
  const help = [
    'Usage:',
    '  /fallback                       Show the active fallback chain + smart-default state',
    '  /fallback add <provider/model>  Append a model to the explicit chain',
    '  /fallback add <model>           Append a model on the leader provider',
    '  /fallback remove <n|ref>        Remove by 1-based index or exact reference',
    '  /fallback clear                 Empty the explicit chain',
    '  /fallback bridge set <provider/model>  Set the first continuity route',
    '  /fallback bridge clear          Disable the continuity route',
    '  /fallback auto on|off           Toggle the auto-derived smart default',
    '  /fallback profile set <name> <ref,ref,...>  Create or replace a named chain',
    '  /fallback profile use <name>     Select a profile for failover',
    '  /fallback profile none           Deselect (explicit chain / smart default apply)',
    '  /fallback profile remove <name>  Delete a named chain',
    '  /fallback fav add <provider/model>          Add a favorite model',
    '  /fallback fav remove <n|ref>     Remove a favorite model',
    '  /fallback fav only on|off        Restrict smart defaults to favorites',
    '  /fallback gate [seconds|off]     Configure modal countdown (e.g. 5, off=immediate)',
    '  /fallback doctor                 Diagnose chain health, single-provider risks, and credentials',
    '  /fallback test [errorKind]       Simulate a failover step-by-step (e.g. rate_limit, quota_exhausted)',
    '',
    'When the explicit chain is empty and auto is on, a chain is derived from',
    'your other keyed providers/models so 429s recover without any setup.',
    '',
    'Persisted to ~/.wrongstack/profiles/<name>/config.json.',
  ].join('\n');

  return {
    name: 'fallback',
    category: 'Config',
    description: 'View or change the rate-limit fallback model chain (429/529/5xx recovery).',
    argsHint: '[add <provider/model> | remove <n> | clear | auto on|off]',
    help,
    async run(args) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? '').toLowerCase();

      if (sub === 'help' || sub === '--help') return { message: this.help ?? '' };
      if (!opts.paths) {
        return { message: `${color.red('Error')} config paths not available.` };
      }
      if (!sub) return { message: renderFallbackView(opts) };

      const config = opts.configStore.get();
      const globalConfigPath = activeProfileConfigPath(opts.paths, config);
      const explicit = [...(config.fallbackModels ?? [])];

      try {
        if (sub === 'doctor' || sub === 'check' || sub === 'diag') {
          // The waiting room is the whole point of the quarantine diagnosis: without
          // the tracker the doctor cannot tell a model that is cooling down from a
          // healthy one, and reported "healthy" while failover had nowhere to go.
          const report = diagnoseFallbackConfig(config, opts.statusTracker);
          const badge =
            report.status === 'healthy'
              ? color.green('[HEALTHY]')
              : report.status === 'warning'
                ? color.amber('[WARNING]')
                : color.red('[CRITICAL]');

          const lines = [
            `${color.bold('WrongStack')} ${color.dim('— Fallback Doctor')} ${badge}`,
            '',
            `  ${color.bold('primary')}            ${color.cyan(`${report.primary.providerId}/${report.primary.model}`)}`,
            `  ${color.bold('active profile')}     ${report.activeProfile ? color.amber(report.activeProfile) : color.dim('(none)')}`,
            `  ${color.bold('effective depth')}   ${color.cyan(String(report.effectiveOrder.length))} candidate(s)`,
            `  ${color.bold('cross-provider')}     ${report.crossProviderCount > 0 ? color.green(`${report.crossProviderCount} alternative(s)`) : color.amber('0 (single provider)')}`,
            `  ${color.bold('providers in chain')} ${report.uniqueProviders.length > 0 ? report.uniqueProviders.join(', ') : color.dim('(none)')}`,
            '',
          ];

          if (report.warnings.length === 0) {
            lines.push(
              `  ${color.green('✓')} All fallback chains and configured providers are healthy.`,
              `  ${color.dim('Cross-provider failover is active and protected against sibling quarantine.')}`,
            );
          } else {
            lines.push(`  ${color.bold('Findings')} (${report.warnings.length}):`);
            for (const w of report.warnings) {
              const tag =
                w.severity === 'critical'
                  ? color.red('✖ CRITICAL')
                  : w.severity === 'warning'
                    ? color.amber('⚠ WARNING')
                    : color.cyan('ℹ INFO');
              lines.push(`    ${tag}${w.target ? ` [${color.cyan(w.target)}]` : ''}: ${w.message}`);
              if (w.recommendation) {
                lines.push(`      ${color.dim(`↳ Recommendation: ${w.recommendation}`)}`);
              }
            }
          }

          lines.push(
            '',
            color.dim('  Run /fallback test to simulate a live failover step-by-step.'),
          );
          return { message: lines.join('\n') };
        }

        if (sub === 'test' || sub === 'simulate') {
          const validErrorKinds: readonly ProviderErrorKind[] = [
            'rate_limit',
            'quota_exhausted',
            'overloaded',
            'server',
            'timeout',
            'network',
            'stream_hang',
            'auth',
            'context_overflow',
            'content_filter',
            'invalid_request',
          ];
          const requestedKind = parts[1] ?? 'rate_limit';
          if (!validErrorKinds.includes(requestedKind as ProviderErrorKind)) {
            return {
              message: `${color.amber('Error')}: unknown error kind '${color.cyan(requestedKind)}'. Valid kinds: ${validErrorKinds.map((k) => color.cyan(k)).join(', ')}`,
            };
          }
          const errorKind = requestedKind as ProviderErrorKind;
          const result = simulateFallbackFailover(config, {
            errorKind,
            ...(opts.statusTracker ? { statusTracker: opts.statusTracker } : {}),
          });

          const lines = [
            `${color.bold('WrongStack')} ${color.dim('— Fallback Simulation')} [${color.cyan(result.triggeringError)}]`,
            '',
            `  ${color.bold('trigger')}       ${color.cyan(`${result.primary.providerId}/${result.primary.model}`)} failed with ${color.amber(result.triggeringError)}`,
            `  ${color.bold('eligible')}      ${result.isFallbackEligible ? color.green('yes') : color.red('no (request-shaped error, no fallback)')}`,
            '',
          ];

          if (!result.isFallbackEligible) {
            lines.push(`  ${color.amber('Result')}: ${result.summary}`);
            return { message: lines.join('\n') };
          }

          lines.push(`  ${color.bold('Rotation sequence')}:`);
          if (result.steps.length === 0) {
            lines.push(`    ${color.red('No candidate models available in chain.')}`);
          } else {
            for (const s of result.steps) {
              const targetStr = `${s.providerId}/${s.model}`;
              if (s.skipped) {
                lines.push(
                  `    ${color.dim(`${s.index}.`)} ${color.dim(targetStr)}  ${color.amber(`[SKIPPED: ${s.reason}]`)}`,
                );
              } else {
                lines.push(
                  `    ${color.green(`${s.index}.`)} ${color.cyan(targetStr)}  ${color.green('✓ [DISPATCH TARGET]')} ${s.providerSwitched ? color.dim('(cross-provider switch)') : color.dim('(same provider)')}`,
                );
              }
            }
          }

          lines.push(
            '',
            `  ${color.bold('Outcome')}: ${result.finalTarget ? color.green(result.summary) : color.red(result.summary)}`,
          );
          return { message: lines.join('\n') };
        }

        if (sub === 'bridge') {
          const action = (parts[1] ?? '').toLowerCase();
          if (action === 'clear' || action === 'off') {
            await patchGlobalConfig(globalConfigPath, (cfg) => {
              delete cfg.fallbackBridge;
            });
            opts.configStore.update({ fallbackBridge: '' });
            return { message: `${color.green('✓')} continuity bridge disabled` };
          }
          if (action !== 'set') {
            return {
              message: `${color.amber('Usage:')} /fallback bridge set <provider/model> | clear`,
            };
          }
          const ref = normalizeRef(parts.slice(2).join(' '));
          const parsed = parseModelRef(ref);
          if (!ref || !parsed.provider || !parsed.model) {
            return {
              message: `${color.amber('Usage:')} /fallback bridge set <provider/model>`,
            };
          }
          const invalid = refInvalidReason(ref, config);
          if (invalid) {
            return { message: `${color.red('Cannot set bridge')}: "${ref}" — ${invalid}` };
          }
          const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
            cfg.fallbackBridge = ref;
          });
          opts.configStore.update({ fallbackBridge: decrypted.fallbackBridge as string });
          return { message: `${color.green('✓')} continuity bridge → ${color.cyan(ref)}` };
        }

        if (sub === 'add') {
          const ref = normalizeRef(parts.slice(1).join(' '));
          if (!ref) {
            return { message: `${color.amber('Usage:')} /fallback add <provider/model>` };
          }
          if (explicit.some((e) => normalizeRef(e) === ref)) {
            return { message: `${color.amber('Already in chain')}: ${color.cyan(ref)}` };
          }
          const invalid = refInvalidReason(ref, config);
          if (invalid) {
            return {
              message:
                `${color.red('Cannot add')}: "${ref}" — ${invalid}. ` +
                (invalid === 'not in favorites'
                  ? `${color.dim('Add it first: /fallback fav add ' + ref)}`
                  : ''),
            };
          }
          const stale = refStaleModelListWarning(ref, config);
          explicit.push(ref);
          const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
            cfg.fallbackModels = explicit;
          });
          opts.configStore.update({ fallbackModels: decrypted.fallbackModels as string[] });
          return {
            message:
              `${color.green('✓')} added ${color.cyan(ref)} ${color.dim(`(chain length ${explicit.length})`)}` +
              (stale ? `\n  ${color.amber('⚠')} ${color.dim(stale)}` : ''),
          };
        }

        if (sub === 'remove') {
          const target = parts.slice(1).join(' ').trim();
          if (!target) return { message: `${color.amber('Usage:')} /fallback remove <n|ref>` };
          if (explicit.length === 0) {
            return { message: `${color.amber('Chain is empty')} — nothing to remove.` };
          }
          let idx = -1;
          const asNum = Number.parseInt(target, 10);
          if (String(asNum) === target && asNum >= 1 && asNum <= explicit.length) {
            idx = asNum - 1;
          } else {
            const targetNorm = normalizeRef(target);
            idx = explicit.findIndex((e) => normalizeRef(e) === targetNorm);
          }
          if (idx < 0) {
            return {
              message: `${color.red('Not found')}: "${target}". Use ${color.dim('/fallback')} to see the chain.`,
            };
          }
          const [removed] = explicit.splice(idx, 1);
          const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
            cfg.fallbackModels = explicit;
          });
          opts.configStore.update({ fallbackModels: decrypted.fallbackModels as string[] });
          return { message: `${color.green('✓')} removed ${color.cyan(removed ?? target)}` };
        }

        if (sub === 'clear') {
          if (explicit.length === 0) {
            return { message: `${color.amber('Chain already empty.')}` };
          }
          const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
            cfg.fallbackModels = [];
          });
          opts.configStore.update({ fallbackModels: decrypted.fallbackModels as string[] });
          const auto = config.fallbackAuto !== false;
          return {
            message:
              `${color.green('✓')} explicit chain cleared.` +
              (auto ? color.dim(' Smart default is on — auto-derived chain still applies.') : ''),
          };
        }

        if (sub === 'auto') {
          const val = (parts[1] ?? '').toLowerCase();
          if (val !== 'on' && val !== 'off') {
            return { message: `${color.amber('Usage:')} /fallback auto on|off` };
          }
          const next = val === 'on';
          const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
            cfg.fallbackAuto = next;
          });
          opts.configStore.update({ fallbackAuto: decrypted.fallbackAuto as boolean });
          return {
            message: `${color.green('✓')} smart default ${next ? color.green('on') : color.dim('off')}`,
          };
        }

        if (sub === 'gate') {
          const val = (parts[1] ?? '').toLowerCase();
          if (!val) {
            const currentSec = config.fallbackGateSeconds ?? 7;
            const currentLabel =
              config.fallbackGateSeconds === 0
                ? color.dim('off (immediate auto-switch)')
                : color.green(`${currentSec}s`);
            return {
              message:
                `${color.bold('Fallback Gate Countdown')}: ${currentLabel}\n` +
                `${color.dim('Usage: /fallback gate <seconds> | /fallback gate off')}`,
            };
          }
          if (val === 'off' || val === '0' || val === 'disable' || val === 'disabled') {
            const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
              cfg.fallbackGateSeconds = 0;
            });
            opts.configStore.update({
              fallbackGateSeconds: decrypted.fallbackGateSeconds as number,
            });
            return {
              message: `${color.green('✓')} fallback gate countdown disabled ${color.dim('(immediate auto-switch)')}`,
            };
          }
          const value = val.trim();
          const num = /^\d+$/.test(value) ? Number(value) : Number.NaN;
          if (!Number.isSafeInteger(num) || num < 1 || num > 60) {
            return {
              message: `${color.amber('Usage:')} /fallback gate <1-60 seconds> | off`,
            };
          }
          const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
            cfg.fallbackGateSeconds = num;
          });
          opts.configStore.update({ fallbackGateSeconds: decrypted.fallbackGateSeconds as number });
          return {
            message: `${color.green('✓')} fallback gate countdown set to ${color.green(`${num}s`)}`,
          };
        }

        if (sub === 'profile') {
          const action = (parts[1] ?? '').toLowerCase();
          const name = parts[2];
          if (!['set', 'use', 'remove', 'list', 'none', 'clear'].includes(action)) {
            return {
              message: `${color.amber('Usage:')} /fallback profile set <name> <ref,ref,...> | use <name> | none | remove <name>`,
            };
          }
          if (action === 'list') return { message: renderFallbackView(opts) };
          if (action === 'none' || action === 'clear') {
            await patchGlobalConfig(globalConfigPath, (cfg) => {
              delete cfg.fallbackProfile;
            });
            opts.configStore.update({ fallbackProfile: undefined });
            return {
              message: `${color.green('✓')} no fallback profile selected ${color.dim('(explicit chain / smart default apply)')}`,
            };
          }
          if (!name) {
            return { message: `${color.amber('Usage:')} /fallback profile ${action} <name>` };
          }
          const profiles = { ...((config.fallbackProfiles ?? {}) as Record<string, string[]>) };
          if (action === 'set') {
            const chain = splitRefs(parts.slice(3).join(' '));
            if (chain.length === 0) {
              return {
                message: `${color.amber('Usage:')} /fallback profile set ${name} <provider/model,provider/model,...>`,
              };
            }
            const invalidEntries = chain
              .map((ref) => ({ ref, reason: refInvalidReason(ref, config) }))
              .filter((e): e is { ref: string; reason: string } => e.reason !== undefined);
            if (invalidEntries.length > 0) {
              const detail = invalidEntries
                .map((e) => `  ${color.cyan(e.ref)} — ${color.red(e.reason)}`)
                .join('\n');
              return {
                message:
                  `${color.red('Cannot save profile')}: ${invalidEntries.length} invalid entr${invalidEntries.length === 1 ? 'y' : 'ies'}:\n${detail}\n\n` +
                  `${color.dim('Add favorites first: /fallback fav add <ref>, or fix provider model lists.')}`,
              };
            }
            const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
              const next = { ...((cfg.fallbackProfiles as Record<string, string[]>) ?? {}) };
              next[name] = chain;
              cfg.fallbackProfiles = next;
            });
            opts.configStore.update({
              fallbackProfiles: decrypted.fallbackProfiles as Record<string, string[]>,
            });
            return {
              message: `${color.green('✓')} profile ${color.amber(name)} → ${chain.join(' → ')}`,
            };
          }
          if (!(name in profiles)) {
            return { message: `${color.red('Profile not found')}: ${color.amber(name)}` };
          }
          if (action === 'use') {
            // Selecting a profile records the NAME. It used to copy the
            // profile's entries over `fallbackModels`, which destroyed the
            // user's explicit chain with no way back and left the selection
            // invisible — and because nothing read a selected profile, that
            // copy was the only way a profile could ever take effect.
            const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
              cfg.fallbackProfile = name;
            });
            opts.configStore.update({
              fallbackProfile: decrypted.fallbackProfile as string,
            });
            const explicitActive = (config.fallbackModels ?? []).length > 0;
            return {
              message:
                `${color.green('✓')} fallback profile → ${color.amber(name)}` +
                (explicitActive
                  ? `\n  ${color.dim('Note: your explicit chain still takes precedence. Run /fallback clear to let the profile drive failover.')}`
                  : ''),
            };
          }
          if (action === 'remove') {
            const wasSelected = config.fallbackProfile === name;
            const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
              const next = { ...((cfg.fallbackProfiles as Record<string, string[]>) ?? {}) };
              delete next[name];
              cfg.fallbackProfiles = next;
              // Never leave the selection pointing at a deleted profile.
              if (cfg.fallbackProfile === name) delete cfg.fallbackProfile;
            });
            opts.configStore.update({
              fallbackProfiles: decrypted.fallbackProfiles as Record<string, string[]>,
              ...(wasSelected ? { fallbackProfile: undefined } : {}),
            });
            return {
              message:
                `${color.green('✓')} removed profile ${color.amber(name)}` +
                (wasSelected
                  ? color.dim(' (it was the selected profile — selection cleared)')
                  : ''),
            };
          }
        }

        if (sub === 'fav' || sub === 'favorite' || sub === 'favorites') {
          const action = (parts[1] ?? '').toLowerCase();
          const favorites = [...(config.favoriteModels ?? [])];
          if (action === 'list' || !action) return { message: renderFallbackView(opts) };
          if (action === 'only') {
            const val = (parts[2] ?? '').toLowerCase();
            if (val !== 'on' && val !== 'off') {
              return { message: `${color.amber('Usage:')} /fallback fav only on|off` };
            }
            const next = val === 'on';
            const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
              cfg.favoriteModelsOnly = next;
            });
            opts.configStore.update({
              favoriteModelsOnly: decrypted.favoriteModelsOnly as boolean,
            });
            return {
              message: `${color.green('✓')} favorites-only smart fallback ${next ? color.green('on') : color.dim('off')}`,
            };
          }
          if (action === 'add') {
            const ref = normalizeRef(parts.slice(2).join(' '));
            if (!ref)
              return { message: `${color.amber('Usage:')} /fallback fav add <provider/model>` };
            const key = normalizeModelRef(ref, config.provider);
            if (favorites.some((e) => normalizeModelRef(e, config.provider) === key)) {
              return { message: `${color.amber('Already favorite')}: ${color.cyan(ref)}` };
            }
            // Validate against provider allow-list (favorites is the source of truth, but
            // a favorite pointing at a model the provider will reject is a dead ring).
            const providerEntry = (() => {
              const parsed = parseModelRef(ref);
              const provId = parsed.provider ?? config.provider;
              return config.providers?.[provId];
            })();
            if (
              providerEntry?.models &&
              providerEntry.models.length > 0 &&
              !providerEntry.models.includes(parseModelRef(ref).model)
            ) {
              return {
                message:
                  `${color.red('Cannot favorite')}: "${ref}" — ${parseModelRef(ref).model} ` +
                  `not in ${parseModelRef(ref).provider ?? config.provider} model list ` +
                  `(${providerEntry.models.join(', ')}). ${color.dim('Pick a model the provider actually exposes.')}`,
              };
            }
            favorites.push(ref);
            const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
              cfg.favoriteModels = favorites;
            });
            opts.configStore.update({ favoriteModels: decrypted.favoriteModels as string[] });
            return { message: `${color.green('✓')} favorite added ${color.cyan(ref)}` };
          }
          if (action === 'remove') {
            const target = parts.slice(2).join(' ').trim();
            if (!target)
              return { message: `${color.amber('Usage:')} /fallback fav remove <n|ref>` };
            let idx = -1;
            const asNum = Number.parseInt(target, 10);
            if (String(asNum) === target && asNum >= 1 && asNum <= favorites.length) {
              idx = asNum - 1;
            } else {
              const key = normalizeModelRef(target, config.provider);
              idx = favorites.findIndex((e) => normalizeModelRef(e, config.provider) === key);
            }
            if (idx < 0) return { message: `${color.red('Favorite not found')}: "${target}"` };
            const [removed] = favorites.splice(idx, 1);
            const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
              cfg.favoriteModels = favorites;
            });
            opts.configStore.update({ favoriteModels: decrypted.favoriteModels as string[] });
            return {
              message: `${color.green('✓')} favorite removed ${color.cyan(removed ?? target)}`,
            };
          }
          return {
            message: `${color.red('Unknown favorite command')} "${action}". Try ${color.dim('/fallback fav add <provider/model>')}.`,
          };
        }

        return {
          message: `${color.red('Unknown subcommand')} "${sub}". Try ${color.dim('/fallback')}, ${color.dim('/fallback add <provider/model>')}, or ${color.dim('/fallback help')}.`,
        };
      } catch (err) {
        return {
          message: `${color.red('fallback error')}: ${toErrorMessage(err)}`,
        };
      }
    },
  };
}
