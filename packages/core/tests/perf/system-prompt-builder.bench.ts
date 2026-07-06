import { bench, describe } from 'vitest';
import { DefaultSystemPromptBuilder } from '../../src/core/system-prompt-builder.js';
import type { Tool } from '../../src/types/tool.js';

/**
 * V0-B: the system prompt is rebuilt on every iteration. With memory +
 * skills + mode + a long tool list, this can become a non-trivial cost.
 * Bench the realistic shape: ~15 tools, no memory/skills (cached after
 * first call anyway), and a project of moderate size.
 */

function makeTool(name: string): Tool {
  return {
    name,
    description: `${name} tool — does a useful thing in the system, with a moderately long description that captures real-world tool prose.`,
    usageHint: `Use ${name} when you need its specific functionality. Provide the required parameters per the inputSchema.`,
    permission: 'auto',
    mutating: false,
    inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
    async execute() {
      return undefined;
    },
  };
}

const TOOL_NAMES = [
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'bash',
  'fetch',
  'todo',
  'replace',
  'search',
  'git',
  'exec',
  'patch',
  'json',
  'diff',
];
const tools = TOOL_NAMES.map(makeTool);

const builder = new DefaultSystemPromptBuilder();

describe('DefaultSystemPromptBuilder.build', () => {
  bench('15 tools, no memory/skills/mode', async () => {
    await builder.build({
      cwd: '/tmp/project',
      projectRoot: '/tmp/project',
      tools,
      provider: 'anthropic',
      model: 'anthropic-test-model',
    });
  });

  bench('empty tools list', async () => {
    await builder.build({
      cwd: '/tmp/project',
      projectRoot: '/tmp/project',
      tools: [],
      provider: 'anthropic',
      model: 'anthropic-test-model',
    });
  });
});
