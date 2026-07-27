import * as fs from 'node:fs/promises';
import { color } from '@wrongstack/core/utils';
import type { Config, ModelMatrixEntry, ProviderConfig } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { makeProviderFromConfig, setOAuthTokenPersister } from '@wrongstack/providers';
import type { DefaultModelsRegistry } from '@wrongstack/core/models';
import type { SubcommandHandler } from '../index.js';
import { discoverAndMergeProviders } from '../../boot/auto-discover-providers.js';
import { mutateConfigProviders, normalizeKeys, writeKeysBack } from '../../provider-config-utils.js';
import { activeProfileConfigPath } from '../../profile-config-path.js';
import {
  buildModelSmokeTargets,
  parseModelSmokeOptions,
  runModelSmokeTests,
  type ModelSmokeResult,
} from './model-smoke-test.js';

/**
 * `wrongstack modeldiag` — read-only diagnostics: key check, capability scan,
 * heuristic suggestions, and real model benchmarking. Never modifies config.
 *
 * Ported from the now-removed /modeldiag slash command.
 */

// ---------------------------------------------------------------------------
// Model profiles (inlined to avoid cross-package build dependency)
// ---------------------------------------------------------------------------

import {
  checkMark,
  costLabel,
  EVAL_CATEGORIES,
  EVAL_TASKS,
  findProfile,
  fmtMs,
  fmtPrice,
  fmtTokens,
  rankModels,
  roleCat,
  scoreBar,
  speedLabel,
  type CacheModel,
  type CacheProvider,
} from './modeldiag-profiles.js';

