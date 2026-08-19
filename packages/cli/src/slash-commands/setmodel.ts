import * as fs from 'node:fs/promises';
import { fallbackProfileChain, parseModelRef } from '@wrongstack/core/agent';
import { AGENT_CATALOG, AGENTS_BY_PHASE, type AgentPhase } from '@wrongstack/core/agent-catalog';
import {
  MATRIX_PHASE_KEYS,
  matrixKeyKind,
  phaseForRole,
  resolveModelMatrix,
  resolveModelTargetFromEntry,
} from '@wrongstack/core/coordination';
import { decryptConfigSecrets, encryptConfigSecrets, noOpVault } from '@wrongstack/core/security';
import {
  ConfigError,
  type ModelMatrixEntry,
  type ProviderConfig,
  REASONING_EFFORT_LEVELS,
  type ReasoningEffort,
  isReasoningEffort,
  type SlashCommand,
} from '@wrongstack/core/types';
import { atomicWrite, color, expectDefined, toErrorMessage } from '@wrongstack/core/utils';
import { catalogProviderIdFor } from '@wrongstack/providers';
import { visibleModelIds } from '../provider-helpers.js';
import type { SlashCommandContext } from './command-context.js';

/**
 * Catalog model ids per provider, resolved through the same alias rules as the
 * capability overlay so a gateway saved as `ai-gateway` reads the models.dev id
 * that actually publishes it. Includes anything auto-discovery merged into the
 * registry at boot. Best-effort: a missing or failing registry yields an empty
 * map and callers fall back to the saved list.
 */
async function resolveCatalogModelIds(
  registry: import('@wrongstack/core/types').ModelsRegistry | undefined,
  config: import('@wrongstack/core/types').Config,
  providerIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!registry) return out;
  await Promise.all(
    providerIds.map(async (id) => {
      try {
        const catalogId = catalogProviderIdFor(id, config.providers?.[id]?.type);
        const provider = await registry.getProvider(catalogId);
        if (provider)
          out.set(
            id,
            provider.models.map((m) => m.id),
          );
      } catch {
        // Best-effort — an unreachable catalog must not break the command.
      }
    }),
  );
  return out;
}

/** Keep a 300-model gateway list readable in a terminal. */
function summarizeModelIds(ids: string[], limit = 8): string {
  if (ids.length <= limit) return ids.join(', ');
  return `${ids.slice(0, limit).join(', ')} ${color.dim(`… +${ids.length - limit} more`)}`;
}

/** A provider is selectable when it has a stored key, a key list, or a
 *  populated env var. Mirrors `hasApiKey` but config-only (no registry). */
function providerHasKey(entry: ProviderConfig | undefined): boolean {
  if (!entry) return false;
  if (typeof entry.apiKey === 'string' && entry.apiKey.length > 0) return true;
  if (Array.isArray(entry.apiKeys) && entry.apiKeys.some((k) => k?.apiKey)) return true;
  if (Array.isArray(entry.envVars) && entry.envVars.some((v) => !!process.env[v])) return true;
  return false;
}

