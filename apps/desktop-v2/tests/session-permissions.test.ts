import { describe, expect, it } from 'vitest';
import { parseSessionRules, permissionRuleArgs } from '../src/session-permission-model';

describe('session permission rules', () => {
  it('reads the rows of /permissions’ listing, with or without a pattern', () => {
    const text = [
      'Session rules (this session only):',
      '  1. deny bash rm -rf*',
      '  2. allow read (any input)',
      '  3. allow mcp__github__* src/**/*.ts',
    ].join('\n');
    expect(parseSessionRules(text)).toEqual([
      { n: 1, effect: 'deny', tool: 'bash', pattern: 'rm -rf*' },
      { n: 2, effect: 'allow', tool: 'read' },
      { n: 3, effect: 'allow', tool: 'mcp__github__*', pattern: 'src/**/*.ts' },
    ]);
  });

  it('reads no rows from the empty listing or from a message', () => {
    expect(
      parseSessionRules('No session rules. Add one with /permissions allow|deny <tool> [pattern].'),
    ).toEqual([]);
    expect(
      parseSessionRules('Session rule added: allow read src/*. It holds for this session only.'),
    ).toEqual([]);
    expect(parseSessionRules('')).toEqual([]);
  });

  it('builds the arguments that add a rule', () => {
    expect(permissionRuleArgs('deny', 'bash', 'rm -rf*')).toBe('deny bash rm -rf*');
    expect(permissionRuleArgs('allow', ' read ', '  ')).toBe('allow read');
    expect(permissionRuleArgs('allow', 'mcp__github__*', 'src/*')).toBe(
      'allow mcp__github__* src/*',
    );
  });

  it('refuses a tool that is not a name or a glob, and a pattern with a line break', () => {
    for (const tool of ['', ' ', 'two words', '-flag', 'a;b']) {
      expect(permissionRuleArgs('allow', tool, ''), JSON.stringify(tool)).toBeUndefined();
    }
    expect(permissionRuleArgs('deny', 'bash', 'a\nb')).toBeUndefined();
  });
});
