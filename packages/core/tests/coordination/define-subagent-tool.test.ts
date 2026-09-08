import { describe, expect, it } from 'vitest';
import { createDefineSubagentTool } from '../../src/coordination/define-subagent-tool.js';
import type { SubagentConfig } from '../../src/types/multi-agent.js';

describe('define_subagent tool', () => {
  it('registers a custom subagent into the active roster', async () => {
    const roster: Record<string, SubagentConfig> = {};
    const tool = createDefineSubagentTool({ roster });

    const result = await tool.execute(
      {
        name: 'code-cleaner',
        description: 'Refactors dead imports and formats comments',
        system_prompt: 'You are a dedicated code cleaner. Focus on formatting and dead import removal.',
        enable_write_tools: true,
      },
      {} as never,
      { signal: new AbortController().signal },
    );

    expect(result.success).toBe(true);
    expect(result.name).toBe('code-cleaner');
    expect(roster['code-cleaner']).toBeDefined();
    expect(roster['code-cleaner']?.prompt).toContain('You are a dedicated code cleaner');
    expect(roster['code-cleaner']?.allowedCapabilities).toContain('fs.write');
    expect(roster['code-cleaner']?.tools).toContain('write');
  });

  it('rejects invalid names defensively', async () => {
    const roster: Record<string, SubagentConfig> = {};
    const tool = createDefineSubagentTool({ roster });

    await expect(
      tool.execute(
        {
          name: 'bad name with spaces!',
          description: 'test',
          system_prompt: 'test prompt',
        },
        {} as never,
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('Invalid subagent name');
  });

  it('rejects empty system prompt', async () => {
    const roster: Record<string, SubagentConfig> = {};
    const tool = createDefineSubagentTool({ roster });

    await expect(
      tool.execute(
        {
          name: 'empty-prompt-agent',
          description: 'test',
          system_prompt: '   ',
        },
        {} as never,
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('define_subagent requires a non-empty `system_prompt`');
  });
});
