/**
 * Model competency evaluation handler for `wrongstack modeldiag eval`.
 *
 * @module subcommands/handlers/modeldiag-eval
 */

import { color } from '@wrongstack/core/utils';
import { makeProviderFromConfig } from '@wrongstack/providers';
import type { SubcommandDeps } from '../contracts.js';
import {
  type CacheProvider,
  EVAL_CATEGORIES,
  EVAL_TASKS,
  rankModels,
  roleCat,
} from './modeldiag-profiles.js';

export type ModelDiagConfig = {
  provider: string;
  model?: string;
  providers?: Record<string, import('@wrongstack/core/types').ProviderConfig>;
  modelMatrix?: Record<string, import('@wrongstack/core/types').ModelMatrixEntry>;
  apiKey?: string;
  baseUrl?: string;
};

export function createProviderForId(
  providerId: string,
  cfg: {
    providers?: Record<string, import('@wrongstack/core/types').ProviderConfig>;
    apiKey?: string;
    baseUrl?: string;
  },
): ReturnType<typeof makeProviderFromConfig> | undefined {
  const savedCfg = cfg.providers?.[providerId];
  const cfgWithType = Object.assign(
    { type: providerId },
    savedCfg ?? { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl },
  );
  try {
    return makeProviderFromConfig(providerId, cfgWithType);
  } catch {
    return undefined;
  }
}

export async function rankResponses(
  provider: ReturnType<typeof makeProviderFromConfig>,
  leaderModel: string,
  taskPrompt: string,
  responses: Array<{ model: string; text: string }>,
): Promise<number[]> {
  const labelToIdx = new Map<string, number>();
  const responseBlock = responses
    .map((r, i) => {
      const label = String.fromCharCode(65 + i);
      labelToIdx.set(label, i);
      return `=== Response ${label} ===\n${r.text.slice(0, 800)}`;
    })
    .join('\n\n');

  const rankingPrompt =
    `Rank these responses from BEST (1) to WORST.\n\nTASK:\n${taskPrompt.slice(0, 600)}\n\n` +
    `RESPONSES:\n${responseBlock}\n\n` +
    'Output ONLY a ranked list, one per line:\n1. Response X — brief reason\n2. Response Y — brief reason';

  try {
    const resp = await provider.complete(
      {
        model: leaderModel,
        system: [
          {
            type: 'text' as const,
            text: 'You are an expert evaluator. Rank responses concisely. Output ONLY the ranked list.',
          },
        ],
        messages: [{ role: 'user', content: [{ type: 'text' as const, text: rankingPrompt }] }],
        maxTokens: 400,
      },
      { signal: AbortSignal.timeout(30_000) },
    );

    const text: string =
      resp.content[0] && 'text' in resp.content[0]
        ? (resp.content[0] as { text: string }).text
        : '';
    const rankings: number[] = [];
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(\d+)[.)]\s*Response\s+([A-Z])/i);
      if (m) {
        const label = m[2]?.toUpperCase();
        const idx = label !== undefined ? labelToIdx.get(label) : undefined;
        if (idx !== undefined && !rankings.includes(idx)) {
          rankings.push(idx);
        }
      }
    }
    return rankings.length > 0 ? rankings : responses.map((_, i) => i);
  } catch {
    return responses.map((_, i) => i);
  }
}

