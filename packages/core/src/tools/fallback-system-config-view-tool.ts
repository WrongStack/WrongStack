import { AGENT_CATALOG } from '../coordination/agents/index.js';
import { phaseForRole, resolveSubagentModelTarget } from '../coordination/model-matrix.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import type { FallbackManageToolOptions } from './fallback-manage-tool-options.js';
import { parseRefInternal } from './fallback-model-ref-parse.js';
// ── 8. SYSTEM_CONFIG_VIEW ───────────────────────────────────────────────────

export const SYSTEM_CONFIG_VIEW_TOOL_NAME = 'system_config_view';

const SYSTEM_CONFIG_VIEW_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    section: {
      type: 'string',
      enum: [
        'all',
        'providers',
        'models',
        'fallbacks',
        'matrix',
        'agents',
        'fleet',
        'refiner',
        'doctor',
      ],
      description:
        'Which section to show: all (everything), providers (configured providers + keys), ' +
        'models (favorites + leader), fallbacks (chain + profiles + toggles), ' +
        'matrix (per-role assignments), agents (every catalog agent with resolved model), ' +
        'fleet (concurrency + lifetime spawn/token/cost budgets), ' +
        'refiner (goal refinement config), doctor (validate config and show issues/warnings). ' +
        'Default: all.',
    },
  },
  additionalProperties: false,
};

interface SystemConfigViewInput {
  section?:
    | 'all'
    | 'providers'
    | 'models'
    | 'fallbacks'
    | 'matrix'
    | 'agents'
    | 'fleet'
    | 'refiner'
    | 'doctor'
    | undefined;
}

interface SystemConfigViewOutput {
  status: 'ok';
  message: string;
}

