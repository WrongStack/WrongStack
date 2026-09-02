import { describe, expect, it } from 'vitest';
import type { Tool } from '@wrongstack/core/types';
import { scoreTool, filterToolsByMaxCount } from '../src/tool-priority.js';

function makeTool(name: string): Tool {
  return {
    name,
    description: `Tool ${name}`,
    permission: 'auto',
    mutating: false,
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return undefined as never;
    },
  };
}

function makeTools(...names: string[]): Tool[] {
  return names.map(makeTool);
}

// ── scoreTool ────────────────────────────────────────────────────

describe('scoreTool', () => {
  it('scores critical tools at priority 0', () => {
    for (const name of ['read', 'write', 'edit', 'bash', 'exec', 'grep', 'glob']) {
      expect(scoreTool(makeTool(name))).toBe(0);
    }
  });

  it('scores essential tools at priority 1', () => {
    for (const name of ['diff', 'patch', 'json', 'search', 'fetch', 'git', 'codebase-stats']) {
      expect(scoreTool(makeTool(name))).toBe(1);
    }
  });

  it('scores standard tools at priority 2', () => {
    for (const name of [
      'test',
      'lint',
      'typecheck',
      'format',
      'todo',
      'nextsteps',
      'kanban',
      'replace',
    ]) {
      expect(scoreTool(makeTool(name))).toBe(2);
    }
  });

  it('scores browser tools at priority 3', () => {
    expect(scoreTool(makeTool('browser_open'))).toBe(3);
    expect(scoreTool(makeTool('browser_click'))).toBe(3);
    expect(scoreTool(makeTool('browser_screenshot'))).toBe(3);
  });

  it('scores coordination tools at priority 4', () => {
    expect(scoreTool(makeTool('delegate'))).toBe(4);
    expect(scoreTool(makeTool('spawn_subagent'))).toBe(4);
    expect(scoreTool(makeTool('mail_send'))).toBe(4);
  });

  it('scores meta tools at priority 5', () => {
    expect(scoreTool(makeTool('tool_search'))).toBe(5);
    expect(scoreTool(makeTool('tool_help'))).toBe(5);
    expect(scoreTool(makeTool('set_working_dir'))).toBe(5);
  });

  it('scores status/diagnostic tools at priority 6', () => {
    expect(scoreTool(makeTool('lint_gate_status'))).toBe(6);
    expect(scoreTool(makeTool('secret_scanner_test'))).toBe(6);
    expect(scoreTool(makeTool('loop_breaker_status'))).toBe(6);
  });

  it('scores unknown tools at priority 4 (medium-low)', () => {
    expect(scoreTool(makeTool('some_custom_plugin_tool'))).toBe(4);
  });
});

// ── filterToolsByMaxCount ────────────────────────────────────────

