import { color } from '@wrongstack/core/utils';

export interface ModelProfile {
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

export const MODEL_PROFILES: ModelProfile[] = [
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

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function fmtPrice(usdPer1M: number | undefined): string {
  if (usdPer1M === undefined) return color.dim('?');
  if (usdPer1M >= 10) return `$${usdPer1M.toFixed(1)}`;
  return `$${usdPer1M.toFixed(2)}`;
}

export function checkMark(ok: boolean): string {
  return ok ? color.green('✓') : color.red('✗');
}

export function costLabel(tier: string): string {
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

export function speedLabel(tier: string): string {
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

export function scoreBar(score: number, max: number): string {
  const pct = Math.min(1, Math.max(0, score / max));
  const filled = Math.round(pct * 10);
  const bar = color.green('█'.repeat(filled)) + color.dim('░'.repeat(10 - filled));
  return `${bar} ${score}/${max}`;
}

export interface CacheModel {
  id: string;
  name?: string | undefined;
  capabilities?:
    | { contextWindow?: number | undefined; maxOutputTokens?: number | undefined }
    | undefined;
  pricing?: { input?: number; output?: number } | undefined;
}

export interface CacheProvider {
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

export const ROLE_CATEGORY: Record<string, string> = {
  'security-scanner': 'security',
  'security-reviewer': 'security',
  'bug-hunter': 'debugging',
  debugger: 'debugging',
  tracer: 'debugging',
  planner: 'planning',
  architect: 'planning',
  'refactor-planner': 'planning',
  verifier: 'testing',
  test: 'testing',
  e2e: 'testing',
  document: 'docs',
  simplifier: 'docs',
  'code-reviewer': 'review',
  reviewer: 'review',
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

export function findProfile(pid: string, mid: string): ModelProfile | undefined {
  for (const p of MODEL_PROFILES) {
    if (p.provider === pid && p.pattern.test(mid)) return p;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Candidate scoring
// ---------------------------------------------------------------------------

export function scoreModel(
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

export function rankModels(
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

export const EVAL_TASKS: Record<string, EvalTask> = {
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

export const EVAL_CATEGORIES = Object.keys(EVAL_TASKS);

export function roleCat(role: string): string {
  return ROLE_CATEGORY[role] ?? 'general';
}

// ---------------------------------------------------------------------------
// Provider construction
// ---------------------------------------------------------------------------
