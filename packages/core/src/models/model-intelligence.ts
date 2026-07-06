/**
 * Model Intelligence — knowledge base of model capabilities, strengths,
 * and task-type suitability. Powers automatic agent → model routing.
 *
 * Each entry records:
 *   - Known strengths (what this model family excels at)
 *   - Known weaknesses (what it struggles with)
 *   - Best-for task types (coding, planning, security, docs, etc.)
 *   - Cost tier (budget / standard / premium)
 *
 * This is a curated dataset updated as new models release. Falls back
 * gracefully for unknown models.
 */

export interface ModelProfile {
  /** Provider id (e.g. "anthropic", "openai"). */
  provider: string;
  /** Model id regex — matches partial ids for a model family. */
  pattern: RegExp;
  /** Human-readable model family name. */
  family: string;
  /** What this model is particularly good at. */
  strengths: string[];
  /** Known limitations. */
  weaknesses?: string[];
  /** Task types this model is the best choice for. Ordered by preference. */
  bestFor: TaskType[];
  /** Task types to avoid with this model (use a different one). */
  avoidFor?: TaskType[];
  /** Approximate cost tier. */
  costTier: 'budget' | 'standard' | 'premium';
  /** Approximate speed tier (relative to other models). */
  speedTier: 'fast' | 'normal' | 'slow';
  /** Minimum recommended context window. */
  minContext?: number;
}

/** Task categories that map to agent roles. */
export type TaskType =
  | 'coding' // general software development
  | 'planning' // architecture, design, strategy
  | 'security' // vulnerability scanning, security review
  | 'docs' // documentation, writing, explanation
  | 'testing' // test writing, test review
  | 'refactoring' // code restructuring, cleanup
  | 'debugging' // bug hunting, error tracing
  | 'data' // data analysis, JSON, DB queries
  | 'frontend' // React, UI, CSS
  | 'backend' // API, server, infrastructure
  | 'review' // code review, PR review
  | 'lightweight' // simple tasks, quick answers
  | 'general'; // fallback — any task

/** Known model profiles. Patterns are tried in order; first match wins. */
export const MODEL_PROFILES: ModelProfile[] = [
  // ── Anthropic ──
  {
    provider: 'anthropic',
    pattern: /claude-opus/i,
    family: 'Claude Opus',
    strengths: [
      'complex reasoning',
      'multi-step planning',
      'nuanced judgment',
      'long-form analysis',
    ],
    weaknesses: ['latency', 'cost'],
    bestFor: ['planning', 'security', 'debugging', 'review'],
    costTier: 'premium',
    speedTier: 'slow',
  },
  {
    provider: 'anthropic',
    pattern: /claude-haiku/i,
    family: 'Claude Haiku',
    strengths: ['speed', 'low cost', 'simple tasks'],
    weaknesses: ['complex reasoning', 'long context'],
    bestFor: ['lightweight', 'docs', 'frontend'],
    avoidFor: ['planning', 'security'],
    costTier: 'budget',
    speedTier: 'fast',
  },

  // ── OpenAI ──
  {
    provider: 'openai',
    pattern: /gpt-5|o3|o4/i,
    family: 'GPT-5 / o3 / o4',
    strengths: ['complex reasoning', 'coding', 'multi-modal'],
    bestFor: ['planning', 'coding', 'debugging', 'general'],
    costTier: 'premium',
    speedTier: 'normal',
  },
  {
    provider: 'openai',
    pattern: /gpt-4\.1|gpt-4o/i,
    family: 'GPT-4.1 / 4o',
    strengths: ['coding', 'balanced reasoning', 'fast'],
    bestFor: ['coding', 'refactoring', 'backend', 'docs'],
    costTier: 'standard',
    speedTier: 'fast',
  },
  {
    provider: 'openai',
    pattern: /gpt-4o-mini/i,
    family: 'GPT-4o Mini',
    strengths: ['speed', 'low cost', 'simple tasks'],
    weaknesses: ['complex reasoning'],
    bestFor: ['lightweight', 'frontend', 'docs'],
    avoidFor: ['planning', 'security'],
    costTier: 'budget',
    speedTier: 'fast',
  },

  // ── Google ──
  {
    provider: 'google',
    pattern: /gemini-(?:2\.5|3)/i,
    family: 'Gemini 2.5 / 3',
    strengths: ['long context', 'multi-modal', 'coding', 'reasoning'],
    bestFor: ['coding', 'planning', 'data', 'general'],
    costTier: 'standard',
    speedTier: 'normal',
  },
  {
    provider: 'google',
    pattern: /gemini-2\.0-flash|gemini-flash/i,
    family: 'Gemini Flash',
    strengths: ['speed', 'low cost', 'long context'],
    weaknesses: ['deep reasoning'],
    bestFor: ['lightweight', 'docs', 'frontend', 'data'],
    avoidFor: ['planning', 'security'],
    costTier: 'budget',
    speedTier: 'fast',
  },

  // ── DeepSeek ──
  {
    provider: 'deepseek',
    pattern: /deepseek-v3|deepseek-r1/i,
    family: 'DeepSeek V3 / R1',
    strengths: ['coding', 'math', 'reasoning', 'cost-effective'],
    bestFor: ['coding', 'refactoring', 'debugging', 'general'],
    costTier: 'standard',
    speedTier: 'normal',
  },

  // ── OpenRouter / catch-all ──
  {
    provider: 'openrouter',
    pattern: /.*/,
    family: 'OpenRouter (routed)',
    strengths: ['model variety', 'fallback'],
    bestFor: ['general'],
    costTier: 'standard',
    speedTier: 'normal',
  },
];

