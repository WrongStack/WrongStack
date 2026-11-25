import type { AgentContext } from '@wrongstack/contracts/types/context';
import { describe, expect, it } from 'vitest';
import { SlashCommandRegistry } from '../../src/registry/slash-command-registry.js';

describe('SlashCommandRegistry whitespace dispatch', () => {
  it('splits command names on tabs and newlines as well as spaces', async () => {
    const reg = new SlashCommandRegistry();
    reg.register({
      name: 'echo',
      description: 'echo',
      run: async (args) => ({ message: `ok:${args}` }),
    });
    expect((await reg.dispatch('/echo\thello', {} as AgentContext))?.message).toBe('ok:hello');
    expect((await reg.dispatch('/echo\nworld', {} as AgentContext))?.message).toBe('ok:world');
  });
});