/** Provider ids the user can target — those with a key, plus the active one. */
function keyedProviderIds(config: {
  provider: string;
  providers?: Record<string, ProviderConfig>;
}): string[] {
  const ids = new Set<string>();
  if (config.provider) ids.add(config.provider);
  for (const [id, entry] of Object.entries(config.providers ?? {})) {
    if (providerHasKey(entry)) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * Parse `<provider>/<model>`, `<provider> <model>`, or a bare `<model>`
 * (provider omitted → leader provider at resolve time) into a matrix entry.
 */
function parseTarget(
  tokens: string[],
  profiles: Record<string, string[]> = {},
): ModelMatrixEntry | { error: string } {
  if (tokens.length >= 2) {
    return { provider: tokens[0], model: tokens.slice(1).join(' ') };
  }
  const only = tokens[0];
  if (!only) return { error: 'missing <provider>/<model>' };
  if (profiles[only]) return { fallbackProfile: only };
  if (only.includes('/')) {
    const i = only.indexOf('/');
    return { provider: only.slice(0, i), model: only.slice(i + 1) };
  }
  return { model: only };
}

// REASONING_EFFORT_LEVELS / isReasoningEffort are imported from
// @wrongstack/core/types — the canonical single source of truth.

function isReasoningMode(value: string | undefined): value is 'auto' | 'on' | 'off' {
  return value === 'auto' || value === 'on' || value === 'off';
}

function parseBoolWord(value: string | undefined): boolean | undefined {
  if (value === 'on' || value === 'true' || value === 'yes') return true;
  if (value === 'off' || value === 'false' || value === 'no') return false;
  return undefined;
}

function fmtRuntime(e: ModelMatrixEntry): string {
  const reasoning = e.modelRuntime?.reasoning;
  if (!reasoning) return '';
  const parts = [
    reasoning.mode ? `mode:${reasoning.mode}` : '',
    reasoning.effort ? `effort:${reasoning.effort}` : '',
    reasoning.preserve !== undefined ? `preserve:${reasoning.preserve ? 'on' : 'off'}` : '',
  ].filter(Boolean);
  return parts.length ? color.dim(` reasoning(${parts.join(' ')})`) : '';
}

function fmtEntry(e: ModelMatrixEntry): string {
  const runtime = fmtRuntime(e);
  if (e.fallbackProfile && !e.model) return `profile:${e.fallbackProfile}${runtime}`;
  if (e.fallbackProfile && e.model) {
    const base = e.provider
      ? `${e.provider}/${e.model}`
      : `${e.model} ${color.dim('(leader provider)')}`;
    return `${base} ${color.dim(`+ profile:${e.fallbackProfile}`)}${runtime}`;
  }
  if (!e.model) return `${color.dim('(leader model)')}${runtime}`;
  return `${e.provider ? `${e.provider}/${e.model}` : `${e.model} ${color.dim('(leader provider)')}`}${runtime}`;
}

/**
 * Read the active profile config, apply `mutate`, write it back atomically, and
 * mirror the change into the in-memory config store. Pure I/O — safe under
 * both the plain REPL and the Ink TUI.
 */
async function patchProfileConfig(
  mutate: (cfg: Record<string, unknown>) => void,
  profileConfigPath: string,
): Promise<Record<string, unknown>> {
  const targetPath = profileConfigPath;
  let raw = '{}';
  let fileExists = true;
  try {
    raw = await fs.readFile(targetPath, 'utf8');
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
        message: `Config at ${targetPath} is not valid JSON: ${(err as Error).message}`,
        code: 'CONFIG_PARSE_FAILED',
        context: { filePath: targetPath },
        cause: err,
      });
    parsed = {};
  }
  const decrypted = decryptConfigSecrets(parsed, noOpVault) as Record<string, unknown>;
  mutate(decrypted);
  const encrypted = encryptConfigSecrets(decrypted, noOpVault);
  await atomicWrite(targetPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  return decrypted;
}

/**
 * `/setmodel` — view or change the active leader model and the per-task
 * model matrix. Argument-driven (never blocks on readline) so it behaves
 * identically in the REPL and the TUI. Persists to the active profile config.
 *
 * Subcommands:
 *   (none)       Show leader model, matrix, and a summary of which model each
 *                catalog role resolves to.
 *   list         List keyed providers, their models, and valid matrix keys.
 *   leader       Set the main (leader / brain) model.
 *   set          Pin a role, phase, or * to a specific model.
 *   clear        Remove a matrix entry.
 *   resolve      Walk the resolution chain for one role and show the result.
 *   doctor       Validate all matrix entries against available providers and
 *                models. Flag orphans, missing providers, and typos.
 */
export function buildSetModelCommand(opts: SlashCommandContext): SlashCommand {
  const help = [
    'Usage:',
    '  /setmodel                              Show leader model + matrix + resolution summary',
    '  /setmodel list                         List keyed providers, their models, and valid keys',
    '  /setmodel leader <provider> <model>    Set the main (leader / brain) model',
    '  /setmodel leader <fallbackProfile>     Set leader primary/fallbacks from a profile',
    '  /setmodel set <key> <provider>/<model> Pin a role/phase/* to a model',
    '  /setmodel set <key> <fallbackProfile>  Pin a role/phase/* to a fallback profile',
    '  /setmodel set <key> <model>            Pin to a model on the leader provider',
    '  /setmodel reasoning <key> auto|on|off [effort]  Set role/phase reasoning mode',
    '  /setmodel reasoning-effort <key> none|minimal|low|medium|high|xhigh|max',
    '  /setmodel reasoning-preserve <key> on|off',
    '  /setmodel clear <key>                  Remove a matrix entry',
    '  /setmodel resolve <role>              Walk the resolution chain for one role',
    '  /setmodel doctor                       Validate matrix entries (orphans, typos, missing keys)',
    '',
    'Keys: a catalog role (e.g. security-scanner), a phase (' + MATRIX_PHASE_KEYS.join(', ') + '),',
    'or * for the fleet-wide default. Precedence at spawn: role → phase → * → leader.',
    '',
    'Persisted to ~/.wrongstack/profiles/<name>/config.json.',
  ].join('\n');

  function currentView(): string {
    const config = opts.configStore.get();
    const matrix = (config.modelMatrix ?? {}) as Record<string, ModelMatrixEntry>;
    const keys = Object.keys(matrix);
    const lines = [
      `${color.bold('WrongStack')} ${color.dim('— Models')}`,
      '',
      `  ${color.bold('leader')}  ${color.cyan(`${config.provider}/${config.model}`)}   ${color.dim('/setmodel leader <provider> <model>')}`,
      '',
    ];

    // Matrix entries
    if (keys.length === 0) {
      lines.push(
        `  ${color.bold('matrix')} ${color.dim('(empty)')}`,
        `    ${color.dim('pin a role: /setmodel set <role> <provider>/<model>')}`,
        `    ${color.dim('set default: /setmodel set * <provider>/<model>')}`,
      );
    } else {
      lines.push(`  ${color.bold('matrix')} ${color.dim('(role → phase → * → leader)')}`);
      for (const k of keys.sort()) {
        const kind = matrixKeyKind(k);
        const tag = kind === 'unknown' ? color.red('?') : color.dim(kind);
        lines.push(
          `    ${color.amber(k.padEnd(22))} → ${fmtEntry(expectDefined(matrix[k]))}   ${tag}`,
        );
      }
    }

    // Resolution summary — show what key roles resolve to
    const summaryRoles = getSummaryRoles();
    if (summaryRoles.length > 0) {
      lines.push('');
      lines.push(`  ${color.bold('resolution')} ${color.dim('(selected roles)')}`);
      for (const role of summaryRoles) {
        const target = resolveModelTargetFromEntry(config, resolveModelMatrix(matrix, role));
        const provider = target?.provider ?? config.provider;
        const model = target?.model ?? config.model;
        const source = resolutionSource(matrix, role);
        lines.push(
          `    ${color.dim(role.padEnd(22))} → ${color.cyan(`${provider}/${model}`)}  ${color.dim(source)}`,
        );
      }
    }

    lines.push('', color.dim('  /setmodel list · resolve <role> · doctor · help'));
    return lines.join('\n');
  }

  /** Roles worth showing in the summary: one per phase + key legacy roles. */
  function getSummaryRoles(): string[] {
    const picks: string[] = [];
    // One representative from each phase
    for (const phase of MATRIX_PHASE_KEYS) {
      const agents = AGENTS_BY_PHASE[phase as AgentPhase];
      if (agents && agents.length > 0) {
        picks.push(agents[0]?.config.role as string);
      }
    }
    // Key legacy roles
    picks.push('security-scanner', 'bug-hunter');
    return [...new Set(picks)].sort();
  }

  /** Human-readable description of where a role's model comes from. */
  function resolutionSource(
    matrix: Record<string, ModelMatrixEntry> | undefined,
    role: string,
  ): string {
    if (!matrix) return 'leader';
    if (matrix[role]) return 'role';
    const phase = phaseForRole(role);
    if (phase && matrix[phase]) return `phase (${phase})`;
    if (matrix['*']) return 'default (*)';
    return 'leader';
  }

  return {
    name: 'setmodel',
    category: 'Config',
    description: 'View or change the leader model and the per-task model matrix.',
    help,
    async run(args) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? '').toLowerCase();

      if (sub === 'help' || sub === '--help') return { message: this.help ?? '' };
      if (!opts.configStore || !opts.paths) {
        return { message: `${color.red('Error')} config store not available.` };
      }
      if (!sub) return { message: currentView() };

      const config = opts.configStore.get();
      const keyed = keyedProviderIds(config);
      const profileConfigPath = opts.paths.profileConfig(
        (config as { activeProfile?: string }).activeProfile ?? 'default',
      );
      const matrix = (config.modelMatrix ?? {}) as Record<string, ModelMatrixEntry>;

      if (sub === 'list') {
        // The saved `models` array is an ADDITIVE allowlist, not the whole
        // truth: runtime-discovered gateway models live in the registry and
        // never touch config. Reading config alone made a provider with 300+
        // reachable models look like it had six.
        const catalogModels = await resolveCatalogModelIds(opts.modelsRegistry, config, keyed);
        const provLines = keyed.map((id) => {
          const models = visibleModelIds(id, config, catalogModels.get(id) ?? []);
          const ms = models.length
            ? summarizeModelIds(models)
            : color.dim('(any model id accepted)');
          return `    ${color.cyan(id.padEnd(16))} ${ms}`;
        });
        const roles = Object.keys(AGENT_CATALOG).sort();
        return {
          message: [
            `${color.bold('Keyed providers')} ${color.dim('(targets for /setmodel)')}`,
            ...(provLines.length ? provLines : [`    ${color.dim('none — add a key first')}`]),
            '',
            `${color.bold('Phases')}: ${MATRIX_PHASE_KEYS.join(', ')}`,
            `${color.bold('Default')}: *`,
            '',
            `${color.bold('Roles')} ${color.dim(`(${roles.length})`)}:`,
            `    ${roles.join(', ')}`,
          ].join('\n'),
        };
      }

      // ---- resolve <role> ----
      if (sub === 'resolve') {
        const role = parts[1];
        if (!role) {
          return { message: `${color.amber('Usage:')} /setmodel resolve <role>` };
        }
        const kind = matrixKeyKind(role);
        if (kind === 'unknown' && role !== '*') {
          return {
            message: `${color.red('Unknown role')}: "${role}". Use ${color.dim('/setmodel list')} to see valid roles.`,
          };
        }
        const lines: string[] = [`${color.bold('Resolution chain')} for ${color.amber(role)}`, ''];

        // Walk the chain step by step
        const phase = phaseForRole(role);
        const resolved = resolveModelMatrix(matrix, role);

        // Step 1: exact role
        if (matrix[role]) {
          lines.push(
            `  1. matrix["${role}"] → ${fmtEntry(expectDefined(matrix[role]))}  ${color.green('✓ exact role')}`,
          );
        } else {
          lines.push(`  1. matrix["${role}"] → ${color.dim('not set')}`);
        }

        // Step 2: phase
        if (phase) {
          if (matrix[phase]) {
            lines.push(
              `  2. matrix["${phase}"] → ${fmtEntry(expectDefined(matrix[phase]))}  ${matrix[role] ? color.dim('(skipped — role matched)') : color.green('✓ phase match')}`,
            );
          } else {
            lines.push(`  2. matrix["${phase}"] → ${color.dim('not set')}`);
          }
        }

        // Step 3: *
        if (matrix['*']) {
          const skipped = matrix[role] || (phase && matrix[phase]);
          lines.push(
            `  3. matrix["*"] → ${fmtEntry(expectDefined(matrix['*']))}  ${skipped ? color.dim('(skipped)') : color.green('✓ default')}`,
          );
        } else {
          lines.push(`  3. matrix["*"] → ${color.dim('not set')}`);
        }

        // Step 4: leader fallback
        const leaderSkipped = matrix[role] || (phase && matrix[phase]) || matrix['*'];
        lines.push(
          `  4. ${color.dim('leader fallback')} → ${color.cyan(`${config.provider}/${config.model}`)}  ${leaderSkipped ? color.dim('(skipped)') : color.green('✓ used')}`,
        );

        lines.push('');

        // Final result
        if (resolved) {
          const target = resolveModelTargetFromEntry(config, resolved);
          const rp = target?.provider ?? config.provider;
          const rm = target?.model ?? config.model;
          const suffix = target?.fallbackModels?.length
            ? color.dim(`  fallbacks: ${target.fallbackModels.join(' → ')}`)
            : '';
          lines.push(`${color.green('✓ Resolved')}: ${color.cyan(`${rp}/${rm}`)}${suffix}`);
        } else {
          lines.push(
            `${color.green('✓ Resolved')}: ${color.cyan(`${config.provider}/${config.model}`)} ${color.dim('(leader)')}`,
          );
        }

        return { message: lines.join('\n') };
      }

      // ---- doctor ----
      if (sub === 'doctor') {
        const issues: string[] = [];
        const warnings: string[] = [];
        const doctorCatalogModels = await resolveCatalogModelIds(
          opts.modelsRegistry,
          config,
          keyed,
        );

        for (const [key, entry] of Object.entries(matrix)) {
          // 1. Check key validity
          const kind = matrixKeyKind(key);
          if (kind === 'unknown') {
            issues.push(
              `${color.red('✗')} ${color.amber(key)}: not a valid role, phase, or * — ${color.dim('typo or stale entry?')}`,
            );
          }

          // 2. Check provider exists and has a key
          if (entry.provider) {
            const provCfg = config.providers?.[entry.provider];
            if (!provCfg) {
              issues.push(
                `${color.red('✗')} ${color.amber(key)}: provider "${entry.provider}" is not configured`,
              );
            } else if (!providerHasKey(provCfg)) {
              warnings.push(
                `${color.amber('⚠')} ${color.amber(key)}: provider "${entry.provider}" has no API key`,
              );
            }
          }

          // 3. Check model is reachable for the provider. The saved list is
          //    additive, so a model discovered at runtime is legitimate even
          //    though it never appears in config — warn only when BOTH the
          //    saved list and the catalog fail to account for it.
          const effectiveProvider = entry.provider ?? config.provider;
          const provCfg = config.providers?.[effectiveProvider];
          if (entry.model && provCfg?.models && provCfg.models.length > 0) {
            const reachable = visibleModelIds(
              effectiveProvider,
              config,
              doctorCatalogModels.get(effectiveProvider) ?? [],
            );
            if (!reachable.includes(entry.model)) {
              warnings.push(
                `${color.amber('⚠')} ${color.amber(key)}: model "${entry.model}" not in ${effectiveProvider}'s model list (${summarizeModelIds(reachable)})`,
              );
            }
          }
          if (entry.fallbackProfile && !config.fallbackProfiles?.[entry.fallbackProfile]) {
            issues.push(
              `${color.red('✗')} ${color.amber(key)}: fallback profile "${entry.fallbackProfile}" is not defined`,
            );
          }
        }

        // 4. Check for orphaned roles (roles in catalog not covered by any matrix key)
        if (Object.keys(matrix).length > 0 && !matrix['*']) {
          const covered = new Set<string>();
          for (const [key] of Object.entries(matrix)) {
            covered.add(key);
          }
          // Phase-level coverage
          const phasesCovered = new Set(
            Object.keys(matrix).filter((k) => matrixKeyKind(k) === 'phase'),
          );
          const unprotected: string[] = [];
          for (const role of Object.keys(AGENT_CATALOG)) {
            if (covered.has(role)) continue;
            const ph = phaseForRole(role);
            if (ph && phasesCovered.has(ph)) continue;
            unprotected.push(role);
          }
          if (unprotected.length > 0) {
            const sample = unprotected.slice(0, 10);
            const suffix = unprotected.length > 10 ? ` +${unprotected.length - 10} more` : '';
            warnings.push(
              `${color.amber('⚠')} ${unprotected.length} role(s) have no matrix coverage and no * default: ${sample.join(', ')}${suffix}`,
            );
          }
        }

        const header = [
          `${color.bold('Matrix Doctor')} ${color.dim('— ' + Object.keys(matrix).length + ' entries')}`,
          '',
        ];

        if (issues.length === 0 && warnings.length === 0) {
          header.push(`${color.green('✓')} All matrix entries are valid. No issues found.`);
        }

        const allLines = [
          ...header,
          ...(issues.length ? ['', `${color.bold('Issues')}:`, ...issues] : []),
          ...(warnings.length ? ['', `${color.bold('Warnings')}:`, ...warnings] : []),
        ];

        return { message: allLines.join('\n') };
      }

      try {
        if (sub === 'leader') {
          const profiles = (config.fallbackProfiles ?? {}) as Record<string, string[]>;
          if (parts.length === 2 && profiles[parts[1] ?? '']) {
            const profile = parts[1]!;
            const chain = fallbackProfileChain(config, profile);
            const first = chain[0];
            if (!first)
              return { message: `${color.red('Empty profile')}: ${color.amber(profile)}` };
            const parsed = parseModelRef(first);
            const provider = parsed.provider ?? config.provider;
            if (!keyed.includes(provider)) {
              return {
                message: `${color.red('Provider not available')}: "${provider}". Keyed: ${keyed.join(', ') || '(none)'}. ${color.dim('/setmodel list')}`,
              };
            }
            const decrypted = await patchProfileConfig((cfg) => {
              cfg.provider = provider;
              cfg.model = parsed.model;
              cfg.fallbackModels = chain.slice(1);
            }, profileConfigPath);
            opts.configStore.update({
              provider: decrypted.provider as string,
              model: decrypted.model as string,
              fallbackModels: decrypted.fallbackModels as string[],
            });
            return {
              message: `${color.green('✓')} leader → ${color.cyan(`${provider}/${parsed.model}`)} ${color.dim(`profile:${profile}`)}`,
            };
          }
          const provider = parts[1];
          const model = parts.slice(2).join(' ');
          if (!provider || !model) {
            return {
              message: `${color.amber('Usage:')} /setmodel leader <provider> <model> | <fallbackProfile>`,
            };
          }
          if (!keyed.includes(provider)) {
            return {
              message: `${color.red('Provider not available')}: "${provider}". Keyed: ${keyed.join(', ') || '(none)'}. ${color.dim('/setmodel list')}`,
            };
          }
          const decrypted = await patchProfileConfig((cfg) => {
            cfg.provider = provider;
            cfg.model = model;
          }, profileConfigPath);
          opts.configStore.update({
            provider: decrypted.provider as string,
            model: decrypted.model as string,
          });
          return { message: `${color.green('✓')} leader → ${color.cyan(`${provider}/${model}`)}` };
        }

        if (sub === 'reasoning' || sub === 'reasoning-effort' || sub === 'reasoning-preserve') {
          const key = parts[1];
          if (!key) {
            return {
              message: `${color.amber('Usage:')} /setmodel ${sub} <role|phase|*> ${
                sub === 'reasoning'
                  ? 'auto|on|off [effort]'
                  : sub === 'reasoning-effort'
                    ? REASONING_EFFORT_LEVELS.join('|')
                    : 'on|off'
              }`,
            };
          }
          if (matrixKeyKind(key) === 'unknown') {
            return {
              message: `${color.red('Unknown key')}: "${key}". Use * , a phase (${MATRIX_PHASE_KEYS.join(', ')}), or a role. ${color.dim('/setmodel list')}`,
            };
          }

          let nextMode: 'auto' | 'on' | 'off' | undefined;
          let nextEffort: ReasoningEffort | undefined;
          let nextPreserve: boolean | undefined;

          if (sub === 'reasoning') {
            nextMode = parts[2] as typeof nextMode;
            if (!isReasoningMode(nextMode)) {
              return {
                message: `${color.amber('Usage:')} /setmodel reasoning ${key} auto|on|off [effort]`,
              };
            }
            if (parts[3] !== undefined) {
              if (!isReasoningEffort(parts[3])) {
                return {
                  message: `${color.red('Invalid effort')}: "${parts[3]}". Expected ${REASONING_EFFORT_LEVELS.join(', ')}.`,
                };
              }
              nextEffort = parts[3];
            }
          } else if (sub === 'reasoning-effort') {
            if (!isReasoningEffort(parts[2])) {
              return {
                message: `${color.amber('Usage:')} /setmodel reasoning-effort ${key} ${REASONING_EFFORT_LEVELS.join('|')}`,
              };
            }
            nextEffort = parts[2];
          } else {
            nextPreserve = parseBoolWord(parts[2]);
            if (nextPreserve === undefined) {
              return {
                message: `${color.amber('Usage:')} /setmodel reasoning-preserve ${key} on|off`,
              };
            }
          }

          const decrypted = await patchProfileConfig((cfg) => {
            const matrix = { ...((cfg.modelMatrix as Record<string, ModelMatrixEntry>) ?? {}) };
            const entry = { ...(matrix[key] ?? {}) } as ModelMatrixEntry;
            const modelRuntime = { ...(entry.modelRuntime ?? {}) };
            const reasoning = { ...(modelRuntime.reasoning ?? {}) };
            if (nextMode !== undefined) reasoning.mode = nextMode;
            if (nextEffort !== undefined) reasoning.effort = nextEffort;
            if (nextPreserve !== undefined) reasoning.preserve = nextPreserve;
            modelRuntime.reasoning = reasoning;
            entry.modelRuntime = modelRuntime;
            matrix[key] = entry;
            cfg.modelMatrix = matrix;
          }, profileConfigPath);
          opts.configStore.update({
            modelMatrix: decrypted.modelMatrix as Record<string, ModelMatrixEntry>,
          });
          return {
            message: `${color.green('✓')} ${color.amber(key)} → ${fmtEntry(
              (decrypted.modelMatrix as Record<string, ModelMatrixEntry>)[key]!,
            )}`,
          };
        }

        if (sub === 'set') {
          const key = parts[1];
          if (!key) {
            return {
              message: `${color.amber('Usage:')} /setmodel set <role|phase|*> <provider>/<model>`,
            };
          }
          if (matrixKeyKind(key) === 'unknown') {
            return {
              message: `${color.red('Unknown key')}: "${key}". Use * , a phase (${MATRIX_PHASE_KEYS.join(', ')}), or a role. ${color.dim('/setmodel list')}`,
            };
          }
          const parsed = parseTarget(
            parts.slice(2),
            (config.fallbackProfiles ?? {}) as Record<string, string[]>,
          );
          if ('error' in parsed) {
            return { message: `${color.amber('Usage:')} /setmodel set ${key} <provider>/<model>` };
          }
          if (parsed.provider && !keyed.includes(parsed.provider)) {
            return {
              message: `${color.red('Provider not available')}: "${parsed.provider}". Keyed: ${keyed.join(', ') || '(none)'}.`,
            };
          }
          const decrypted = await patchProfileConfig((cfg) => {
            const matrix = { ...((cfg.modelMatrix as Record<string, ModelMatrixEntry>) ?? {}) };
            const previousRuntime = matrix[key]?.modelRuntime;
            matrix[key] =
              parsed.fallbackProfile && !parsed.model
                ? {
                    fallbackProfile: parsed.fallbackProfile,
                    ...(previousRuntime ? { modelRuntime: previousRuntime } : {}),
                  }
                : parsed.provider
                  ? {
                      provider: parsed.provider,
                      model: parsed.model,
                      ...(parsed.fallbackProfile
                        ? { fallbackProfile: parsed.fallbackProfile }
                        : {}),
                      ...(previousRuntime ? { modelRuntime: previousRuntime } : {}),
                    }
                  : {
                      model: parsed.model,
                      ...(parsed.fallbackProfile
                        ? { fallbackProfile: parsed.fallbackProfile }
                        : {}),
                      ...(previousRuntime ? { modelRuntime: previousRuntime } : {}),
                    };
            cfg.modelMatrix = matrix;
          }, profileConfigPath);
          opts.configStore.update({
            modelMatrix: decrypted.modelMatrix as Record<string, ModelMatrixEntry>,
          });
          return { message: `${color.green('✓')} ${color.amber(key)} → ${fmtEntry(parsed)}` };
        }

        if (sub === 'clear') {
          const key = parts[1];
          if (!key) return { message: `${color.amber('Usage:')} /setmodel clear <key>` };
          const existing = (config.modelMatrix ?? {}) as Record<string, ModelMatrixEntry>;
          if (!(key in existing)) {
            return { message: `${color.amber('No matrix entry')} for "${key}".` };
          }
          const decrypted = await patchProfileConfig((cfg) => {
            const matrix = { ...((cfg.modelMatrix as Record<string, ModelMatrixEntry>) ?? {}) };
            delete matrix[key];
            cfg.modelMatrix = matrix;
          }, profileConfigPath);
          opts.configStore.update({
            modelMatrix: decrypted.modelMatrix as Record<string, ModelMatrixEntry>,
          });
          return { message: `${color.green('✓')} cleared ${color.amber(key)}` };
        }

        return {
          message: `${color.red('Unknown subcommand')} "${sub}". Try ${color.dim('/setmodel')}, ${color.dim('/setmodel set <key> <provider>/<model>')}, or ${color.dim('/setmodel help')}.`,
        };
      } catch (err) {
        return {
          message: `${color.red('setmodel error')}: ${toErrorMessage(err)}`,
        };
      }
    },
  };
}
