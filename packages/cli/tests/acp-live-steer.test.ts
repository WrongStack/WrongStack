import type { SubagentRunContext, TaskSpec } from '@wrongstack/contracts/types';
import { SessionNoteHub } from '@wrongstack/core/coordination';
import { describe, expect, it, vi } from 'vitest';
import { registerAcpSteerInbox, steerMessage } from '../src/fleet/acp-live-steer.js';

const task: TaskSpec = { id: 't-1', description: 'fix it' };
const ctx = (sessionId?: string) =>
  ({
    subagentId: 'w-123',
    config: { id: 'w-123', name: 'claude-code', role: 'claude-code' },
    ...(sessionId ? { sessionId } : {}),
  }) as unknown as SubagentRunContext;

const flush = () => new Promise((r) => setImmediate(r));

describe('registerAcpSteerInbox', () => {
  it("turns the leader's session_note into a steer of the running turn", async () => {
    const hub = new SessionNoteHub();
    const steer = vi.fn(async () => 'injected' as const);
    const off = registerAcpSteerInbox(ctx('sess-1'), task, steer, hub);
    expect(off).toBeTypeOf('function');

    const post = (to: string) =>
      hub.post({
        sessionId: 'sess-1',
        from: 'leader@ab12',
        to,
        kind: 'steer',
        subject: 'scope',
        body: 'Leave checkout.ts alone.',
      }).delivered;
    expect(post('w-123')).toBe(1);
    expect(post('claude-code')).toBe(1);
    expect(steer).toHaveBeenCalledWith(
      '[WrongStack steer from leader@ab12 — scope]\nLeave checkout.ts alone.',
    );

    off?.();
    expect(post('w-123')).toBe(0);
  });

  it('reports a note the turn could not take', async () => {
    const hub = new SessionNoteHub();
    const undelivered = vi.fn();
    registerAcpSteerInbox(ctx('sess-1'), task, async () => 'promptRequired', hub, undelivered);
    registerAcpSteerInbox(
      { ...ctx('sess-1'), subagentId: 'w-2' } as SubagentRunContext,
      task,
      async () => {
        throw new Error('session ended');
      },
      hub,
      undelivered,
    );
    hub.post({ sessionId: 'sess-1', from: 'leader', to: 'w-123', kind: 'note', body: 'a' });
    hub.post({ sessionId: 'sess-1', from: 'leader', to: 'w-2', kind: 'note', body: 'b' });
    await flush();
    expect(undelivered.mock.calls).toEqual([['promptRequired'], ['session ended']]);
  });

  it('does nothing without a delegating session', () => {
    const hub = new SessionNoteHub();
    expect(registerAcpSteerInbox(ctx(), task, vi.fn(), hub)).toBeUndefined();
  });
});

describe('steerMessage', () => {
  it('names the sender and kind, without a subject when there is none', () => {
    expect(steerMessage({ from: 'leader', kind: 'ask', body: 'Status?' })).toBe(
      '[WrongStack ask from leader]\nStatus?',
    );
  });
});
