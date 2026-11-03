import type { Tool } from '@wrongstack/contracts/types';
import { toolContractIssues } from '@wrongstack/core/registry';
import { describe, expect, it } from 'vitest';
import { builtinTools } from '../src/builtin.js';

describe('built-in tool contract gate', () => {
  it('requires confirmation metadata for high-impact capabilities and destructive tools', () => {
    for (const tool of builtinTools) expect(toolContractIssues(tool), tool.name).toEqual([]);
  });

  it.each([
    'shell.arbitrary',
    'shell.exec',
    'fs.write',
    'fs.write.outside-project',
    'coordination.fleet.emit',
  ])('detects auto permission on %s even when mutating was misdeclared', (capability) => {
    const fixture = {
      ...builtinTools[0]!,
      permission: 'auto',
      mutating: false,
      capabilities: [capability],
    } as Tool;
    expect(toolContractIssues(fixture)).toContain('AUTO_HIGH_IMPACT');
    expect(toolContractIssues({ ...fixture, permission: 'confirm' })).toEqual([]);
  });

  it('does not confuse fleet reads with fleet mutations', () => {
    expect(
      toolContractIssues({ ...builtinTools[0]!, capabilities: ['coordination.fleet.read'] }),
    ).toEqual([]);
  });
  it('requires review of auto mutations even without a high-impact capability declaration', () => {
    expect(
      toolContractIssues({
        ...builtinTools[0]!,
        permission: 'auto',
        mutating: true,
        capabilities: ['session.rename'],
      }),
    ).toContain('AUTO_MUTATION_REQUIRES_REVIEW');
  });
});
