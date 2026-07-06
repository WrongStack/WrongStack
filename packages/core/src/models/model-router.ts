/**
 * ModelRouter — intelligent model selection for subagent delegation.
 *
 * Combines:
 *   1. User-configured model matrix (/setmodel overrides)
 *   2. Model intelligence profiles (strengths/weaknesses per model family)
 *   3. Provider availability (which models have API keys configured)
 *   4. Per-model cost tracking
 *
 * Usage:
 *   const router = new ModelRouter({ matrix, config, profiles: MODEL_PROFILES });
 *   const pick = router.pickForTask('security-scanner', 'Audit the auth module');
 *   // → { provider: 'anthropic', model: 'matched-model', reason: 'best-for security' }
 */

import type { ModelMatrixEntry, ProviderConfig } from '../types/config.js';

export interface ModelIntelligenceEntry {
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

export interface RouterConfig {
  /** User-configured model matrix (from /setmodel). */
  matrix?: Record<string, ModelMatrixEntry> | undefined;
  /** Provider configurations (to check API key availability). */
  config: {
    provider: string;
    model: string;
    providers?: Record<string, ProviderConfig>;
  };
  /** Known model intelligence profiles. */
  profiles?: ModelIntelligenceEntry[] | undefined;
}

export interface ModelPick {
  provider: string;
  model: string;
  /** Why this model was chosen. */
  reason: string;
  /** Whether this came from the user's matrix (true) or auto-detected (false). */
  fromMatrix: boolean;
}

export interface RouterCosts {
  /** Cumulative cost per provider/model key. */
  byModel: Record<
    string,
    { cost: number; tokens: { input: number; output: number }; calls: number }
  >;
  /** Grand total. */
  totalCost: number;
}

/**
 * Default profiles used when none are provided. Kept inline so the router
 * is self-contained — callers can override with richer data from model-intelligence.
 */
const DEFAULT_PROFILES: ModelIntelligenceEntry[] = [
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

/** Map common task keywords to categories for model matching. */
const TASK_CATEGORIES: Record<string, string> = {
  plan: 'planning',
  architect: 'planning',
  design: 'planning',
  strategy: 'planning',
  security: 'security',
  vuln: 'security',
  exploit: 'security',
  auth: 'security',
  doc: 'docs',
  readme: 'docs',
  explain: 'docs',
  write: 'docs',
  test: 'testing',
  spec: 'testing',
  assert: 'testing',
  coverage: 'testing',
  refactor: 'refactoring',
  cleanup: 'refactoring',
  restructure: 'refactoring',
  bug: 'debugging',
  fix: 'debugging',
  debug: 'debugging',
  trace: 'debugging',
  crash: 'debugging',
  data: 'data',
  json: 'data',
  sql: 'data',
  query: 'data',
  analyze: 'data',
  parse: 'data',
  frontend: 'frontend',
  react: 'frontend',
  ui: 'frontend',
  css: 'frontend',
  component: 'frontend',
  backend: 'backend',
  api: 'backend',
  server: 'backend',
  endpoint: 'backend',
  review: 'review',
  audit: 'review',
  inspect: 'review',
  simple: 'lightweight',
  quick: 'lightweight',
  trivial: 'lightweight',
};

export class ModelRouter {
  private profiles: ModelIntelligenceEntry[];
  private matrix: Record<string, ModelMatrixEntry>;
  private config: RouterConfig['config'];
  private costs: RouterCosts = { byModel: {}, totalCost: 0 };

  constructor(opts: RouterConfig) {
    this.profiles = opts.profiles ?? DEFAULT_PROFILES;
    this.matrix = opts.matrix ?? {};
    this.config = opts.config;
  }

  /** Look up the model matrix resolution for a role (role → phase → * → leader). */
  private resolveMatrix(role: string): ModelMatrixEntry | undefined {
    // Exact role match
    if (this.matrix[role]) return this.matrix[role];
    // Phase match
    const phase = this.roleToPhase(role);
    if (phase && this.matrix[phase]) return this.matrix[phase];
    // Wildcard
    if (this.matrix['*']) return this.matrix['*'];
    return undefined;
  }

  /** Simplified phase lookup for common roles. */
  private roleToPhase(role: string): string | undefined {
    const phaseMap: Record<string, string> = {
      planner: 'plan',
      architect: 'plan',
      'refactor-planner': 'plan',
      executor: 'code',
      refactor: 'code',
      simplifier: 'code',
      migration: 'code',
      'bug-hunter': 'code',
      debugger: 'code',
      tracer: 'code',
      test: 'code',
      verifier: 'code',
      e2e: 'code',
      performance: 'code',
      chaos: 'code',
      'security-scanner': 'review',
      'security-reviewer': 'review',
      'code-reviewer': 'review',
      reviewer: 'review',
      critic: 'review',
      accessibility: 'review',
      compliance: 'review',
      analyst: 'code',
      data: 'code',
      database: 'code',
      frontend: 'code',
      backend: 'code',
      api: 'code',
      auth: 'code',
      designer: 'code',
      document: 'code',
      researcher: 'plan',
      explore: 'plan',
      search: 'plan',
    };
    return phaseMap[role];
  }

  /**
   * Pick the best model for a task.
   *
   * Priority:
   *   1. User's /setmodel matrix entry for this role (explicit override)
   *   2. Best-matching model from intelligence profiles
   *   3. Leader model (fallback)
   */
  pickForTask(role: string, description: string): ModelPick {
    // 1. Check user matrix
    const matrixEntry = this.resolveMatrix(role);
    if (matrixEntry?.model) {
      const provider = matrixEntry.provider ?? this.config.provider;
      return {
        provider,
        model: matrixEntry.model,
        reason: `matrix override for role ${role}`,
        fromMatrix: true,
      };
    }

    // 2. Auto-detect from task description + role
    const category = this.inferCategory(description, role);
    const best = this.findBestModel(category);
    if (best) {
      return { ...best, reason: `best-for ${category} (auto-detected)`, fromMatrix: false };
    }

    // 3. Leader fallback
    return {
      provider: this.config.provider,
      model: this.config.model,
      reason: 'leader fallback',
      fromMatrix: false,
    };
  }

  /** Infer task category from description keywords + role. */
  private inferCategory(description: string, role: string): string {
    const d = description.toLowerCase();
    for (const [keyword, category] of Object.entries(TASK_CATEGORIES)) {
      if (d.includes(keyword)) return category;
    }
    // Map role to category
    const roleMap: Record<string, string> = {
      'security-scanner': 'security',
      'security-reviewer': 'security',
      'bug-hunter': 'debugging',
      debugger: 'debugging',
      planner: 'planning',
      architect: 'planning',
      'refactor-planner': 'refactoring',
      refactor: 'refactoring',
      test: 'testing',
      e2e: 'testing',
      verifier: 'testing',
      document: 'docs',
      simplifier: 'docs',
      'code-reviewer': 'review',
      reviewer: 'review',
      critic: 'review',
      frontend: 'frontend',
      backend: 'backend',
    };
    return roleMap[role] ?? 'general';
  }

  /** Find the best available model for a task category. */
  private findBestModel(category: string): { provider: string; model: string } | undefined {
    // Score each profile for this category
    const scored = this.profiles
      .filter((p) => this.hasKey(p.provider))
      .map((p) => {
        let score = 50;
        if (p.bestFor.includes(category)) score += 40;
        if (p.avoidFor?.includes(category)) score -= 50;
        if (category === 'lightweight' && p.costTier === 'budget') score += 20;
        if (category === 'planning' && p.costTier === 'premium') score += 15;
        if (category === 'planning' && p.speedTier === 'slow') score += 10; // slow = thorough
        return { profile: p, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return undefined;

    // Guarded by scored.length === 0 check above — but use optional
    // chaining instead of `!` to satisfy the non-null assertion lint rule.
    const best = scored[0]?.profile;
    if (!best) return undefined;
    // Find the actual model id from the provider's configured models
    const models = this.getProviderModels(best.provider);
    const match = models.find((m) => best.pattern.test(m)) ?? models[0];
    if (!match) return undefined;

    return { provider: best.provider, model: match };
  }

  /** Check if a provider has an API key configured. */
  private hasKey(providerId: string): boolean {
    const pc = this.config.providers?.[providerId];
    if (!pc) return providerId === this.config.provider;
    if (typeof pc.apiKey === 'string' && pc.apiKey.length > 0) return true;
    if (Array.isArray(pc.apiKeys) && pc.apiKeys.some((k) => k?.apiKey)) return true;
    return false;
  }

  /** Get the configured model list for a provider. */
  private getProviderModels(providerId: string): string[] {
    const pc = this.config.providers?.[providerId];
    return pc?.models ?? [];
  }

  /** Record cost for a model. */
  recordCost(
    provider: string,
    model: string,
    cost: number,
    tokens?: { input: number; output: number },
  ): void {
    const key = `${provider}/${model}`;
    const entry = this.costs.byModel[key] ?? { cost: 0, tokens: { input: 0, output: 0 }, calls: 0 };
    entry.cost += cost;
    if (tokens) {
      entry.tokens.input += tokens.input;
      entry.tokens.output += tokens.output;
    }
    entry.calls += 1;
    this.costs.byModel[key] = entry;
    this.costs.totalCost += cost;
  }

  /** Get cumulative costs. */
  getCosts(): RouterCosts {
    return { ...this.costs, byModel: { ...this.costs.byModel } };
  }

  /** Reset cost tracking. */
  resetCosts(): void {
    this.costs = { byModel: {}, totalCost: 0 };
  }

  /** List all available providers with their best model for each task category. */
  suggestMatrix(): Record<string, ModelPick> {
    const matrix: Record<string, ModelPick> = {};
    const roles = [
      'security-scanner',
      'bug-hunter',
      'planner',
      'architect',
      'refactor-planner',
      'test',
      'document',
      'code-reviewer',
      'reviewer',
      'verifier',
      'executor',
      'debugger',
      'analyst',
    ];

    for (const role of roles) {
      // Don't override explicit user matrix entries
      if (this.matrix[role]) continue;

      const pick = this.pickForTask(role, role);
      if (!pick.fromMatrix) {
        matrix[role] = pick;
      }
    }

    return matrix;
  }
}
