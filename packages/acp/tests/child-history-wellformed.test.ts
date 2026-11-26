import { describe, expect, it } from 'vitest';
import { readChildHistory, rememberChildUpdate } from '../src/agent/protocol-child-history.js';
import type { SessionState } from '../src/agent/protocol-contract.js';

const ROCKET = '\u{1F680}';

/**
 * F2632: child titles, descriptions and retained text are truncated with plain
 * `.slice`. A cut between the two units of an astral character leaves a lone
 * surrogate, and the value travels in an ACP JSON-RPC frame — the failure
 * `server-agent-commands.ts` already walks back for ("strict client JSON/UTF-8
 * parsers reject such a frame outright").
 */
describe('ACP child history truncation keeps valid UTF-16 (F2632)', () => {
  it('never splits the title or description', () => {
    const [entry] = readChildHistory(
      [
        {
          id: 'child-1',
          title: `${'t'.repeat(299)}${ROCKET}`,
          description: `${'d'.repeat(999)}${ROCKET}`,
        },
      ],
      'root',
    );

    expect(entry?.title).toBeDefined();
    expect(entry?.title?.isWellFormed()).toBe(true);
    expect(entry?.title).toBe('t'.repeat(299));
    expect(entry?.description?.isWellFormed()).toBe(true);
    expect(entry?.description).toBe('d'.repeat(999));
  });

  it('never starts retained text on the low half of a pair', () => {
    const state = { id: 'root', childHistory: [] } as unknown as SessionState;
    rememberChildUpdate(
      state,
      { sessionUpdate: 'subagent_update', sessionId: 'child-2', title: 'child' },
      undefined,
    );
    rememberChildUpdate(
      state,
      {
        sessionUpdate: 'agent_message_chunk',
        sessionId: 'child-2',
        content: { type: 'text', text: `${ROCKET}${'x'.repeat(3999)}` },
      },
      'child-2',
    );

    const stored = state.childHistory?.[0]?.text ?? '';
    expect(stored.isWellFormed()).toBe(true);
    expect(stored.startsWith(ROCKET)).toBe(false);
    expect(stored).toBe('x'.repeat(3999));
  });

  it('keeps updates that fit untouched (control)', () => {
    const state = { id: 'root', childHistory: [] } as unknown as SessionState;
    rememberChildUpdate(
      state,
      {
        sessionUpdate: 'subagent_update',
        sessionId: 'child-3',
        title: 'plain',
        description: 'plain',
      },
      undefined,
    );
    expect(state.childHistory?.[0]?.title).toBe('plain');
    expect(state.childHistory?.[0]?.description).toBe('plain');
  });
});
