import { describe, expect, it } from 'vitest';
import { rememberTurnState } from '../src/openai-codex-turn-state.js';

describe('rememberTurnState blank header guard (F2252)', () => {
  it('ignores whitespace-only turn state values and trims valid values', () => {
    const turnState = new Map<string, string>();
    const host = {
      turnState,
      turnStateKey: () => 'sess-1',
    } as unknown as Parameters<typeof rememberTurnState>[0];

    rememberTurnState(host, { messages: [{ role: 'user', content: 'hi' }] } as never, '   ');
    expect(turnState.size).toBe(0);

    rememberTurnState(host, { messages: [{ role: 'user', content: 'hi' }] } as never, ' tok-1 ');
    expect(turnState.get('sess-1')).toBe('tok-1');
  });
});
