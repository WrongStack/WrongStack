import type { Tool } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import { proposalOnlyCandidatesTool, selectAllowedTools } from '../src/policy.js';

function makeTool(overrides: Partial<Tool>): Tool {
  return {
    name: 'sample',
    description: 'sample',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    ...overrides,
  } as Tool;
}

describe('selectAllowedTools', () => {
  it('default policy exposes only safe + auto tools (read-only)', () => {
    const tools: Tool[] = [
      makeTool({ name: 'read', riskTier: 'safe', permission: 'auto' }),
      makeTool({ name: 'write', riskTier: 'standard', permission: 'auto' }),
      makeTool({ name: 'destructive', riskTier: 'destructive', permission: 'auto' }),
    ];
    const allowed = selectAllowedTools(tools);
    expect(allowed.map((entry) => entry.name)).toEqual(['read']);
  });

  it('--writable (writable: true) adds standard-tier tools', () => {
    const tools: Tool[] = [
      makeTool({ name: 'read', riskTier: 'safe', permission: 'auto' }),
      makeTool({ name: 'write', riskTier: 'standard', permission: 'auto' }),
      makeTool({ name: 'destructive', riskTier: 'destructive', permission: 'auto' }),
    ];
    const allowed = selectAllowedTools(tools, { writable: true });
    expect(allowed.map((entry) => entry.name).sort()).toEqual(['read', 'write']);
  });

  it('refuses tools with permission: deny (always)', () => {
    const tools: Tool[] = [makeTool({ name: 'banned', permission: 'deny', riskTier: 'safe' })];
    const allowed = selectAllowedTools(tools, { writable: true });
    expect(allowed).toEqual([]);
  });

  it('default policy hides confirm-tier tools even if they are safe', () => {
    // SAGE's permission model uses `permission:'confirm'` for any write-class
    // tool, regardless of risk tier. The MCP policy respects that by keeping
    // confirm tools hidden until --writable opts in. The MCP client owns
    // user-facing confirmation gestures, so we don't pre-approve.
    const tools: Tool[] = [
      makeTool({ name: 'safe_confirm', permission: 'confirm', riskTier: 'safe' }),
    ];
    const allowed = selectAllowedTools(tools); // no --writable
    expect(allowed).toEqual([]);
  });

  it('--writable exposes confirm-tier safe and standard tools', () => {
    const tools: Tool[] = [
      makeTool({ name: 'confirm_safe', permission: 'confirm', riskTier: 'safe' }),
      makeTool({ name: 'confirm_standard', permission: 'confirm', riskTier: 'standard' }),
    ];
    const allowed = selectAllowedTools(tools, { writable: true });
    expect(allowed.map((entry) => entry.name).sort()).toEqual(['confirm_safe', 'confirm_standard']);
  });

  it('refuses destructive-tier tools unconditionally', () => {
    const tools: Tool[] = [makeTool({ name: 'nuke', permission: 'auto', riskTier: 'destructive' })];
    const allowed = selectAllowedTools(tools, { writable: true });
    expect(allowed).toEqual([]);
  });

  it('refuses destructive-tier confirm tools unconditionally (even with --writable)', () => {
    const tools: Tool[] = [
      makeTool({ name: 'nuke_confirm', permission: 'confirm', riskTier: 'destructive' }),
    ];
    const allowed = selectAllowedTools(tools, { writable: true });
    expect(allowed).toEqual([]);
  });

  it('proposals: exposes memory_candidates narrowed to list/propose, not with writable', () => {
    const tools: Tool[] = [
      makeTool({ name: 'memory_search' }),
      makeTool({ name: 'memory_candidates', permission: 'confirm', riskTier: 'standard' }),
    ];
    const proposals = selectAllowedTools(tools, { proposals: true });
    expect(proposals.map((entry) => entry.name)).toEqual(['memory_search', 'memory_candidates']);
    expect(proposals[1]!.tool).not.toBe(tools[1]);

    const writable = selectAllowedTools(tools, { proposals: true, writable: true });
    expect(writable[1]!.tool).toBe(tools[1]);
    expect(selectAllowedTools(tools).map((entry) => entry.name)).toEqual(['memory_search']);
  });
});

describe('proposalOnlyCandidatesTool', () => {
  const execute = vi.fn(async (input: Record<string, unknown>) => input);
  const inner = makeTool({
    name: 'memory_candidates',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['list', 'accept', 'propose', 'resolve'] } },
    },
    validate: () => [],
    execute: execute as never,
  });

  it('refuses review actions even when the schema is bypassed', async () => {
    const tool = proposalOnlyCandidatesTool(inner, 'claude-code');
    expect(await tool.validate!({ action: 'resolve' } as never)).toEqual([
      'action "resolve" is not available over MCP; use list or propose.',
    ]);
    expect(await tool.validate!({ action: 'propose', text: 't' } as never)).toEqual([]);
    expect(
      (tool.inputSchema as { properties: Record<string, { enum: string[] }> }).properties['action']!
        .enum,
    ).toEqual(['list', 'propose']);
  });

  it('stamps the origin on a proposal and passes list through untouched', async () => {
    const tool = proposalOnlyCandidatesTool(inner, 'codex');
    await tool.execute(
      { action: 'propose', text: 't', reason: 'saw it twice' } as never,
      {} as never,
      undefined as never,
    );
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: 'Proposed by codex over MCP: saw it twice' }),
      {},
      undefined,
    );
    await tool.execute({ action: 'list' } as never, {} as never, undefined as never);
    expect(execute).toHaveBeenLastCalledWith({ action: 'list' }, {}, undefined);

    // S17-M2: trims whitespace around reason
    await tool.execute(
      { action: 'propose', text: 't', reason: '  padded reason  ' } as never,
      {} as never,
      undefined as never,
    );
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: 'Proposed by codex over MCP: padded reason' }),
      {},
      undefined,
    );

    // S17-M1: passes propose through untouched when origin is omitted
    const noOriginTool = proposalOnlyCandidatesTool(inner);
    await noOriginTool.execute(
      { action: 'propose', text: 't', reason: 'keep raw' } as never,
      {} as never,
      undefined as never,
    );
    expect(execute).toHaveBeenLastCalledWith(
      { action: 'propose', text: 't', reason: 'keep raw' },
      {},
      undefined,
    );
  });
});