describe('filterToolsByMaxCount', () => {
  it('returns all tools unchanged when under the limit', () => {
    const tools = makeTools('read', 'write', 'bash');
    const result = filterToolsByMaxCount(tools, 10);
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.name)).toEqual(['read', 'write', 'bash']);
  });

  it('returns all tools unchanged when exactly at the limit', () => {
    const tools = makeTools('read', 'write', 'bash');
    const result = filterToolsByMaxCount(tools, 3);
    expect(result).toHaveLength(3);
  });

  it('trims to the limit when over', () => {
    const tools = makeTools(
      'read',
      'write',
      'bash',
      'lint_gate_status',
      'secret_scanner_test',
      'loop_breaker_status',
    );
    const result = filterToolsByMaxCount(tools, 3);
    expect(result).toHaveLength(3);
    // Critical tools are kept, diagnostic tools are dropped
    expect(result.map((t) => t.name)).toEqual(['read', 'write', 'bash']);
  });

  it('drops lowest-priority tools first', () => {
    const tools = makeTools(
      'lint_gate_status',
      'read',
      'tool_search',
      'write',
      'secret_scanner_test',
    );
    const result = filterToolsByMaxCount(tools, 3);
    expect(result).toHaveLength(3);
    // read(0), write(0), tool_search(5) survive; original order preserved
    expect(result.map((t) => t.name)).toEqual(['read', 'tool_search', 'write']);
  });

  it('preserves original registration order in the output', () => {
    const tools = makeTools(
      'secret_scanner_test',
      'loop_breaker_status',
      'bash',
      'read',
      'edit',
      'lint_gate_status',
    );
    const result = filterToolsByMaxCount(tools, 3);
    // bash, read, edit are the top-3 by priority; they should appear in
    // their original relative registration order.
    expect(result.map((t) => t.name)).toEqual(['bash', 'read', 'edit']);
  });

  it('handles empty tool list', () => {
    const result = filterToolsByMaxCount([], 5);
    expect(result).toHaveLength(0);
  });

  it('handles limit of 1', () => {
    const tools = makeTools('lint_gate_status', 'read', 'tool_search');
    const result = filterToolsByMaxCount(tools, 1);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('read');
  });

  it('returns a new array (does not mutate input)', () => {
    const tools = makeTools('read', 'write');
    const result = filterToolsByMaxCount(tools, 10);
    expect(result).not.toBe(tools);
    expect(result).toHaveLength(2);
  });

  it('drops diagnostic tools before coordination tools', () => {
    const tools = makeTools(
      'lint_gate_status',
      'delegate',
      'secret_scanner_test',
      'spawn_subagent',
    );
    const result = filterToolsByMaxCount(tools, 2);
    expect(result.map((t) => t.name)).toEqual(['delegate', 'spawn_subagent']);
  });

  it('drops coordination tools before standard tools', () => {
    const tools = makeTools('delegate', 'test', 'spawn_subagent', 'lint');
    const result = filterToolsByMaxCount(tools, 2);
    expect(result.map((t) => t.name)).toEqual(['test', 'lint']);
  });

  it('drops standard tools before critical tools', () => {
    const tools = makeTools('test', 'read', 'lint', 'write');
    const result = filterToolsByMaxCount(tools, 2);
    expect(result.map((t) => t.name)).toEqual(['read', 'write']);
  });

  it('preserves relative order among same-priority tools', () => {
    // All critical — registration order must be preserved.
    const tools = makeTools('glob', 'grep', 'bash', 'exec', 'read');
    const result = filterToolsByMaxCount(tools, 3);
    expect(result.map((t) => t.name)).toEqual(['glob', 'grep', 'bash']);
  });

  it('simulates a realistic 128-tool cap scenario', () => {
    // Mix of tools representative of a full session.
    const tools: Tool[] = [
      ...makeTools('read', 'write', 'edit', 'bash', 'exec', 'grep', 'glob'),
      ...makeTools('diff', 'patch', 'json', 'search', 'fetch', 'git'),
      ...makeTools(
        'codebase-stats',
        'codebase-search',
        'codebase-index',
        'test',
        'lint',
        'typecheck',
        'format',
        'todo',
        'plan',
        'task',
        'kanban',
        'replace',
        'tree',
        'context_manager',
        'dead-code-scan',
      ),
      // 16 browser tools
      ...Array.from({ length: 16 }, (_, i) => makeTool(`browser_${i}`)),
      // 20 status/diagnostic tools
      ...Array.from({ length: 20 }, (_, i) => makeTool(`diag_${i}_status`)),
      // 10 coordination tools
      ...Array.from({ length: 10 }, (_, i) => makeTool(`coord_${i}`)),
      // 5 meta tools
      ...makeTools('tool_search', 'tool_use', 'batch_tool_use', 'tool_help', 'set_working_dir'),
      // 40 plugin/misc tools
      ...Array.from({ length: 40 }, (_, i) => makeTool(`plugin_${i}`)),
      // memory tools
      ...makeTools('remember', 'forget', 'memory_search', 'memory_update'),
      // provider config tools
      ...makeTools(
        'provider_manage',
        'provider_key_set',
        'favorite_manage',
        'fallback_chain_manage',
        'fallback_profile_manage',
        'agent_model_assign',
        'leader_model_set',
        'system_config_view',
      ),
      // governance status tools
      ...makeTools(
        'lint_gate_status',
        'diff_summary_status',
        'todo_listener_status',
        'loop_breaker_status',
        'process_guard_status',
        'dep_guard_status',
        'config_validator_status',
        'injection_shield_status',
        'prompt_firewall_status',
        'type_gate_status',
      ),
    ];

    expect(tools.length).toBeGreaterThan(128);

    const result = filterToolsByMaxCount(tools, 128);
    expect(result).toHaveLength(128);

    // Critical tools must survive
    for (const name of ['read', 'write', 'edit', 'bash', 'exec', 'grep', 'glob']) {
      expect(result.some((t) => t.name === name)).toBe(true);
    }

    // Some diagnostic tools should be dropped
    const diagnosticKept = result.filter((t) => t.name.endsWith('_status'));
    expect(diagnosticKept.length).toBeLessThan(30);
  });
});
