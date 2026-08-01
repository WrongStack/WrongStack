import * as fs from 'node:fs/promises';
import {
  normalizeModelRef,
  parseModelRef,
  smartDefaultFallbackChain,
} from '@wrongstack/core/agent';
import { decryptConfigSecrets, encryptConfigSecrets, noOpVault } from '@wrongstack/core/security';
import { ConfigError, type SlashCommand } from '@wrongstack/core/types';
import { atomicWrite, color, toErrorMessage } from '@wrongstack/core/utils';
import { activeProfileConfigPath } from '../profile-config-path.js';
import type { SlashCommandContext } from './command-context.js';

// ── Reference validation helpers ──────────────────────────────────────────────

/**
 * Reason a ref is invalid for a chain or profile, or undefined when valid.
 * Mirrors the runtime filter inside FallbackProfileManager.resolve so the
 * slash command never accepts an entry the runtime will silently drop.
 *
 * Checks, in order:
 *  1. Parses to a non-empty model.
 *  2. The provider has a `models` allow-list and the model is in it.
 *  3. The ref is in the user's `favoriteModels` list (skipped when favorites
 *     are empty — legacy behavior: no favorites ⇒ no enforcement).
 */
function refInvalidReason(
  ref: string,
  config: {
    provider: string;
    providers?: Record<string, { models?: string[] | undefined }> | undefined;
    favoriteModels?: string[] | undefined;
  },
): string | undefined {
  const parsed = parseModelRef(ref);
  if (!parsed.model) return 'no model in reference';
  const providerId = parsed.provider ?? config.provider;
  const entry = config.providers?.[providerId];
  if (entry?.models && !entry.models.includes(parsed.model)) {
    return `"${parsed.model}" not in ${providerId} model list`;
  }
  const favorites = config.favoriteModels ?? [];
  if (favorites.length === 0) return undefined;
  const canonical = normalizeModelRef(ref, config.provider);
  const inFavorites = favorites.some((f) => normalizeModelRef(f, config.provider) === canonical);
  if (!inFavorites) return 'not in favorites';
  return undefined;
}

/**
 * A short, view-only reason a ref will be dropped at runtime. Used by the
 * `currentView()` renderer so users can see inactive chain/profile entries
 * before they trip on a 429. Returns undefined when the ref is healthy.
 */
