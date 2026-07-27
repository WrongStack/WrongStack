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
      enum: ['all', 'providers', 'models', 'fallbacks', 'matrix', 'agents', 'refiner', 'doctor'],
      description:
        'Which section to show: all (everything), providers (configured providers + keys), ' +
        'models (favorites + leader), fallbacks (chain + profiles + toggles), ' +
        'matrix (per-role assignments), agents (every catalog agent with resolved model), ' +
        'refiner (goal refinement config), doctor (validate config and show issues/warnings). ' +
        'Default: all.',
    },
  },
  additionalProperties: false,
};

interface SystemConfigViewInput {
  section?: 'all' | 'providers' | 'models' | 'fallbacks' | 'matrix' | 'agents' | 'refiner' | 'doctor' | undefined;
}

interface SystemConfigViewOutput {
  status: 'ok';
  message: string;
}

export function createSystemConfigViewTool(opts: FallbackManageToolOptions): Tool<SystemConfigViewInput, SystemConfigViewOutput> {
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
      addSection(
        'Leader',
        `  ${config.provider}/${config.model}`,
      );

      if (section === 'all' || section === 'providers') {
        const providers = (config.providers ?? {}) as unknown as Record<string, Record<string, unknown>>;
        const ids = Object.keys(providers);
        if (ids.length === 0) {
          addSection('Providers', '  (none configured)');
        } else {
          const lines = ids.sort().map((id) => {
            const e = providers[id] ?? {};
            const type = (e.type as string) ?? '?';
            const models = Array.isArray(e.models) ? `[${(e.models as string[]).join(', ')}]` : '(all)';
            const hasKey = e.apiKey || (Array.isArray(e.apiKeys) && e.apiKeys.length > 0) ? '✓' : '✗';
            const baseUrl = e.baseUrl ? ` url:${e.baseUrl}` : '';
            const family = e.family ? ` family:${e.family}` : '';
            const envVars = Array.isArray(e.envVars) ? ` env:[${(e.envVars as string[]).join(', ')}]` : '';
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
            ? profileNames.sort().map((n) => `  ${n} → ${profiles[n]?.join(' → ') ?? '(empty)'}`).join('\n')
            : '  (none)',
        );
      }

      if (section === 'all' || section === 'matrix') {
        const matrix = (config.modelMatrix ?? {}) as Record<string, Record<string, unknown>>;
        const keys = Object.keys(matrix);
        addSection(
          'Model Matrix (role assignments)',
          keys.length > 0
            ? keys.sort().map((k) => `  ${k} → ${JSON.stringify(matrix[k])}`).join('\n')
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
        const providers = (config.providers ?? {}) as unknown as Record<string, Record<string, unknown>>;
        const favorites = config.favoriteModels ?? [];
        const profiles = (config.fallbackProfiles ?? {}) as Record<string, string[]>;
        const chain = config.fallbackModels ?? [];
        const matrix = (config.modelMatrix ?? {}) as Record<string, Record<string, unknown>>;

        // 1. Check favorites against provider model lists
        for (const fav of favorites) {
          const p = parseRefInternal(fav);
          const provId = p.provider ?? config.provider;
          const model = p.model;
          const prov = providers[provId];
          if (!prov) {
            warnings.push(`Favorite "${fav}" references unknown provider "${provId}"`);
            continue;
          }
          const provModels = prov.models as string[] | undefined;
          if (provModels && provModels.length > 0 && !provModels.includes(model)) {
            warnings.push(`Favorite "${fav}" — model "${model}" not in ${provId} model list (${provModels.join(', ')})`);
          } else {
            ok.push(`Favorite "${fav}" — provider ${provId} is configured`);
          }
        }

        // 2. Check fallback chain entries
        for (const entry of chain) {
          const p = parseRefInternal(entry);
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
            const provId = p.provider ?? config.provider;
            if (!providers[provId] && provId !== config.provider) {
              issues.push(`Profile "${pname}" entry "${entry}" references unknown provider "${provId}"`);
            }
          }
        }

        // 4. Check matrix assignments
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
        const summary = `  ✓ ${ok.length} checks passed\n` +
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