function createProviderForId(
  providerId: string,
  cfg: { providers?: Record<string, ProviderConfig>; apiKey?: string; baseUrl?: string },
): ReturnType<typeof makeProviderFromConfig> | undefined {
  const savedCfg = cfg.providers?.[providerId];
  // Match the startup path (packages/cli/src/wiring/provider.ts:82): keep
  // `cfg.type === providerId` so the resulting Provider's `id` is the user's
  // chosen id. The wire family is read from `savedCfg.family` inside
  // `makeProviderFromConfig`, so OAuth/subscription aliases (e.g.
  // `minimax-coding-plan` with `type: 'anthropic'`) get the right protocol
  // without their saved `type` leaking into the Provider's id.
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

// ---------------------------------------------------------------------------
// Leader ranking
// ---------------------------------------------------------------------------

async function rankResponses(
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

// ---------------------------------------------------------------------------
// Cache parsing
// ---------------------------------------------------------------------------

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

type ModelDiagConfig = {
  provider: string;
  model?: string;
  providers?: Record<string, ProviderConfig>;
  modelMatrix?: Record<string, ModelMatrixEntry>;
  apiKey?: string;
  baseUrl?: string;
};

function checkHasKey(pid: string, config: ModelDiagConfig): boolean {
  if (pid === config.provider && config.provider) return true;
  const pc = config.providers?.[pid];
  if (!pc) return false;
  if (typeof pc.apiKey === 'string' && pc.apiKey.length > 0) return true;
  if (Array.isArray(pc.apiKeys) && pc.apiKeys.some((k) => k?.apiKey)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export const modeldiagCmd: SubcommandHandler = async (args, deps) => {
  const sub = args[0]?.toLowerCase() || 'full';

  // --------------- load cache ---------------
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

  // ── keys ──
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

  // ── caps ──
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

  // ── suggest (also called from 'full') ──
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

  // ── suggest subcommand ──
  if (sub === 'suggest') {
    await renderSuggest();
    writeLine();
    writeLine(color.dim('Pin a suggestion:  wstack setmodel set <role> <provider>/<model>'));
    writeLine(color.dim('Test candidates:   wstack modeldiag bench <role> "<test prompt>"'));
    return 0;
  }

  // ── test ──
  if (sub === 'test') {
    if (args.slice(1).includes('--help') || deps.flags?.['help'] === true) {
      writeLine(`${color.bold('Usage:')} wstack modeldiag test [options]`);
      writeLine();
      writeLine('  (no flags)              Probe one representative model per configured provider');
      writeLine('  --all-models             Probe every catalog-visible model sequentially');
      writeLine('  --plan                   Show targets without making model calls');
      writeLine('  --provider=<id,...>      Restrict provider ids');
      writeLine('  --model=<id,...>         Restrict model ids');
      writeLine('  --timeout=<ms>           Per-model timeout (default 45000)');
      writeLine('  --max-tokens=<n>         Output cap for the tiny probe (default 32)');
      writeLine('  --json                   Emit machine-readable output');
      writeLine('  --yes                    Confirm a run larger than 50 requests');
      return 0;
    }
    let smokeOptions;
    try {
      smokeOptions = parseModelSmokeOptions(args.slice(1), deps.flags);
    } catch (err) {
      writeLine(`${color.red('Invalid smoke-test options:')} ${toErrorMessage(err)}`);
      return 2;
    }

    if ('mergeOverlay' in deps.modelsRegistry) {
      await discoverAndMergeProviders({
        config: config as Config,
        registry: deps.modelsRegistry as DefaultModelsRegistry,
        cacheDir: deps.paths.cacheDir,
      });
    }
    const targets = await buildModelSmokeTargets(config as Config, deps.modelsRegistry, smokeOptions);
    const byProvider = new Map<string, number>();
    for (const target of targets) {
      byProvider.set(target.providerId, (byProvider.get(target.providerId) ?? 0) + 1);
    }

    if (smokeOptions.planOnly) {
      const plan = {
        mode: smokeOptions.allModels ? 'all-models' : 'representative',
        targetCount: targets.length,
        providers: Object.fromEntries(byProvider),
        targets,
      };
      if (smokeOptions.json) {
        writeLine(JSON.stringify(plan, null, 2));
      } else {
        writeLine(`${color.bold('Provider/Model Smoke Test Plan')}`);
        writeLine();
        for (const [providerId, count] of byProvider) {
          writeLine(`  ${color.cyan(providerId.padEnd(24))} ${count} model(s)`);
        }
        writeLine();
        writeLine(
          color.dim(
            `${targets.length} request(s) would run sequentially. Remove --plan to execute.`,
          ),
        );
      }
      return targets.length > 0 ? 0 : 2;
    }

    if (targets.length === 0) {
      const message =
        'No provider/model targets matched. Check the active profile or remove filters.';
      if (smokeOptions.json) {
        writeLine(JSON.stringify({ results: [], summary: { passed: 0, failed: 0 }, error: message }));
      } else {
        writeLine(color.amber(message));
      }
      return 2;
    }

    const confirmed =
      deps.flags?.['yes'] === true ||
      deps.flags?.['yes'] === 'true' ||
      args.slice(1).includes('--yes');
    if (targets.length > 50 && !confirmed) {
      const message =
        `${targets.length} live requests are planned. Review with --plan, then add --yes to run them.`;
      if (smokeOptions.json) {
        writeLine(JSON.stringify({ error: message, targetCount: targets.length }));
      } else {
        writeLine(color.amber(message));
      }
      return 2;
    }

    if (!smokeOptions.json) {
      writeLine(`${color.bold('Live Provider/Model Smoke Test')}`);
      writeLine(
        color.dim(
          `${targets.length} request(s), sequential, ${smokeOptions.timeoutMs}ms timeout, max ${smokeOptions.maxTokens} output tokens.`,
        ),
      );
      writeLine();
    }

    const resultLines = (result: ModelSmokeResult, index: number, total: number): void => {
      if (smokeOptions.json) return;
      const label = `[${String(index + 1).padStart(String(total).length)}/${total}]`;
      const target = `${result.providerId}/${result.modelId}`;
      if (result.status === 'passed') {
        writeLine(
          `  ${color.green('✓')} ${color.dim(label)} ${color.cyan(target)} ${color.dim(
            `${fmtMs(result.latencyMs)} · in${result.usage.input}/out${result.usage.output} · ${result.stopReason}`,
          )}`,
        );
      } else {
        const status = result.httpStatus ? `HTTP ${result.httpStatus} · ` : '';
        writeLine(
          `  ${color.red('✗')} ${color.dim(label)} ${color.red(target)} ${color.dim(
            `${fmtMs(result.latencyMs)} · ${status}${result.errorKind}`,
          )}`,
        );
        writeLine(`      ${color.red(result.error.slice(0, 240))}`);
      }
    };

    let oauthWriteChain = Promise.resolve();
    let oauthWriteScheduled = false;
    const profilePath = activeProfileConfigPath(deps.paths, config as Config);
    setOAuthTokenPersister((providerId, credentials) => {
      oauthWriteScheduled = true;
      oauthWriteChain = oauthWriteChain.then(() =>
        mutateConfigProviders(profilePath, deps.vault, (all) => {
          const providerConfig = all[providerId];
          if (!providerConfig) return;
          const keys = normalizeKeys(providerConfig);
          const active = providerConfig.activeKey
            ? keys.find((key) => key.label === providerConfig.activeKey)
            : keys[0];
          if (!active) return;
          active.apiKey = credentials.accessToken;
          active.refreshToken = credentials.refreshToken;
          active.expiresAt = new Date(credentials.expiresAt).toISOString();
          if (credentials.accountId) active.accountId = credentials.accountId;
          writeKeysBack(providerConfig, keys);
        }),
      );
    });

    let results;
    try {
      results = await runModelSmokeTests({
        targets,
        options: smokeOptions,
        createProvider: async (providerId) => {
          const saved = config.providers?.[providerId];
          const resolved =
            (await deps.modelsRegistry.getProvider(providerId).catch(() => undefined)) ??
            (saved?.type && saved.type !== providerId
              ? await deps.modelsRegistry.getProvider(saved.type).catch(() => undefined)
              : undefined);
          const providerConfig: ProviderConfig = {
            ...(providerId === config.provider
              ? {
                  ...(config.apiKey ? { apiKey: config.apiKey } : {}),
                  ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
                }
              : {}),
            ...saved,
            type: providerId,
            ...(saved?.family ?? resolved?.family
              ? { family: saved?.family ?? resolved?.family }
              : {}),
            ...(saved?.baseUrl ?? resolved?.apiBase
              ? { baseUrl: saved?.baseUrl ?? resolved?.apiBase }
              : {}),
            ...(saved?.envVars ?? resolved?.envVars
              ? { envVars: saved?.envVars ?? resolved?.envVars }
              : {}),
          };
          return makeProviderFromConfig(providerId, providerConfig);
        },
        onTargetComplete: resultLines,
      });
    } finally {
      setOAuthTokenPersister(undefined);
    }
    let oauthPersistenceError: string | undefined;
    if (oauthWriteScheduled) {
      try {
        await oauthWriteChain;
      } catch (err) {
        oauthPersistenceError = toErrorMessage(err);
      }
    }
    const passed = results.filter((result) => result.status === 'passed').length;
    const failed = results.length - passed;
    const summary = { passed, failed, total: results.length };

    if (smokeOptions.json) {
      writeLine(
        JSON.stringify(
          {
            results,
            summary,
            ...(oauthPersistenceError
              ? { warning: `OAuth token refresh worked in-memory but could not be saved: ${oauthPersistenceError}` }
              : {}),
          },
          null,
          2,
        ),
      );
    } else {
      writeLine();
      writeLine(
        `${color.bold('Summary:')} ${color.green(`${passed} passed`)} · ${
          failed > 0 ? color.red(`${failed} failed`) : color.dim('0 failed')
        }`,
      );
      if (!smokeOptions.allModels) {
        writeLine(
          color.dim('Use --all-models to test every catalog-visible model sequentially.'),
        );
      }
      if (oauthPersistenceError) {
        writeLine(
          color.amber(
            `OAuth token refresh worked in-memory but could not be saved: ${oauthPersistenceError}`,
          ),
        );
      }
    }
    return failed === 0 ? 0 : 1;
  }

  // ── bench <role> <prompt> [--providers p1,p2] ──
  if (sub === 'bench') {
    const benchArgs = args.slice(1);
    if (benchArgs.length < 2) {
      writeLine(
        `${color.amber('Usage:')} wstack modeldiag bench <role> "<test prompt>" [--providers=p1,p2]`,
      );
      writeLine();
      writeLine(
        color.dim(
          'Example: wstack modeldiag bench verify "Write a function that checks if a string is a palindrome"',
        ),
      );
      writeLine(
        color.dim(
          'Tests the top 5 candidate models for the role with your prompt and reports results.',
        ),
      );
      writeLine(color.dim('Add --providers=anthropic,google to test across multiple providers.'));
      return 0;
    }

    const providersEqIdx = benchArgs.findIndex((a) => a.startsWith('--providers='));
    let providerFilter: string[] | undefined;
    if (providersEqIdx >= 0) {
      const rawFilter = benchArgs[providersEqIdx]?.replace('--providers=', '').split(',');
      if (rawFilter) {
        providerFilter = rawFilter.map((s) => s.trim()).filter(Boolean);
        benchArgs.splice(providersEqIdx, 1);
      }
    } else {
      const rawFilter = deps.flags?.['providers'] ?? deps.flags?.['provider'];
      if (typeof rawFilter === 'string') {
        providerFilter = rawFilter
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }

    const benchRole = benchArgs[0];
    if (!benchRole) {
      writeLine(
        `${color.amber('No benchmark role specified')}. Usage: wstack diag bench <role> [prompt]`,
      );
      return 1;
    }
    const benchPrompt = benchArgs.slice(1).join(' ');

    const cat = roleCat(benchRole);
    const candidates = rankModels(providers, hasKey, cat, 5);

    if (candidates.length === 0) {
      writeLine(
        `${color.amber('No candidate models found')} for role "${benchRole}" (category: ${cat}).`,
      );
      return 0;
    }

    let targetCandidates: typeof candidates;
    if (providerFilter && providerFilter.length > 0) {
      targetCandidates = candidates.filter((c) => providerFilter.includes(c.provider));
      if (targetCandidates.length === 0) {
        writeLine(
          `${color.amber('No candidates match the specified providers')}: ${providerFilter.join(', ')}`,
        );
        writeLine(
          `Candidate providers: ${[...new Set(candidates.map((c) => c.provider))].join(', ')}`,
        );
        return 0;
      }
    } else {
      targetCandidates = candidates;
    }

    writeLine(
      `${color.bold('Model Benchmark')} — ${color.amber(benchRole)} ${color.dim(`(category: ${cat})`)}`,
    );
    writeLine(
      `${color.dim('Prompt:')} "${benchPrompt.slice(0, 120)}${benchPrompt.length > 120 ? '…' : ''}"`,
    );
    writeLine();

    writeLine(
      `  ${color.dim('#  model'.padEnd(52))} ${color.dim('score'.padEnd(12))} ${color.dim('latency'.padEnd(10))} ${color.dim('tokens'.padEnd(14))} ${color.dim('first line')}`,
    );
    writeLine(`  ${color.dim('─'.repeat(108))}`);

    const providerInstances = new Map<string, ReturnType<typeof makeProviderFromConfig>>();
    for (const pid of [...new Set(targetCandidates.map((c) => c.provider))]) {
      const prov = createProviderForId(pid, config);
      if (prov) providerInstances.set(pid, prov);
    }

    let idx = 0;
    for (const c of targetCandidates.slice(0, 20)) {
      idx++;
      const label = `${idx}`.padStart(2);
      const modelKey = `${c.provider}/${c.model}`;
      const prov = providerInstances.get(c.provider);

      if (!prov) {
        writeLine(
          `  ${label} ${color.red(modelKey.padEnd(50))} ${scoreBar(c.score, 110).slice(0, 11)}  ${color.red('NO PROVIDER')}`,
        );
        continue;
      }

      try {
        const start = Date.now();
        const resp = await prov.complete(
          {
            model: c.model,
            messages: [{ role: 'user', content: [{ type: 'text' as const, text: benchPrompt }] }],
            maxTokens: 256,
          },
          { signal: AbortSignal.timeout(30_000) },
        );
        const latency = Date.now() - start;
        const firstText: string =
          resp.content[0] && 'text' in resp.content[0]
            ? (resp.content[0] as { text: string }).text
            : '';
        const firstLineClean = firstText.replace(/\n/g, ' ').slice(0, 80) || color.dim('(empty)');

        const provColor = c.provider === config.provider ? color.green : color.cyan;
        const usage = resp.usage;
        writeLine(
          `  ${label} ${provColor(modelKey.padEnd(50))} ${scoreBar(c.score, 110).slice(0, 11)}  ${color.amber(fmtMs(latency).padEnd(8))} ${color.dim(`in${usage?.input ?? '?'}/out${usage?.output ?? '?'}`.padEnd(12))} ${firstLineClean}`,
        );
      } catch (err) {
        const errMsg = toErrorMessage(err);
        writeLine(
          `  ${label} ${color.red(modelKey.padEnd(50))} ${scoreBar(c.score, 110).slice(0, 11)}  ${color.red('FAILED')}    ${color.dim(errMsg.slice(0, 40))}`,
        );
      }
    }

    const testedProviders = [...new Set(targetCandidates.map((c) => c.provider))];
    writeLine();
    writeLine(
      color.dim(
        `Tested ${idx} model(s) across ${testedProviders.length} provider(s): ${testedProviders.join(', ')}.`,
      ),
    );
    writeLine(color.dim('Pin the best: wstack setmodel set <role> <provider>/<model>'));
    return 0;
  }

  // ── eval [categories] [--providers p1,p2] [--max N] [--quick] ──
  if (sub === 'eval' || sub === 'evall') {
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
      // Interactive: ask user to select providers
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

    // Build header
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

    // Phase 1: collect responses from all providers
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
                messages: [
                  { role: 'user', content: [{ type: 'text' as const, text: task.prompt }] },
                ],
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

    // Phase 2: leader ranking
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

    // Phase 3: report matrix
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

  // ── full (default) ──
  // keys
  writeLine(`${color.bold('API Key Status')}`);
  writeLine();
  for (const prov of providers) {
    const k = hasKey(prov.id);
    writeLine(`  ${checkMark(k)} ${color.bold(prov.id.padEnd(18))} ${color.dim(prov.name)}`);
  }
  writeLine();
  writeLine(`${color.dim(`Leader: ${config.provider}/${config.model}`)}`);

  // caps
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

  // suggest
  await renderSuggest();
  writeLine();
  writeLine(color.dim('Pin a suggestion:  wstack setmodel set <role> <provider>/<model>'));
  writeLine(color.dim('Test candidates:   wstack modeldiag bench <role> "<test prompt>"'));
  return 0;
};
