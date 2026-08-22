import * as fs from 'node:fs/promises';
import type { ModelMatrixEntry } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import type { SubcommandHandler } from '../contracts.js';
import { runModeldiagBench } from './modeldiag-bench.js';
import { type ModelDiagConfig, runModeldiagEval } from './modeldiag-eval.js';
import {
  type CacheModel,
  type CacheProvider,
  checkMark,
  costLabel,
  findProfile,
  fmtPrice,
  fmtTokens,
  rankModels,
  roleCat,
  scoreBar,
  speedLabel,
} from './modeldiag-profiles.js';
import { runModeldiagTest } from './modeldiag-test.js';

/**
 * `wrongstack modeldiag` — read-only diagnostics: key check, capability scan,
 * heuristic suggestions, and real model benchmarking. Never modifies config.
 */

async function readProviders(cachePath: string | undefined): Promise<CacheProvider[] | string> {
  if (!cachePath) {
    return `${color.red('Models cache not available')}.`;
  }
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const payload = (parsed.payload ?? parsed) as Record<string, Record<string, unknown>>;
    return Object.entries(payload).map(([id, p]) => ({
      id: (p.id as string) ?? id,
      name: (p.name as string) ?? id,
      family: (p.npm as string) ?? id,
      models: Object.values((p.models as Record<string, Record<string, unknown>>) ?? {}).map(
        (m) => ({
          id: m.id as string,
          name: m.name as string | undefined,
          capabilities: {
            contextWindow: (m.limit as { context?: number } | undefined)?.context,
            maxOutputTokens: (m.limit as { output?: number } | undefined)?.output,
          },
          pricing: m.cost as { input?: number; output?: number } | undefined,
        }),
      ),
    }));
  } catch {
    return `${color.amber('Models cache not available')}. Run wstack sync-models.`;
  }
}

function checkHasKey(pid: string, config: ModelDiagConfig): boolean {
  if (pid === config.provider && config.provider) return true;
  const pc = config.providers?.[pid];
  if (!pc) return false;
  if (typeof pc.apiKey === 'string' && pc.apiKey.length > 0) return true;
  if (Array.isArray(pc.apiKeys) && pc.apiKeys.some((k) => k?.apiKey)) return true;
  return false;
}

