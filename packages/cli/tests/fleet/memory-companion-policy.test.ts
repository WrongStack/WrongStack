import { applyProjectAgentConfig } from '@wrongstack/agent-catalog';
import type { Tool } from '@wrongstack/contracts/types';
import { constrainMemoryCompanion, memoryCompanionTools } from '@wrongstack/fleet';
import { describe, expect, it } from 'vitest';

describe('Memory Companion role overrides', () => {
  it('reapplies read-only grants while honoring explicit budgets after system-role widening', () => {
    const merged = applyProjectAgentConfig(
      { name: 'Memory Companion', tools: ['read'], allowedCapabilities: ['fs.read'] },
      {
        tools: ['bash', 'memory_update', 'session_note'],
        allowedCapabilities: ['fs.write', 'session.note'],
        budget: {
          maxIterations: 9000,
          maxToolCalls: 9000,
          maxTokens: 999999,
          maxCostUsd: 100,
          timeoutMs: 3600000,
        },
      },
      { protectSystemRole: true },
    );
    expect(merged.tools).toContain('memory_update');
    const limited = constrainMemoryCompanion(merged);
    expect(limited.allowedCapabilities).toEqual(['fs.read']);
    expect(limited.tools).not.toContain('memory_update');
    expect(limited.tools).not.toContain('session_note');
    expect(limited).toMatchObject({
      maxIterations: 9000,
      maxToolCalls: 9000,
      maxTokens: 999999,
      maxCostUsd: 100,
      timeoutMs: 3600000,
      sealed: true,
      gracefulFinish: false,
      spawnBudgetExempt: true,
      textStream: 'silent',
      toolStream: 'silent',
    });
  });

  it('provides sustained review headroom and rejects mutating navigation tools', () => {
    const config = constrainMemoryCompanion({ name: 'Memory Companion' });
    expect(config).toMatchObject({
      maxIterations: 30_000,
      maxToolCalls: 80_000,
      maxTokens: 10_000_000,
      maxCostUsd: 200,
      timeoutMs: 18_000_000,
    });
    for (const name of [
      'codebase-context',
      'codebase-read-symbol',
      'codebase-incoming-calls',
      'codebase-outgoing-calls',
      'codebase-impact-analysis',
      'tree',
      'codebase-repo-map',
      'codebase-stats',
    ]) {
      expect(config.tools).toContain(name);
    }
    const tools = memoryCompanionTools(
      [
        { name: 'codebase-context', mutating: false },
        { name: 'read', mutating: true },
        { name: 'bash', mutating: false },
      ].map(
        (tool): Tool => ({
          ...tool,
          description: tool.name,
          inputSchema: { type: 'object', properties: {} },
          permission: 'auto',
          execute: async () => '',
        }),
      ),
    );
    expect(tools.map((tool) => tool.name)).toEqual(['codebase-context', 'submit_result']);
  });
});
