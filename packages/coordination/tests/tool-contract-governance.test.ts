import { toolContractIssues } from '@wrongstack/core/registry';
import { describe, expect, it } from 'vitest';
import { buildDirectorToolset } from '../src/director/director-toolset.js';

describe('Director tool safety declarations', () => {
  // Construction only: no Director operation is called by these real factories.
  const tools = buildDirectorToolset({} as Parameters<typeof buildDirectorToolset>[0]);

  it('checks the whole Director registry with a bounded fleet-event exception', () => {
    for (const tool of tools) {
      if (tool.name === 'fleet_emit') {
        // Reviewed exception: attributed, schema-checked in-process events.
        // This grants no filesystem/command power; downstream calls keep their own gates.
        expect(tool.capabilities).toEqual(['coordination.fleet.emit']);
        expect(tool.mutating).toBe(false);
        expect(toolContractIssues(tool)).toEqual(['AUTO_HIGH_IMPACT']);
      } else expect(toolContractIssues(tool), tool.name).toEqual([]);
      if (tool.permission === 'confirm' || tool.mutating)
        expect(tool.usageHint?.trim(), tool.name).toBeTruthy();
    }
  });

  it('declares mutation testing as workspace mutation and command execution', () => {
    const tool = tools.find((t) => t.name === 'mutation_test')!;
    expect(tool.permission).toBe('confirm');
    expect(tool.mutating).toBe(true);
    expect(tool.capabilities).toEqual(
      expect.arrayContaining(['fs.write', 'shell.arbitrary', 'subagent.spawn']),
    );
    expect(tool.cost).toMatchObject({ kind: 'paid', fanOut: true });
  });

  it('requires explicit confirmation metadata for fleet-wide termination', () => {
    const tool = tools.find((t) => t.name === 'terminate_all')!;
    expect(tool.permission).toBe('confirm');
    expect(tool.riskTier).toBe('destructive');
    expect(tool.usageHint).toMatch(/all|fleet/i);
  });

  it('documents all tools created by the production Director toolset', () => {
    for (const tool of tools) expect(tool.description.trim(), tool.name).not.toBe('');
  });
});
