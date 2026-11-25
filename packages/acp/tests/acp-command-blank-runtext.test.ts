import type { Agent } from '@wrongstack/core/agent';
import { describe, expect, it } from 'vitest';
import type { RunTurnInput } from '../src/agent/protocol-handler.js';
import { runPromptCommand } from '../src/agent/server-agent-commands.js';

describe('runPromptCommand (F2190)', () => {
  it('ignores whitespace-only runText instead of starting a blank follow-up turn', async () => {
    const blank = await runPromptCommand(
      async () => ({ message: 'done', runText: '   ' }),
      {} as unknown as Agent,
      { sessionId: 's1', prompt: [{ type: 'text', text: '/status' }] } as unknown as RunTurnInput,
      { signal: new AbortController().signal, emit: () => {} },
    );
    expect(blank.kind).toBe('done');

    const real = await runPromptCommand(
      async () => ({ message: 'done', runText: 'follow up' }),
      {} as unknown as Agent,
      { sessionId: 's1', prompt: [{ type: 'text', text: '/status' }] } as unknown as RunTurnInput,
      { signal: new AbortController().signal, emit: () => {} },
    );
    expect(real.kind).toBe('continue');
  });
});