export async function runModeldiagEval(
  args: string[],
  deps: SubcommandDeps,
  providers: CacheProvider[],
  config: ModelDiagConfig,
  hasKey: (pid: string) => boolean,
): Promise<number> {
  const writeLine = (line = '') => {
    deps.renderer.write(`${line}\n`);
  };

  const evalArgs = args.slice(1);

  const providersEq = evalArgs.find((a) => a.startsWith('--providers='));
  const providersValue =
    providersEq?.replace('--providers=', '') ??
    (typeof deps.flags?.['providers'] === 'string'
      ? deps.flags['providers']
      : typeof deps.flags?.['provider'] === 'string'
        ? deps.flags['provider']
        : undefined);
  const providerFilter = providersValue
    ? providersValue
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const maxEq = evalArgs.find((a) => a.startsWith('--max='));
  const maxValue =
    maxEq?.replace('--max=', '') ??
    (typeof deps.flags?.['max'] === 'string' ? deps.flags['max'] : undefined);
  const maxModels = maxValue ? Math.max(1, parseInt(maxValue, 10) || 2) : 2;

  const quick =
    evalArgs.includes('--quick') ||
    deps.flags?.['quick'] === true ||
    deps.flags?.['quick'] === 'true';
  const modelsPerCat = quick ? 1 : maxModels;

  const roleFilter = evalArgs.find((a) => !a.startsWith('--'));
  const targetCategories = roleFilter
    ? EVAL_CATEGORIES.includes(roleCat(roleFilter))
      ? [roleCat(roleFilter)]
      : []
    : EVAL_CATEGORIES;

  if (targetCategories.length === 0 && roleFilter) {
    writeLine(
      `${color.amber('Unknown role/category')}: "${roleFilter}". Try: ${EVAL_CATEGORIES.join(', ')}`,
    );
    return 1;
  }

  const keyedProviderIds = providers.filter((p) => hasKey(p.id)).map((p) => p.id);
  let targetProviderIds: string[];

  if (providerFilter && providerFilter.length > 0) {
    const unknown = providerFilter.filter((pid) => !keyedProviderIds.includes(pid));
    targetProviderIds = providerFilter.filter((pid) => keyedProviderIds.includes(pid));
    if (targetProviderIds.length === 0) {
      const noKeyMsg =
        unknown.length > 0
          ? `None of the specified providers (${unknown.join(', ')}) have API keys. Add keys with wstack auth.`
          : 'None of the specified providers have API keys configured.';
      writeLine(`${color.amber(noKeyMsg)}`);
      return 0;
    }
  } else if (keyedProviderIds.length === 0) {
    writeLine(`${color.amber('No providers have API keys. Add keys with wstack auth.')}`);
    return 0;
  } else if (keyedProviderIds.length === 1) {
    targetProviderIds = keyedProviderIds;
  } else {
    const providerList = keyedProviderIds
      .map((pid, i) => {
        const info = providers.find((p) => p.id === pid);
        return `  ${color.cyan(String(i + 1))}) ${color.bold(pid.padEnd(16))} ${color.dim(info?.name ?? '')}`;
      })
      .join('\n');

    deps.renderer.write(
      `\n${color.bold('Select providers to evaluate')}\n\n${providerList}\n\n${color.dim('Enter numbers or provider IDs (comma-separated, or "all"):')}\n`,
    );
    const input = await deps.reader.readLine('  > ');
    const selected = input.trim().toLowerCase();

    if (selected === '' || selected === 'all') {
      targetProviderIds = keyedProviderIds;
    } else {
      targetProviderIds = [];
      for (const part of selected.split(',').map((s) => s.trim())) {
        const idx = parseInt(part, 10);
        if (idx >= 1 && idx <= keyedProviderIds.length) {
          const pid = keyedProviderIds[idx - 1]!;
          if (!targetProviderIds.includes(pid)) targetProviderIds.push(pid);
        } else if (keyedProviderIds.includes(part)) {
          if (!targetProviderIds.includes(part)) targetProviderIds.push(part);
        }
      }
    }

    if (targetProviderIds.length === 0) {
      writeLine(color.dim('No providers selected.'));
      return 0;
    }
  }

  const leaderModel = config.model ?? 'unknown';
  const unknownProviders = providerFilter
    ? providerFilter.filter((pid) => !keyedProviderIds.includes(pid))
    : [];
  const warningLine =
    unknownProviders.length > 0
      ? `  ${color.amber('⚠ skipped (no key):')} ${unknownProviders.join(', ')}\n`
      : '';

  writeLine(`${color.bold('Model Competency Evaluation')}`);
  writeLine(
    color.dim(
      `Providers: ${targetProviderIds.join(', ')}  |  ${targetCategories.length} cats  |  ${modelsPerCat} model(s)/cat/provider`,
    ),
  );
  writeLine(warningLine);
  writeLine(color.dim(`Leader (ranker): ${config.provider}/${leaderModel}`));
  writeLine();

  type EvalResult = { model: string; latency: number; tokens: number; text: string };
  const collected = new Map<string, Map<string, EvalResult>>();
  let total = 0;
  let ok = 0;

  for (const pid of targetProviderIds) {
    const prov = createProviderForId(pid, config);
    if (!prov) {
      writeLine(color.dim(`  ⊘ ${pid}: provider unavailable, skipping`));
      continue;
    }

    for (const cat of targetCategories) {
      const task = EVAL_TASKS[cat];
      if (!task) continue;

      const candidates = rankModels(
        providers,
        (providerId) => providerId === pid && hasKey(providerId),
        cat,
        modelsPerCat,
      );
      if (candidates.length === 0) continue;

      if (!collected.has(cat)) collected.set(cat, new Map());

      for (const c of candidates) {
        total++;
        const modelKey = `${pid}/${c.model}`;
        try {
          const start = Date.now();
          const resp = await prov.complete(
            {
              model: c.model,
              system: [{ type: 'text' as const, text: 'Be thorough and correct.' }],
              messages: [{ role: 'user', content: [{ type: 'text' as const, text: task.prompt }] }],
              maxTokens: 1024,
            },
            { signal: AbortSignal.timeout(45_000) },
          );
          const respText =
            resp.content[0] && 'text' in resp.content[0]
              ? (resp.content[0] as { text: string }).text
              : '';
          const respUsage = resp.usage;
          collected.get(cat)?.set(modelKey, {
            model: modelKey,
            latency: Date.now() - start,
            tokens: (respUsage?.input ?? 0) + (respUsage?.output ?? 0),
            text: respText,
          });
          ok++;
        } catch {
          collected.get(cat)?.set(modelKey, {
            model: modelKey,
            latency: -1,
            tokens: 0,
            text: '',
          });
        }
      }
    }
  }

  writeLine(`${color.dim(`Phase 1: ${ok}/${total} calls succeeded`)}`);
  writeLine();

  if (collected.size === 0) {
    writeLine(color.amber('No responses collected. Check provider configuration.'));
    return 0;
  }

  const leaderProvider = createProviderForId(config.provider, config);
  if (leaderProvider) {
    writeLine(`${color.bold('Phase 2')} — ${color.dim('leader ranks responses')}`);
    writeLine();
  }
  const rankings = new Map<string, Map<string, { rank: number; total: number }>>();

  for (const [cat, responses] of collected) {
    const valid = Array.from(responses.values()).filter((r) => r.latency >= 0);
    if (valid.length < 2) {
      if (valid.length === 1) {
        const m = valid[0]?.model;
        if (m !== undefined) {
          if (!rankings.has(m)) rankings.set(m, new Map());
          rankings.get(m)?.set(cat, { rank: 1, total: 1 });
        }
      }
      continue;
    }
    const task = EVAL_TASKS[cat]!;
    if (leaderProvider) {
      const ranked = await rankResponses(leaderProvider, leaderModel, task.prompt, valid);
      for (let i = 0; i < valid.length; i++) {
        const m = valid[ranked[i] ?? i]?.model;
        if (m === undefined) continue;
        if (!rankings.has(m)) rankings.set(m, new Map());
        rankings.get(m)?.set(cat, { rank: i + 1, total: valid.length });
      }
    } else {
      for (const r of valid) {
        if (!rankings.has(r.model)) rankings.set(r.model, new Map());
        rankings.get(r.model)?.set(cat, { rank: 1, total: valid.length });
      }
    }
  }

  writeLine(`${color.bold('Competency Report')}`);
  writeLine();
  const allModels = [...new Set([...rankings.keys()])].sort();
  const catList = [...collected.keys()];
  const modelColWidth = Math.max(24, ...allModels.map((m) => m.length)) + 2;
  const cw = 12;

  writeLine(
    `  ${color.dim('model'.padEnd(modelColWidth))}` +
      catList
        .map((c) => color.dim((EVAL_TASKS[c]?.label ?? c).slice(0, cw).padEnd(cw + 2)))
        .join(''),
  );
  writeLine(`  ${color.dim('─'.repeat(modelColWidth + catList.length * (cw + 2)))}`);

  for (const model of allModels) {
    const mr = rankings.get(model)!;
    const provFromModel = model.split('/')[0] ?? '';
    const modelColor = provFromModel === config.provider ? color.cyan : color.green;
    let row = `  ${modelColor(model.padEnd(modelColWidth))}`;
    for (const cat of catList) {
      const e = mr.get(cat);
      if (e) {
        const pct = Math.round((1 - (e.rank - 1) / Math.max(1, e.total - 1)) * 100);
        const pc = pct >= 80 ? color.green : pct >= 50 ? color.amber : color.red;
        row += `${pc(`#${e.rank} ${pct}%`.padEnd(cw + 2))}`;
      } else {
        row += color.dim('—'.padEnd(cw + 2));
      }
    }
    writeLine(row);
  }

  writeLine();
  writeLine(color.dim('#1 100% = best in category. — = not tested.'));
  writeLine();
  writeLine(color.dim('Pin: wstack setmodel set <role> <provider>/<model>'));
  writeLine(
    color.dim(
      'Full: wstack modeldiag eval          Providers: wstack modeldiag eval --providers=id1,id2',
    ),
  );
  writeLine(
    color.dim('Max:  wstack modeldiag eval --max=3   Quick: wstack modeldiag eval --quick'),
  );
  return 0;
}
