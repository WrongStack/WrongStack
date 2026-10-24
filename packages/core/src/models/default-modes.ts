/**
 * The built-in mode catalog. Several prompts load lazily from the bundled
 * `instructions/modes/*.md` files, which is why this lives here and not in the
 * `types/` contracts.
 */
import type { Mode } from '@wrongstack/contracts/types/mode';
import { modePrompt } from './mode-prompts.js';

export const DEFAULT_MODES: Mode[] = [
  {
    id: 'default',
    name: 'Default',
    description:
      'Balanced general-purpose mode; use when no special token/coverage trade-off is needed',
    prompt: '',
    tags: ['general', 'balanced'],
  },
  {
    id: 'brief',
    name: 'Brief',
    description: 'Ultra-compact responses for low-context, high-speed work',
    prompt: '',
    tags: ['lite', 'fast', 'concise', 'token-saving'],
    toolPreferences: ['read', 'edit', 'bash'],
    suggestedSkills: [],
  },
  {
    id: 'review-lite',
    name: 'Review Lite',
    description: 'Token-saving code review: changed files only, top correctness/security risks',
    prompt: '',
    tags: ['lite', 'review', 'quality', 'token-saving'],
    toolPreferences: ['git', 'diff', 'read', 'grep'],
    suggestedSkills: ['bug-hunter', 'typescript-strict'],
  },
  {
    id: 'audit-lite',
    name: 'Audit Lite',
    description: 'Token-saving security triage for a small diff or named file',
    prompt: '',
    tags: ['lite', 'security', 'audit', 'token-saving'],
    toolPreferences: ['grep', 'read', 'git'],
    suggestedSkills: ['security-scanner'],
  },
  {
    id: 'plan-lite',
    name: 'Plan Lite',
    description: 'Token-saving planning: 3-6 actionable steps, minimal design debate',
    prompt: '',
    tags: ['lite', 'planning', 'architecture', 'token-saving'],
    toolPreferences: ['tree', 'glob', 'read', 'grep'],
    suggestedSkills: ['refactor-planner'],
  },
  {
    id: 'debug-lite',
    name: 'Debug Lite',
    description: 'Token-saving bug triage: one hypothesis, nearest evidence, narrow check',
    prompt: '',
    tags: ['lite', 'debug', 'triage', 'token-saving'],
    toolPreferences: ['read', 'grep', 'test', 'logs'],
    suggestedSkills: ['bug-hunter'],
  },
  {
    id: 'test-lite',
    name: 'Test Lite',
    description: 'Token-saving tests: one focused regression or narrow verification target',
    prompt: '',
    tags: ['lite', 'testing', 'qa', 'token-saving'],
    toolPreferences: ['test', 'read', 'grep'],
    suggestedSkills: ['testing'],
  },
  {
    id: 'refactor-lite',
    name: 'Refactor Lite',
    description: 'Token-saving cleanup: small scoped behavior-preserving changes',
    prompt: '',
    tags: ['lite', 'refactor', 'token-saving'],
    toolPreferences: ['read', 'edit', 'test'],
    suggestedSkills: ['typescript-strict'],
  },
  {
    id: 'research-lite',
    name: 'Research Lite',
    description: 'Token-saving web research: one search, one authoritative fetch, short answer',
    prompt: '',
    tags: ['lite', 'research', 'web', 'token-saving'],
    toolPreferences: ['search', 'fetch'],
    suggestedSkills: ['research-web'],
  },
  {
    id: 'code-reviewer',
    name: 'Review Deep',
    description:
      'Comprehensive code review across contracts, edge cases, lifecycle, errors, concurrency',
    prompt: '',
    tags: ['deep', 'review', 'quality', 'security'],
    toolPreferences: ['read', 'grep', 'git', 'diff', 'test'],
    suggestedSkills: ['bug-hunter', 'security-scanner', 'typescript-strict', 'testing'],
  },
  {
    id: 'code-auditor',
    name: 'Audit Deep',
    description: 'Comprehensive security audit with category coverage and exploitability notes',
    prompt: '',
    tags: ['deep', 'security', 'audit', 'compliance'],
    toolPreferences: ['grep', 'read', 'audit', 'bash'],
    suggestedSkills: ['security-scanner', 'bug-hunter', 'audit-log'],
  },
  {
    id: 'architect',
    name: 'Architecture Deep',
    description: 'Comprehensive architecture and cross-module contract analysis',
    prompt: '',
    tags: ['deep', 'architecture', 'design', 'scalability'],
    toolPreferences: ['read', 'glob', 'tree', 'diff'],
    suggestedSkills: ['api-design', 'refactor-planner', 'node-modern', 'docker-deploy'],
  },
  {
    id: 'debugger',
    name: 'Debug Deep',
    description:
      'Comprehensive root-cause analysis with traces, logs, assumptions, and verification',
    prompt: '',
    tags: ['deep', 'debug', 'investigation', 'error-resolution'],
    toolPreferences: ['read', 'grep', 'bash', 'logs', 'test'],
    suggestedSkills: ['bug-hunter', 'audit-log', 'observability'],
  },
  {
    id: 'tester',
    name: 'Test Deep',
    description: 'Comprehensive QA mode for coverage, boundaries, isolation, and integration gaps',
    prompt: '',
    tags: ['deep', 'testing', 'qa', 'quality'],
    toolPreferences: ['read', 'grep', 'test', 'bash'],
    suggestedSkills: ['testing', 'bug-hunter', 'typescript-strict'],
  },
  {
    id: 'devops',
    name: 'DevOps Deep',
    description: 'Comprehensive infrastructure, deployment, observability, and operations review',
    prompt: '',
    tags: ['deep', 'devops', 'infrastructure', 'operations'],
    toolPreferences: ['read', 'bash', 'grep', 'logs', 'git'],
    suggestedSkills: ['docker-deploy', 'observability', 'security-scanner'],
  },
  {
    id: 'refactorer',
    name: 'Refactor Deep',
    description:
      'Comprehensive modernization/refactor mode with contracts and verification discipline',
    prompt: '',
    tags: ['deep', 'refactor', 'modernization', 'improvement'],
    toolPreferences: ['read', 'edit', 'test', 'git', 'grep'],
    suggestedSkills: ['refactor-planner', 'typescript-strict', 'node-modern', 'testing'],
  },
  {
    id: 'ui-design',
    name: 'UI Design Deep',
    description:
      'Comprehensive design-first frontend/mobile UI work with kit, tokens, and accessibility',
    prompt: '',
    tags: ['deep', 'ui', 'frontend', 'mobile', 'design'],
    toolPreferences: ['design', 'write', 'edit', 'read', 'scaffold'],
    suggestedSkills: ['react-modern'],
  },
  {
    id: 'teach',
    name: 'Teach Deep',
    description: 'Mentor mode with explanations, mental models, trade-offs, and takeaways',
    prompt: '',
    tags: ['deep', 'teaching', 'mentor', 'learning'],
    toolPreferences: ['read', 'edit', 'explain'],
    suggestedSkills: ['prompt-engineering', 'skill-creator', 'node-modern', 'typescript-strict'],
  },
  {
    id: 'research-web',
    name: 'Research Deep',
    description: 'Comprehensive current-data research with cross-checking and reusable findings',
    prompt: '',
    tags: ['deep', 'research', 'web', 'current-data', 'up-to-date'],
    toolPreferences: ['search', 'fetch', 'context_manager'],
    suggestedSkills: [
      'research-web',
      'tech-stack',
      'node-modern',
      'security-scanner',
      'react-modern',
    ],
  },
];