export function createSystemConfigViewTool(
  opts: FallbackManageToolOptions,
): Tool<SystemConfigViewInput, SystemConfigViewOutput> {
  return {
    name: SYSTEM_CONFIG_VIEW_TOOL_NAME,
    description:
      'Get a comprehensive view of all provider, model, fallback, and matrix configuration. ' +
      'Shows the complete state across all configurable areas so you can see what is available ' +
      'and make informed decisions when assigning models, creating fallback profiles, or ' +
      'managing providers. Use the section parameter to focus on specific areas.',
    usageHint:
      '"section: all" for everything. "section: providers" for configured providers and key status. ' +
      '"section: models" for leader model and favorites. ' +
      '"section: fallbacks" for chains, profiles, and toggles. ' +
      '"section: matrix" for per-role assignments. ' +
      '"section: refiner" for goal refinement config.',
    category: 'Config',
    inputSchema: SYSTEM_CONFIG_VIEW_SCHEMA,
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    icon: 'settings',
    async execute(input) {
      const config = opts.getConfig();
      const section = input.section ?? 'all';
      const sections: string[] = [];
      const addSection = (title: string, content: string) => {
        sections.push(`── ${title} ──\n${content}`);
      };

      // Always show provider/model header
      addSection('Leader', `  ${config.provider}/${config.model}`);

      if (section === 'all' || section === 'providers') {
        const providers = (config.providers ?? {}) as unknown as Record<
          string,
          Record<string, unknown>
        >;
        const ids = Object.keys(providers);
        if (ids.length === 0) {
          addSection('Providers', '  (none configured)');
        } else {
          const lines = ids.sort().map((id) => {
            const e = providers[id] ?? {};
            const type = (e.type as string) ?? '?';
            const models = Array.isArray(e.models)
              ? `[${(e.models as string[]).join(', ')}]`
              : '(all)';
            const hasKey =
              e.apiKey || (Array.isArray(e.apiKeys) && e.apiKeys.length > 0) ? '✓' : '✗';
            const baseUrl = e.baseUrl ? ` url:${e.baseUrl}` : '';
            const family = e.family ? ` family:${e.family}` : '';
            const envVars = Array.isArray(e.envVars)
              ? ` env:[${(e.envVars as string[]).join(', ')}]`
              : '';
            return `  ${id === config.provider ? '★' : ' '} ${id} (${type}) key:${hasKey} models:${models}${baseUrl}${family}${envVars}`;
          });
          addSection('Providers', lines.join('\n'));
        }
      }

      if (section === 'all' || section === 'models') {
        const favorites = config.favoriteModels ?? [];
        addSection(
          'Favorites',
          favorites.length > 0
            ? favorites.map((f, i) => `  ${i + 1}. ${f}`).join('\n')
            : '  (none — use favorite_manage to add)',
        );
        addSection(
          'Settings',
          `  fallbackAuto: ${config.fallbackAuto !== false ? 'on' : 'off'}\n` +
            `  favoriteModelsOnly: ${config.favoriteModelsOnly ? 'on' : 'off'}`,
        );
      }

      if (section === 'all' || section === 'fallbacks') {
        const fallbackModels = config.fallbackModels ?? [];
        const profiles = (config.fallbackProfiles ?? {}) as Record<string, string[]>;
        addSection('Continuity Bridge', `  ${config.fallbackBridge?.trim() || '(disabled)'}`);
        addSection(
          'Fallback Chain',
          fallbackModels.length > 0
            ? fallbackModels.map((f, i) => `  ${i + 1}. ${f}`).join('\n')
            : '  (empty — auto fallback applies when fallbackAuto is on)',
        );
        const profileNames = Object.keys(profiles);
        addSection(
          'Fallback Profiles',
          profileNames.length > 0
            ? profileNames
                .sort()
                .map((n) => `  ${n} → ${profiles[n]?.join(' → ') ?? '(empty)'}`)
                .join('\n')
            : '  (none)',
        );
      }

      if (section === 'all' || section === 'matrix') {
        const matrix = (config.modelMatrix ?? {}) as Record<string, Record<string, unknown>>;
        const keys = Object.keys(matrix);
        addSection(
          'Model Matrix (role assignments)',
          keys.length > 0
            ? keys
                .sort()
                .map((k) => `  ${k} → ${JSON.stringify(matrix[k])}`)
                .join('\n')
            : '  (empty — all roles use the leader model)',
        );
      }

      if (section === 'all' || section === 'agents') {
        const roleNames = Object.keys(AGENT_CATALOG).sort();
        const lines = roleNames.map((role) => {
          const phase = phaseForRole(role) ?? '?';
          const target = resolveSubagentModelTarget(config, role);
          const model = target?.provider
            ? `${target.provider}/${target.model ?? '(default)'}`
            : `${config.provider}/${config.model ?? '(leader)'}`;
          const src = target?.diversified
            ? ' (diversified)'
            : target?.source === 'matrix'
              ? ` (matrix:${target.matrixSource ?? '?'})`
              : '';
          return `  ${role.padEnd(24)} ${phase.padEnd(14)} ${model}${src}`;
        });
        addSection(
          `Agent Models (${roleNames.length} roles)`,
          lines.length > 0
            ? `  ${'ROLE'.padEnd(24)} ${'PHASE'.padEnd(14)} RESOLVED MODEL\n` + lines.join('\n')
            : '  (no agents in catalog)',
        );
      }

      if (section === 'all' || section === 'doctor') {
        const issues: string[] = [];
        const warnings: string[] = [];
        const ok: string[] = [];
        const providers = (config.providers ?? {}) as unknown as Record<
          string,
          Record<string, unknown>
        >;
        const favorites = config.favoriteModels ?? [];
        const profiles = (config.fallbackProfiles ?? {}) as Record<string, string[]>;
        const chain = config.fallbackModels ?? [];
        const matrix = (config.modelMatrix ?? {}) as Record<string, Record<string, unknown>>;
        const fleetBudget = (config.fleet as { budget?: Record<string, unknown> } | undefined)
          ?.budget;

        const bridge = config.fallbackBridge?.trim();
        if (bridge) {
          const parsed = parseRefInternal(bridge);
          if (!parsed.provider || !parsed.model) {
            issues.push(`Continuity bridge "${bridge}" must be a full provider/model reference`);
          } else if (!providers[parsed.provider] && parsed.provider !== config.provider) {
            issues.push(
              `Continuity bridge "${bridge}" references unknown provider "${parsed.provider}"`,
            );
          } else {
            ok.push(`Continuity bridge "${bridge}" — provider OK`);
          }
        }

        // 1. Check favorites against provider model lists
        for (const fav of favorites) {
          const p = parseRefInternal(fav);
          if (!p.model) {
            issues.push(`Favorite "${fav}" has no model (empty or whitespace-only reference)`);
            continue;
          }
          const provId = p.provider ?? config.provider;
          const model = p.model;
          const prov = providers[provId];
          if (!prov) {
            warnings.push(`Favorite "${fav}" references unknown provider "${provId}"`);
            continue;
          }
          const provModels = prov.models as string[] | undefined;
          if (provModels && provModels.length > 0 && !provModels.includes(model)) {
            warnings.push(
              `Favorite "${fav}" — model "${model}" not in ${provId} model list (${provModels.join(', ')})`,
            );
          } else {
            ok.push(`Favorite "${fav}" — provider ${provId} is configured`);
          }
        }

        // 2. Check fallback chain entries
        for (const entry of chain) {
          const p = parseRefInternal(entry);
          if (!p.model) {
            issues.push(`Chain entry "${entry}" has no model (empty or whitespace-only reference)`);
            continue;
          }
          const provId = p.provider ?? config.provider;
          if (!providers[provId] && provId !== config.provider) {
            issues.push(`Chain entry "${entry}" references unknown provider "${provId}"`);
          } else {
            ok.push(`Chain entry "${entry}" — provider OK`);
          }
        }

        // 3. Check fallback profile entries
        for (const [pname, pchain] of Object.entries(profiles)) {
          if (!pchain || pchain.length === 0) {
            warnings.push(`Profile "${pname}" is empty`);
            continue;
          }
          for (const entry of pchain) {
            const p = parseRefInternal(entry);
            if (!p.model) {
              issues.push(
                `Profile "${pname}" entry "${entry}" has no model (empty or whitespace-only reference)`,
              );
              continue;
            }
            const provId = p.provider ?? config.provider;
            if (!providers[provId] && provId !== config.provider) {
              issues.push(
                `Profile "${pname}" entry "${entry}" references unknown provider "${provId}"`,
              );
            }
          }
        }

        // 4. Fleet budget numeric ceilings
        if (typeof config.maxConcurrent === 'number') {
          if (!Number.isFinite(config.maxConcurrent) || config.maxConcurrent < 0) {
            issues.push(
              `maxConcurrent must be a non-negative number (got ${config.maxConcurrent})`,
            );
          } else if (config.maxConcurrent === 0) {
            warnings.push('maxConcurrent is 0 — subagent concurrency effectively disabled');
          } else {
            ok.push(`maxConcurrent ${config.maxConcurrent}`);
          }
        }
        if (fleetBudget && typeof fleetBudget === 'object') {
          for (const key of ['maxSpawns', 'maxTokens', 'maxCostUsd'] as const) {
            const v = fleetBudget[key];
            if (v === undefined) continue;
            if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
              issues.push(
                `fleet.budget.${key} must be a non-negative number (got ${JSON.stringify(v)})`,
              );
            } else {
              ok.push(`fleet.budget.${key} ${v}`);
            }
          }
        }

        // 4b. Check fallbackMaxLastResortCandidates
        const lastResortCap = config.fallbackMaxLastResortCandidates;
        if (lastResortCap !== undefined) {
          if (
            typeof lastResortCap !== 'number' ||
            !Number.isFinite(lastResortCap) ||
            lastResortCap < 0
          ) {
            issues.push(
              `fallbackMaxLastResortCandidates must be a non-negative number (got ${String(lastResortCap)})`,
            );
          } else if (Math.floor(lastResortCap) === 0) {
            warnings.push(
              `fallbackMaxLastResortCandidates is ${lastResortCap} — floors to 0, last-resort auto-discovery append is disabled`,
            );
          } else {
            ok.push(`fallbackMaxLastResortCandidates ${Math.floor(lastResortCap)}`);
          }
        }

        // 5. Check matrix assignments
        for (const [key, entry] of Object.entries(matrix)) {
          const eProvider = (entry.provider as string) ?? config.provider;
          const eModel = entry.model as string | undefined;
          if (eModel) {
            const provData = providers[eProvider];
            if (!provData && eProvider !== config.provider) {
              issues.push(`Matrix "${key}" references unknown provider "${eProvider}"`);
            }
            const provModels = provData?.models as string[] | undefined;
            if (provModels && provModels.length > 0 && !provModels.includes(eModel)) {
              warnings.push(`Matrix "${key}" — model "${eModel}" not in ${eProvider} model list`);
            }
          }
          // Check fallbackProfile reference
          const eProfile = entry.fallbackProfile as string | undefined;
          if (eProfile && !profiles[eProfile]) {
            issues.push(`Matrix "${key}" references unknown fallback profile "${eProfile}"`);
          }
        }

        // 5. Check leader provider
        if (!providers[config.provider] && Object.keys(providers).length > 0) {
          warnings.push(`Leader provider "${config.provider}" has no explicit config entry`);
        }

        // 6. Summary
        const summary =
          `  ✓ ${ok.length} checks passed\n` +
          `  ⚠ ${warnings.length} warnings\n` +
          `  ✗ ${issues.length} issues`;
        const lines: string[] = [summary, ''];
        if (warnings.length > 0) {
          lines.push('── Warnings ──');
          lines.push(...warnings.map((w) => `  ⚠ ${w}`));
          lines.push('');
        }
        if (issues.length > 0) {
          lines.push('── Issues ──');
          lines.push(...issues.map((i) => `  ✗ ${i}`));
          lines.push('');
        }
        if (warnings.length === 0 && issues.length === 0 && ok.length > 0) {
          lines.push('  All checks passed — configuration is healthy.');
        }
        addSection('Configuration Doctor', lines.join('\n'));
      }

      if (section === 'all' || section === 'fleet') {
        const fleet = config.fleet as
          | {
              budget?: {
                maxSpawns?: number | undefined;
                maxTokens?: number | undefined;
                maxCostUsd?: number | undefined;
              };
              lifecycle?: {
                idleTimeoutMs?: number | undefined;
                retireOnTaskComplete?: boolean | undefined;
              };
            }
          | undefined;
        const budget = fleet?.budget;
        const lifecycle = fleet?.lifecycle;
        const fmt = (n: number | undefined, unit = ''): string =>
          typeof n === 'number' && Number.isFinite(n) ? `${n}${unit}` : '(default)';
        addSection(
          'Fleet Budgets (configured ceilings)',
          [
            `  maxConcurrent: ${typeof config.maxConcurrent === 'number' ? config.maxConcurrent : '(default 4)'}`,
            `  fleet.budget.maxSpawns: ${fmt(budget?.maxSpawns)}  ${typeof budget?.maxSpawns !== 'number' ? '→ default 64' : ''}`,
            `  fleet.budget.maxTokens: ${fmt(budget?.maxTokens)}`,
            `  fleet.budget.maxCostUsd: ${fmt(budget?.maxCostUsd)}`,
            `  fleet.lifecycle.idleTimeoutMs: ${fmt(lifecycle?.idleTimeoutMs, 'ms')}`,
            `  fleet.lifecycle.retireOnTaskComplete: ${lifecycle?.retireOnTaskComplete === undefined ? '(default true)' : String(lifecycle.retireOnTaskComplete)}`,
            '',
            '  Live used/remaining spawns are on /fleet status (not static config).',
            '  Override ceilings: --max-concurrent / WRONGSTACK_MAX_CONCURRENT,',
            '  --max-spawns / WRONGSTACK_MAX_SPAWNS, or fleet.budget.maxSpawns in profile.',
          ].join('\n'),
        );
      }

      if (section === 'all' || section === 'refiner') {
        const ref = config.autonomy;
        addSection(
          'Goal Refinement',
          `  refinerProvider: ${ref?.refinerProvider ?? '(same as leader)'}\n` +
            `  refinerModel: ${ref?.refinerModel ?? '(default for provider)'}\n` +
            `  refinerFallbackProfile: ${ref?.refinerFallbackProfile ?? '(none)'}`,
        );
      }

      return { status: 'ok', message: sections.join('\n\n') };
    },
  };
}