export const modeldiagCmd: SubcommandHandler = async (args, deps) => {
  const sub = args[0]?.toLowerCase() || 'full';

  const cacheResult = await readProviders(deps.paths.modelsCache);
  if (typeof cacheResult === 'string') {
    deps.renderer.write(`${cacheResult}\n`);
    return cacheResult.includes(color.red('')) ? 1 : 0;
  }
  const providers = cacheResult;

  const config = deps.config as ModelDiagConfig;
  const modelMatrix = (config.modelMatrix ?? {}) as Record<string, ModelMatrixEntry>;

  function hasKey(pid: string): boolean {
    return checkHasKey(pid, config);
  }

  function writeLine(line = '') {
    deps.renderer.write(`${line}\n`);
  }

  if (sub === 'keys') {
    writeLine(`${color.bold('API Key Status')}`);
    writeLine();
    for (const prov of providers) {
      const k = hasKey(prov.id);
      writeLine(`  ${checkMark(k)} ${color.bold(prov.id.padEnd(18))} ${color.dim(prov.name)}`);
    }
    writeLine();
    writeLine(`${color.dim(`Leader: ${config.provider}/${config.model}`)}`);
    return 0;
  }

  if (sub === 'caps') {
    writeLine(`${color.bold('Model Capabilities')} ${color.dim('— matched to known profiles')}`);
    writeLine();

    for (const prov of providers) {
      if (!hasKey(prov.id)) continue;
      writeLine(`  ${color.bold(prov.id)} ${color.dim(`(${prov.name})`)}`);

      const tiers: Record<string, CacheModel[]> = {
        premium: [],
        standard: [],
        budget: [],
        unknown: [],
      };
      for (const m of prov.models ?? []) {
        const profile = findProfile(prov.id, m.id);
        tiers[profile?.costTier ?? 'unknown']?.push(m);
      }

      for (const tier of ['premium', 'standard', 'budget', 'unknown'] as const) {
        const tierModels = tiers[tier]!;
        if (tierModels.length === 0) continue;
        const label = tier === 'unknown' ? color.dim('unmatched') : `${costLabel(tier)} ${tier}`;
        writeLine(`    ${label}`);
        for (const m of tierModels) {
          const cap = m.capabilities;
          const ctx = cap?.contextWindow ?? 0;
          const maxOut = cap?.maxOutputTokens ?? 0;
          const profile = findProfile(prov.id, m.id);
          const family = profile
            ? `${speedLabel(profile.speedTier)} ${color.green(profile.family)}`
            : color.dim('no profile match');
          const pricing = m.pricing
            ? `${color.dim('in')}${fmtPrice(m.pricing.input)} ${color.dim('out')}${fmtPrice(m.pricing.output)}`
            : color.dim('pricing ?');
          writeLine(
            `      ${color.cyan(m.id.padEnd(34))}` +
              `${ctx > 0 ? `ctx ${fmtTokens(ctx).padEnd(6)}` : color.dim('ctx ?  ')}` +
              `${maxOut > 0 ? `out ${fmtTokens(maxOut).padEnd(6)}` : '        '}` +
              `${family}   ${pricing}`,
          );
        }
      }
      writeLine();
    }

    writeLine(
      color.dim(
        'Prices in USD per 1M tokens (input/output). ctx = context window, out = max output.',
      ),
    );
    return 0;
  }

  async function renderSuggest(): Promise<void> {
    writeLine();
    writeLine(
      `${color.bold('Agent → Model Suggestions')} ${color.amber('(heuristic — untested)')}`,
    );
    writeLine(
      color.dim(
        'These are profile-based best guesses. Test them with wstack modeldiag bench <role> "<prompt>".',
      ),
    );
    writeLine();

    const keyedProviders = providers.filter((p) => hasKey(p.id));
    if (keyedProviders.length === 0) {
      writeLine(
        `  ${color.amber('No providers have API keys configured. Add keys with wstack auth.')}`,
      );
    } else {
      const roles = [
        'security-scanner',
        'bug-hunter',
        'planner',
        'architect',
        'refactor-planner',
        'verifier',
        'test',
        'document',
        'reviewer',
        'code-reviewer',
        'executor',
        'debugger',
      ];

      for (const role of roles) {
        if (modelMatrix[role]) {
          const entry = modelMatrix[role]!;
          const p = entry.provider ?? config.provider;
          writeLine(
            `  ${color.dim(role.padEnd(20))} → ${color.cyan(`${p}/${entry.model}`)}  ${color.dim('(user-configured)')}`,
          );
          continue;
        }

        const cat = roleCat(role);
        const ranked = rankModels(providers, hasKey, cat, 3);

        if (ranked.length === 0) {
          writeLine(`  ${color.dim(role.padEnd(20))} → ${color.dim('no candidates')}`);
          continue;
        }

        const best = ranked[0]!;
        const family = best.profile ? ` ${color.dim(`(${best.profile.family})`)}` : '';
        const bar = scoreBar(best.score, 110);
        writeLine(
          `  ${color.amber(role.padEnd(20))} → ${color.cyan(`${best.provider}/${best.model}`)}${family}`,
        );
        writeLine(`  ${' '.repeat(22)}  ${bar}  ${color.dim(cat)}`);

        if (
          ranked.length > 1 &&
          (ranked[1]?.score ?? Number.NEGATIVE_INFINITY) >= best.score - 15
        ) {
          for (const alt of ranked.slice(1)) {
            const af = alt.profile ? ` (${alt.profile.family})` : '';
            writeLine(
              `  ${' '.repeat(22)}  ${color.dim(`${alt.provider}/${alt.model}${af}  score ${alt.score}`)}`,
            );
          }
        }
      }

      writeLine();
      writeLine(
        `  ${color.bold('leader'.padEnd(20))} → ${color.cyan(`${config.provider}/${config.model}`)}`,
      );
    }
  }

  if (sub === 'suggest') {
    await renderSuggest();
    writeLine();
    writeLine(color.dim('Pin a suggestion:  wstack setmodel set <role> <provider>/<model>'));
    writeLine(color.dim('Test candidates:   wstack modeldiag bench <role> "<test prompt>"'));
    return 0;
  }

  if (sub === 'test') {
    return runModeldiagTest(args, deps, config);
  }

  if (sub === 'bench') {
    return runModeldiagBench(args, deps, providers, config, hasKey);
  }

  if (sub === 'eval' || sub === 'evall') {
    return runModeldiagEval(args, deps, providers, config, hasKey);
  }

  // ── full (default) ──
  writeLine(`${color.bold('API Key Status')}`);
  writeLine();
  for (const prov of providers) {
    const k = hasKey(prov.id);
    writeLine(`  ${checkMark(k)} ${color.bold(prov.id.padEnd(18))} ${color.dim(prov.name)}`);
  }
  writeLine();
  writeLine(`${color.dim(`Leader: ${config.provider}/${config.model}`)}`);

  writeLine();
  writeLine(`${color.bold('Model Capabilities')} ${color.dim('— matched to known profiles')}`);
  writeLine();

  for (const prov of providers) {
    if (!hasKey(prov.id)) continue;
    writeLine(`  ${color.bold(prov.id)} ${color.dim(`(${prov.name})`)}`);

    const tiers: Record<string, CacheModel[]> = {
      premium: [],
      standard: [],
      budget: [],
      unknown: [],
    };
    for (const m of prov.models ?? []) {
      const profile = findProfile(prov.id, m.id);
      tiers[profile?.costTier ?? 'unknown']?.push(m);
    }

    for (const tier of ['premium', 'standard', 'budget', 'unknown'] as const) {
      const tierModels = tiers[tier]!;
      if (tierModels.length === 0) continue;
      const label = tier === 'unknown' ? color.dim('unmatched') : `${costLabel(tier)} ${tier}`;
      writeLine(`    ${label}`);
      for (const m of tierModels) {
        const cap = m.capabilities;
        const ctx = cap?.contextWindow ?? 0;
        const maxOut = cap?.maxOutputTokens ?? 0;
        const profile = findProfile(prov.id, m.id);
        const family = profile
          ? `${speedLabel(profile.speedTier)} ${color.green(profile.family)}`
          : color.dim('no profile match');
        const pricing = m.pricing
          ? `${color.dim('in')}${fmtPrice(m.pricing.input)} ${color.dim('out')}${fmtPrice(m.pricing.output)}`
          : color.dim('pricing ?');
        writeLine(
          `      ${color.cyan(m.id.padEnd(34))}` +
            `${ctx > 0 ? `ctx ${fmtTokens(ctx).padEnd(6)}` : color.dim('ctx ?  ')}` +
            `${maxOut > 0 ? `out ${fmtTokens(maxOut).padEnd(6)}` : '        '}` +
            `${family}   ${pricing}`,
        );
      }
    }
    writeLine();
  }

  await renderSuggest();
  writeLine();
  writeLine(color.dim('Pin a suggestion:  wstack setmodel set <role> <provider>/<model>'));
  writeLine(color.dim('Test candidates:   wstack modeldiag bench <role> "<test prompt>"'));
  return 0;
};
