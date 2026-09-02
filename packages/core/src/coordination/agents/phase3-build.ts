import { type AgentDefinition, HEAVY_BUDGET, MEDIUM_BUDGET, TOOLS } from './types.js';
import { agentPrompt } from './agent-prompts.js';

/** Phase 3 · Build — write, refactor, migrate, and fix code. */
export const BUILD_AGENTS: AgentDefinition[] = [
  {
    config: {
      id: 'executor',
      name: 'Executor',
      role: 'executor',
      tools: [...TOOLS.build],
      prompt: agentPrompt('executor'),
    },
    budget: HEAVY_BUDGET,
    capability: {
      phase: 'build',
      summary: 'Implements well-specified tasks: writes code, runs checks, leaves the tree green.',
      keywords: [
        'implement',
        'build',
        'write code',
        'add feature',
        'create',
        'code up',
        'develop',
        'apply change',
        'make it work',
      ],
    },
  },
  {
    config: {
      id: 'refactor',
      name: 'Refactor',
      role: 'refactor',
      tools: [...TOOLS.build],
      prompt: agentPrompt('refactor'),
    },
    budget: HEAVY_BUDGET,
    capability: {
      phase: 'build',
      summary:
        'Structural refactoring: extract/split/move/rename/decouple without changing observable behavior.',
      keywords: [
        'refactor',
        'restructure',
        'extract',
        'split module',
        'decouple',
        'rename',
        'move code',
        'break dependency',
        'reorganize',
      ],
    },
  },
  {
    config: {
      id: 'simplifier',
      name: 'Simplifier',
      role: 'simplifier',
      tools: [...TOOLS.build],
      prompt: agentPrompt('simplifier'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'build',
      summary:
        'Reduces complexity: deletes dead code, collapses needless abstractions, shortens and clarifies code.',
      keywords: [
        'simplify',
        'dead code',
        'remove unused',
        'reduce complexity',
        'clean up',
        'denest',
        'shorten',
        'over-engineered',
        'too complex',
      ],
    },
  },
  {
    config: {
      id: 'migration',
      name: 'Migration',
      role: 'migration',
      tools: [...TOOLS.build, 'install', 'outdated'],
      prompt: agentPrompt('migration'),
    },
    budget: HEAVY_BUDGET,
    capability: {
      phase: 'build',
      summary:
        'Framework/language/version upgrades: applies codemods across call sites, staged and verified.',
      keywords: [
        'migrate',
        'upgrade',
        'codemod',
        'breaking change',
        'major version',
        'port to',
        'convert to',
        'esm',
        'modernize',
      ],
    },
  },
  {
    config: {
      id: 'vision',
      name: 'Vision',
      role: 'vision',
      tools: [...TOOLS.write, 'fetch'],
      prompt: agentPrompt('vision'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'build',
      summary:
        'Screenshot/mockup → UI code: infers component tree and generates matching, accessible markup.',
      keywords: [
        'screenshot',
        'mockup',
        'design to code',
        'image to ui',
        'figma',
        'replicate this ui',
        'from this picture',
        'vision',
        'clone ui',
      ],
    },
  },
  {
    config: {
      id: 'debugger',
      name: 'Debugger',
      role: 'debugger',
      tools: [...TOOLS.build, 'logs'],
      prompt: agentPrompt('debugger'),
    },
    budget: HEAVY_BUDGET,
    capability: {
      phase: 'build',
      summary:
        'Root-cause bug fixing: reproduces, bisects to the true cause, applies a minimal fix with a regression test.',
      keywords: [
        'bug',
        'fix',
        'debug',
        'broken',
        'error',
        'crash',
        'root cause',
        'not working',
        'failing',
        'reproduce',
        'why does',
      ],
    },
  },
  {
    config: {
      id: 'tracer',
      name: 'Tracer',
      role: 'tracer',
      tools: [...TOOLS.build, 'logs'],
      prompt: agentPrompt('tracer'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'build',
      summary:
        'Runtime tracing: instruments and runs code to observe call order, values, and timing, then cleans up.',
      keywords: [
        'trace',
        'runtime',
        'instrument',
        'execution path',
        'what happens at runtime',
        'call order',
        'profile execution',
        'observe behavior',
        'stack trace',
      ],
    },
  },
];