/**
 * Mode prompt bodies live on disk. Building this catalog used to read all
 * 18 of them at module load — and `types/index.ts` re-exports
 * `DEFAULT_MODES`, so every consumer of the core barrel paid for prompts it
 * would never show. Each id matches its prompt file name, so the accessor is
 * installed here instead, resolving on first read.
 *
 * Enumerable + configurable so spreads, `Object.keys` and JSON round-trips are
 * unchanged; writable so a host that overrides a built-in mode's prompt still can.
 */
const LAZY_MODE_PROMPT_IDS = new Set<string>([
  'brief',
  'review-lite',
  'audit-lite',
  'plan-lite',
  'debug-lite',
  'test-lite',
  'refactor-lite',
  'research-lite',
  'code-reviewer',
  'code-auditor',
  'architect',
  'debugger',
  'tester',
  'devops',
  'refactorer',
  'ui-design',
  'teach',
  'research-web',
]);

for (const mode of DEFAULT_MODES) {
  if (!LAZY_MODE_PROMPT_IDS.has(mode.id)) continue;
  const id = mode.id;
  Object.defineProperty(mode, 'prompt', {
    configurable: true,
    enumerable: true,
    get: (): string => modePrompt(id),
    // Define on the receiver, so an override applied to a COPY of the mode
    // lands on that copy instead of mutating the shared catalog entry.
    set(this: Mode, value: string) {
      Object.defineProperty(this, 'prompt', {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    },
  });
}