function refInactiveReason(
  ref: string,
  config: {
    provider: string;
    providers?: Record<string, { models?: string[] | undefined }> | undefined;
  },
): string | undefined {
  const parsed = parseModelRef(ref);
  if (!parsed.model) return 'no model in reference';
  const providerId = parsed.provider ?? config.provider;
  const entry = config.providers?.[providerId];
  if (entry?.models && !entry.models.includes(parsed.model)) {
    return `"${parsed.model}" not in ${providerId} model list`;
  }
  return undefined;
}

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
    if (fileExists)
      throw new ConfigError({
        message: `Config at ${globalConfigPath} is not valid JSON: ${(err as Error).message}`,
        code: 'CONFIG_PARSE_FAILED',
        context: { filePath: globalConfigPath },
        cause: err,
      });
    parsed = {};
  }
  const decrypted = decryptConfigSecrets(parsed, noOpVault) as Record<string, unknown>;
  mutate(decrypted);
  const encrypted = encryptConfigSecrets(decrypted, noOpVault);
  await atomicWrite(globalConfigPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  return decrypted;
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
    '  /fallback profile use <name>     Make a profile the leader fallback chain',
    '  /fallback profile remove <name>  Delete a named chain',
    '  /fallback fav add <provider/model>          Add a favorite model',
    '  /fallback fav remove <n|ref>     Remove a favorite model',
    '  /fallback fav only on|off        Restrict smart defaults to favorites',
    '',
    'When the explicit chain is empty and auto is on, a chain is derived from',
    'your other keyed providers/models so 429s recover without any setup.',
    '',
    'Persisted to ~/.wrongstack/profiles/<name>/config.json.',
  ].join('\n');

  function currentView(): string {
    const config = opts.configStore.get();
    const explicit = config.fallbackModels ?? [];
    const profiles = config.fallbackProfiles ?? {};
    const favorites = config.favoriteModels ?? [];
    const bridge = config.fallbackBridge?.trim();
    const auto = config.fallbackAuto !== false;

    // Mirror effectiveFallbackChain()'s runtime filter so the displayed chain
    // never silently diverges from the one the agent actually rotates through:
    // an explicit entry is dropped at runtime when it has no model, or when its
    // provider declares a `models` list the model isn't in. Flag those here.
    const filteredReason = (ref: string): string | undefined => refInactiveReason(ref, config);

    const lines = [
      `${color.bold('WrongStack')} ${color.dim('— Fallback chain')}`,
      '',
      `  ${color.bold('leader')}  ${color.cyan(`${config.provider}/${config.model}`)}`,
      `  ${color.bold('bridge')}  ${bridge ? color.cyan(bridge) : color.dim('(disabled)')}  ${color.dim('/fallback bridge set <provider/model>')}`,
      '',
    ];

    if (explicit.length > 0) {
      lines.push(
        `  ${color.bold('explicit chain')} ${color.dim('(tried in order after the leader)')}`,
      );
      explicit.forEach((ref, i) => {
        const inactive = filteredReason(ref);
        const suffix = inactive ? `  ${color.red(`⚠ inactive — ${inactive}`)}` : '';
        lines.push(`    ${color.amber(String(i + 1).padStart(2))}. ${color.cyan(ref)}${suffix}`);
      });
    } else {
      lines.push(`  ${color.bold('explicit chain')} ${color.dim('(empty)')}`);
      const preview = auto ? smartDefaultFallbackChain(config) : [];
      if (auto) {
        if (preview.length > 0) {
          lines.push(`    ${color.dim('smart default (auto-derived):')}`);
          preview.forEach((ref, i) => {
            lines.push(`    ${color.dim(`${String(i + 1).padStart(2)}. ${ref}`)}`);
          });
        } else {
          lines.push(
            `    ${color.dim('smart default: nothing usable — add models to your providers or use /fallback add')}`,
          );
        }
      }
    }

    lines.push(
      '',
      `  ${color.bold('auto')}  ${auto ? color.green('on') : color.dim('off')}  ${color.dim('/fallback auto on|off')}`,
      `  ${color.bold('favorites only')}  ${config.favoriteModelsOnly ? color.green('on') : color.dim('off')}  ${color.dim('/fallback fav only on|off')}`,
      '',
      `  ${color.bold('profiles')} ${Object.keys(profiles).length ? '' : color.dim('(none)')}`,
      ...Object.entries(profiles)
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([name, chain]) => {
          if (!chain || chain.length === 0) {
            return [`    ${color.amber(name)} → ${color.dim('(empty)')}`];
          }
          return [
            `    ${color.amber(name)} →`,
            ...chain.map((ref) => {
              const inactive = filteredReason(ref);
              const suffix = inactive ? `  ${color.red(`⚠ inactive — ${inactive}`)}` : '';
              return `      ${color.cyan(ref)}${suffix}`;
            }),
          ];
        }),
      '',
      `  ${color.bold('favorites')} ${favorites.length ? '' : color.dim('(none)')}`,
      ...favorites.map((ref, i) => {
        const inactive = filteredReason(ref);
        const suffix = inactive ? `  ${color.red(`⚠ inactive — ${inactive}`)}` : '';
        return `    ${color.amber(String(i + 1).padStart(2))}. ${color.cyan(ref)}${suffix}`;
      }),
      '',
      color.dim(
        '  /fallback add <provider/model> · profile set fallback1 a,b · fav add a/b · help',
      ),
    );
    return lines.join('\n');
  }

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
      if (!sub) return { message: currentView() };

      const config = opts.configStore.get();
      const globalConfigPath = activeProfileConfigPath(opts.paths, config);
      const explicit = [...(config.fallbackModels ?? [])];

      try {
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
                  : invalid.startsWith('"') && invalid.includes('not in')
                    ? color.dim(
                        'Update the provider models list via provider_manage or pick a different model',
                      )
                    : ''),
            };
          }
          explicit.push(ref);
          const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
            cfg.fallbackModels = explicit;
          });
          opts.configStore.update({ fallbackModels: decrypted.fallbackModels as string[] });
          return {
            message: `${color.green('✓')} added ${color.cyan(ref)} ${color.dim(`(chain length ${explicit.length})`)}`,
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

        if (sub === 'profile') {
          const action = (parts[1] ?? '').toLowerCase();
          const name = parts[2];
          if (!['set', 'use', 'remove', 'list'].includes(action)) {
            return {
              message: `${color.amber('Usage:')} /fallback profile set <name> <ref,ref,...> | use <name> | remove <name>`,
            };
          }
          if (action === 'list') return { message: currentView() };
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
            const chain = profiles[name] ?? [];
            const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
              cfg.fallbackModels = chain;
            });
            opts.configStore.update({ fallbackModels: decrypted.fallbackModels as string[] });
            return { message: `${color.green('✓')} active chain ← profile ${color.amber(name)}` };
          }
          if (action === 'remove') {
            const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
              const next = { ...((cfg.fallbackProfiles as Record<string, string[]>) ?? {}) };
              delete next[name];
              cfg.fallbackProfiles = next;
            });
            opts.configStore.update({
              fallbackProfiles: decrypted.fallbackProfiles as Record<string, string[]>,
            });
            return { message: `${color.green('✓')} removed profile ${color.amber(name)}` };
          }
        }

        if (sub === 'fav' || sub === 'favorite' || sub === 'favorites') {
          const action = (parts[1] ?? '').toLowerCase();
          const favorites = [...(config.favoriteModels ?? [])];
          if (action === 'list' || !action) return { message: currentView() };
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