/** Map task types to the agent roles that handle them. */
export const TASK_TO_ROLE: Record<TaskType, string[]> = {
  coding: ['executor', 'architect', 'bug-hunter'],
  planning: ['planner', 'architect', 'refactor-planner'],
  security: ['security-scanner', 'security-reviewer'],
  docs: ['document', 'simplifier'],
  testing: ['verifier', 'test', 'e2e'],
  refactoring: ['refactor-planner', 'refactor', 'simplifier'],
  debugging: ['debugger', 'bug-hunter', 'tracer'],
  data: ['analyst', 'data', 'database'],
  frontend: ['frontend', 'designer'],
  backend: ['backend', 'api', 'auth'],
  review: ['reviewer', 'code-reviewer', 'critic'],
  lightweight: ['executor', 'simplifier'],
  general: ['executor', 'analyst'],
};

/**
 * Infer the most likely task type from a task description and target role.
 * Uses keyword matching; falls back to the role's primary task type.
 */
export function inferTaskType(description: string, role?: string): TaskType {
  const d = description.toLowerCase();

  // Keyword → task type mapping
  const keywords: [RegExp, TaskType][] = [
    [/plan|architect|design|strategy|blueprint|system\s*design/i, 'planning'],
    [/security|vuln|exploit|injection|auth/i, 'security'],
    [/doc|readme|explain|write\s*(a|the)\s*doc|tutorial/i, 'docs'],
    [/test|spec|assert|mock|coverage/i, 'testing'],
    [/refactor|clean\s*up|restructure|simplify/i, 'refactoring'],
    [/bug|fix|debug|trace|crash|error/i, 'debugging'],
    [/data|json|sql|query|analyze|parse/i, 'data'],
    [/frontend|react|ui|css|component|jsx/i, 'frontend'],
    [/backend|api|server|endpoint|route|middleware/i, 'backend'],
    [/review|audit|inspect|check/i, 'review'],
    [/simple|quick|one-liner|trivial/i, 'lightweight'],
  ];

  for (const [re, taskType] of keywords) {
    if (re.test(d)) return taskType;
  }

  // Fallback: map role to best task type
  if (role) {
    for (const [taskType, roles] of Object.entries(TASK_TO_ROLE)) {
      if (roles.includes(role)) return taskType as TaskType;
    }
  }

  return 'general';
}

/**
 * Find the best matching model profile for a given provider + model id.
 */
export function findModelProfile(provider: string, modelId: string): ModelProfile | undefined {
  const candidates = MODEL_PROFILES.filter((p) => p.provider === provider);
  // Try exact match first, then pattern match
  for (const p of candidates) {
    if (p.pattern.test(modelId)) return p;
  }
  return undefined;
}

/**
 * Score a model for a given task type. Higher = better fit.
 * Returns 0-100.
 */
export function scoreModelForTask(profile: ModelProfile | undefined, taskType: TaskType): number {
  if (!profile) return 50; // unknown model — neutral

  // Explicitly avoided → very low score
  if (profile.avoidFor?.includes(taskType)) return 10;

  // Best-for match → high score
  const bestIdx = profile.bestFor.indexOf(taskType);
  if (bestIdx >= 0) {
    // Earlier in the list = better fit
    return 90 - bestIdx * 10;
  }

  // Cost/speed adjustments
  let score = 50;
  if (taskType === 'lightweight') {
    score += profile.costTier === 'budget' ? 30 : profile.costTier === 'standard' ? 15 : 0;
    score += profile.speedTier === 'fast' ? 20 : 0;
  }
  if (taskType === 'planning' || taskType === 'security') {
    score += profile.costTier === 'premium' ? 20 : 0;
    score += profile.speedTier === 'slow' ? 10 : 0; // slow = thorough
  }

  return score;
}
