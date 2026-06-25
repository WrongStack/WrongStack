import * as fs from 'node:fs/promises';
import { color, type ModelMatrixEntry, type ProviderConfig } from '@wrongstack/core';
import { makeProviderFromConfig } from '@wrongstack/providers';
import type { SubcommandHandler } from '../index.js';
import { toErrorMessage } from '@wrongstack/core/utils';

/**
 * `wrongstack modeldiag` — read-only diagnostics: key check, capability scan,
 * heuristic suggestions, and real model benchmarking. Never modifies config.
 *
 * Ported from the now-removed /modeldiag slash command.
 */

// ---------------------------------------------------------------------------
// Model profiles (inlined to avoid cross-package build dependency)
// ---------------------------------------------------------------------------

interface ModelProfile {
  provider: string;
  pattern: RegExp;
  family: string;
  strengths: string[];
  weaknesses?: string[];
  bestFor: string[];
  avoidFor?: string[];
  costTier: 'budget' | 'standard' | 'premium';
  speedTier: 'fast' | 'normal' | 'slow';
  minContext?: number;
}

const MODEL_PROFILES: ModelProfile[] = [
  {
    provider: 'anthropic',
    pattern: /claude-opus/i,
    family: 'Claude Opus',
    strengths: ['reasoning', 'planning'],
    bestFor: ['planning', 'security', 'debugging'],
    costTier: 'premium',
    speedTier: 'slow',
  },
  {
    provider: 'anthropic',
    pattern: /claude-sonnet/i,
    family: 'Claude Sonnet',
    strengths: ['coding', 'balanced'],
    bestFor: ['coding', 'general'],
    costTier: 'standard',
    speedTier: 'fast',
  },
  {
    provider: 'anthropic',
    pattern: /claude-haiku/i,
    family: 'Claude Haiku',
    strengths: ['speed'],
    bestFor: ['lightweight', 'docs'],
    avoidFor: ['planning'],
    costTier: 'budget',
    speedTier: 'fast',
  },
  {
    provider: 'openai',
    pattern: /gpt-5|o3|o4/i,
    family: 'GPT-5/o3/o4',
    strengths: ['reasoning', 'coding'],
    bestFor: ['planning', 'coding', 'debugging'],
    costTier: 'premium',
    speedTier: 'normal',
  },
  {
    provider: 'openai',
    pattern: /gpt-4/i,
    family: 'GPT-4',
    strengths: ['coding'],
    bestFor: ['coding', 'docs'],
    costTier: 'standard',
    speedTier: 'fast',
  },
  {
    provider: 'openai',
    pattern: /gpt-4o-mini/i,
    family: 'GPT-4o Mini',
    strengths: ['speed'],
    bestFor: ['lightweight', 'docs'],
    avoidFor: ['planning'],
    costTier: 'budget',
    speedTier: 'fast',
  },
  {
    provider: 'google',
    pattern: /gemini-(?:2\.5|3)/i,
    family: 'Gemini 2.5/3',
    strengths: ['context', 'coding'],
    bestFor: ['coding', 'data'],
    costTier: 'standard',
    speedTier: 'normal',
  },
  {
    provider: 'google',
    pattern: /gemini.*flash/i,
    family: 'Gemini Flash',
    strengths: ['speed'],
    bestFor: ['lightweight', 'docs'],
    avoidFor: ['planning'],
    costTier: 'budget',
    speedTier: 'fast',
  },
  {
    provider: 'deepseek',
    pattern: /deepseek/i,
    family: 'DeepSeek',
    strengths: ['coding', 'cost-effective'],
    bestFor: ['coding', 'general'],
    costTier: 'standard',
    speedTier: 'normal',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function fmtPrice(usdPer1M: number | undefined): string {
  if (usdPer1M === undefined) return color.dim('?');
  if (usdPer1M >= 10) return `$${usdPer1M.toFixed(1)}`;
  return `$${usdPer1M.toFixed(2)}`;
}

function checkMark(ok: boolean): string {
  return ok ? color.green('✓') : color.red('✗');
}

function costLabel(tier: string): string {
  switch (tier) {
    case 'premium':
      return color.red('$$$');
    case 'standard':
      return color.amber('$$');
    case 'budget':
      return color.green('$');
    default:
      return color.dim('?');
  }
}

function speedLabel(tier: string): string {
  switch (tier) {
    case 'fast':
      return color.green('⚡');
    case 'normal':
      return color.amber('→');
    case 'slow':
      return color.red('🐢');
    default:
      return color.dim('?');
  }
}

function scoreBar(score: number, max: number): string {
  const pct = Math.min(1, Math.max(0, score / max));
  const filled = Math.round(pct * 10);
  const bar = color.green('█'.repeat(filled)) + color.dim('░'.repeat(10 - filled));
  return `${bar} ${score}/${max}`;
}

interface CacheModel {
  id: string;
  name?: string | undefined;
  capabilities?:
    | { contextWindow?: number | undefined; maxOutputTokens?: number | undefined }
    | undefined;
  pricing?: { input?: number; output?: number } | undefined;
}

interface CacheProvider {
  id: string;
  name: string;
  family: string;
  models?: CacheModel[];
}

interface ScoredModel {
  provider: string;
  model: string;
  profile?: ModelProfile | undefined;
  score: number;
  ctxWindow: number;
  maxOutput: number;
  inputPrice?: number | undefined;
  outputPrice?: number | undefined;
}

const ROLE_CATEGORY: Record<string, string> = {
  'security-scanner': 'security',
  'security-reviewer': 'security',
  'bug-hunter': 'debugging',
  debugger: 'debugging',
  tracer: 'debugging',
  planner: 'planning',
  architect: 'planning',
  'refactor-planner': 'planning',
  test: 'testing',
  e2e: 'testing',
  document: 'docs',
  simplifier: 'docs',
  'code-reviewer': 'review',
  critic: 'review',
  executor: 'coding',
  refactor: 'refactoring',
  migration: 'coding',
  frontend: 'frontend',
  backend: 'backend',
  api: 'backend',
  auth: 'backend',
  designer: 'frontend',
  analyst: 'data',
  data: 'data',
  database: 'data',
  explore: 'planning',
  search: 'planning',
  researcher: 'planning',
};

function findProfile(pid: string, mid: string): ModelProfile | undefined {
  for (const p of MODEL_PROFILES) {
    if (p.provider === pid && p.pattern.test(mid)) return p;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Candidate scoring
// ---------------------------------------------------------------------------

function scoreModel(
  pid: string,
  mid: string,
  category: string,
  ctxWindow: number,
): { score: number; profile?: ModelProfile | undefined } {
  const profile = findProfile(pid, mid);
  let score = 50;

  if (profile) {
    if (profile.bestFor.includes(category as never)) score += 35;
    if (profile.avoidFor?.includes(category as never)) score -= 50;
    if (category === 'planning' && profile.costTier === 'premium') score += 15;
    if (profile.speedTier === 'slow' && category === 'planning') score += 10;
    if (profile.costTier === 'budget' && category !== 'planning' && category !== 'security')
      score += 10;
  }

  if (ctxWindow > 200_000) score += 10;
  else if (ctxWindow > 100_000) score += 5;
  else if (ctxWindow > 32_000) score += 2;

  return { score, profile };
}

function rankModels(
  providers: CacheProvider[],
  hasKey: (pid: string) => boolean,
  category: string,
  limit: number,
): ScoredModel[] {
  const candidates: ScoredModel[] = [];

  for (const prov of providers) {
    if (!hasKey(prov.id)) continue;
    for (const m of prov.models ?? []) {
      const ctxWindow = m.capabilities?.contextWindow ?? 0;
      const { score, profile } = scoreModel(prov.id, m.id, category, ctxWindow);
      if (score > 0) {
        candidates.push({
          provider: prov.id,
          model: m.id,
          profile,
          score,
          ctxWindow,
          maxOutput: m.capabilities?.maxOutputTokens ?? 0,
          inputPrice: m.pricing?.input,
          outputPrice: m.pricing?.output,
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Standardized evaluation prompts
// ---------------------------------------------------------------------------

interface EvalTask {
  label: string;
  prompt: string;
}

const EVAL_TASKS: Record<string, EvalTask> = {
  coding: {
    label: 'Code Generation',
    prompt:
      'Write a TypeScript function parseCSV(input: string): { headers: string[]; rows: string[][] } that handles quoted fields, escaped quotes, and empty lines. Return an error string on malformed input. Keep under 40 lines.',
  },
  planning: {
    label: 'Architecture Planning',
    prompt:
      'Design the folder structure and key interfaces for a monorepo CLI tool with slash commands, model routing, subagent spawning, and config persistence. List packages, their responsibilities, and the 5 most important TypeScript interfaces.',
  },
  security: {
    label: 'Vulnerability Detection',
    prompt:
      'Review this code for security issues:\n```ts\napp.get("/api/user", (req, res) => {\n  const id = req.query.id;\n  const user = db.query("SELECT * FROM users WHERE id = " + id);\n  res.json(user);\n});\n\napp.post("/api/run", (req, res) => {\n  const { cmd } = req.body;\n  exec("echo " + cmd, (err, stdout) => res.send(stdout));\n});\n```\nList every vulnerability, its severity (critical/high/medium), and the exact fix.',
  },
  debugging: {
    label: 'Bug Diagnosis',
    prompt:
      'This async function has 2 bugs. Find and fix both:\n```ts\nasync function processBatch(items: string[]) {\n  const results = [];\n  for (const item of items) {\n    const result = await fetch("https://api.example.com/" + item);\n    results.push(result);\n  }\n  return results.map(r => r.json());\n}\n```\nExplain what each bug is, why it fails, and write the corrected version.',
  },
  testing: {
    label: 'Test Authoring',
    prompt:
      'Write vitest test cases for this deepMerge function:\n```ts\nfunction deepMerge(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {\n  const merged = { ...base };\n  for (const [key, val] of Object.entries(overrides)) {\n    if (val === null) { delete merged[key]; continue; }\n    if (typeof val === "object" && !Array.isArray(val) && typeof merged[key] === "object" && !Array.isArray(merged[key])) {\n      merged[key] = deepMerge(merged[key] as Record<string, unknown>, val as Record<string, unknown>);\n    } else { merged[key] = val; }\n  }\n  return merged;\n}\n```\nCover: happy path, edge cases, and error conditions.',
  },
  docs: {
    label: 'Documentation',
    prompt:
      'Write TSDoc comments for this RateLimiter interface. Include @param, @returns, @throws, and @example for each method:\n```ts\ninterface RateLimiter {\n  tryAcquire(key: string, maxPerWindow: number, windowMs: number): Promise<boolean>;\n  getRemaining(key: string): Promise<number>;\n  reset(key: string): Promise<void>;\n}\n```',
  },
  review: {
    label: 'Code Review',
    prompt:
      'Review this PR change:\n```diff\n async function loadConfig(path: string) {\n-  const raw = await fs.readFile(path, "utf8");\n-  return JSON.parse(raw);\n+  const raw = await fs.readFile(path);\n+  const config = JSON.parse(raw);\n+  process.env.API_KEY = config.apiKey;\n+  return config;\n }\n```\nList issues by severity (blocking / should-fix / nit) and explain your reasoning.',
  },
  refactoring: {
    label: 'Refactoring',
    prompt:
      'Refactor this nested condition into a cleaner pattern:\n```ts\nfunction getDiscount(user: { type: string; years: number; coupon?: string }): number {\n  if (user.type === "premium") {\n    if (user.years > 5) {\n      if (user.coupon === "BLACKFRIDAY") return 0.5;\n      return 0.3;\n    }\n    return 0.2;\n  }\n  if (user.type === "standard") {\n    if (user.years > 3) return 0.15;\n    return 0.1;\n  }\n  return 0;\n}\n```\nShow your refactored code and explain why your approach is cleaner.',
  },
};

const EVAL_CATEGORIES = Object.keys(EVAL_TASKS);

function roleCat(role: string): string {
  return ROLE_CATEGORY[role] ?? 'general';
}

// ---------------------------------------------------------------------------
// Provider construction
// ---------------------------------------------------------------------------

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
        'test',
        'document',
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

        if (ranked.length > 1 && (ranked[1]?.score ?? Number.NEGATIVE_INFINITY) >= best.score - 15) {
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
    writeLine(`${color.bold('Connectivity Test')}`);
    writeLine();
    const keyed = providers.filter((p) => hasKey(p.id));
    if (keyed.length === 0) {
      writeLine(`  ${color.amber('No providers have API keys. Add keys with wstack auth.')}`);
      return 0;
    }

    for (const prov of keyed) {
      writeLine(
        `  ${color.cyan('⟳')} ${prov.id}... ${color.dim('(capability scan, no API call)')}`,
      );

      const profile = findProfile(prov.id, config.model ?? '');
      const firstModel = prov.models?.[0]?.id ?? config.model ?? '?';
      const cap = prov.models?.[0]?.capabilities;
      const ctx = cap?.contextWindow ?? 0;

      writeLine(`    ${checkMark(true)} provider: ${prov.id}`);
      writeLine(`    ${checkMark(ctx > 0)} context: ${ctx > 0 ? fmtTokens(ctx) : 'unknown'}`);
      writeLine(`    ${checkMark(!!profile)} profile: ${profile?.family ?? 'no match'}`);
      writeLine(`    model: ${color.cyan(firstModel)}`);
      writeLine();
    }

    writeLine(color.dim('Full API connectivity test requires an active session (costs tokens).'));
    writeLine(
      color.dim('Use wstack modeldiag bench <role> "<prompt>" to test models with real API calls.'),
    );
    return 0;
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
    const providerFilter = providersEq
      ? providersEq
          .replace('--providers=', '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    const maxEq = evalArgs.find((a) => a.startsWith('--max='));
    const maxModels = maxEq ? Math.max(1, parseInt(maxEq.replace('--max=', ''), 10) || 2) : 2;

    const quick = evalArgs.includes('--quick');
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

        const candidates = rankModels(providers, hasKey, cat, modelsPerCat).filter(
          (c) => c.provider === pid,
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
