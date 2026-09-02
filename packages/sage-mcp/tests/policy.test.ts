import { describe, expect, it } from 'vitest';
import type { Tool } from '@wrongstack/core/types';
import { selectAllowedTools } from '../src/policy.js';

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
});
