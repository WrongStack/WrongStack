import { describe, expect, it } from 'vitest';
import { SessionNoteHub } from '../../src/coordination/session-note-hub.js';

/**
 * A note is routed by SESSION, and the hub never guesses which one.
 *
 * When the fleet host has a `sessionsRoot` (it does in the real CLI — the
 * `fleetRoot` default fills it in), every subagent is given its OWN journal,
 * so `ctx.session.id` names a private transcript rather than the tab. Posting
 * and registering under THAT id put a worker and its leader on two different
 * keys in the same conversation, and nothing was delivered. Both sides now
 * resolve the owning session (`resolveOwningSessionId`, fed by the spawn-time
 * `meta.sessionId` stamp) — see `owning-session-routing.test.ts`.
 *
 * This file pins the hub's own rule, which is unchanged and deliberately
 * strict: route by the id you are given, drop what matches no inbox.
 */

describe('SessionNoteHub routes strictly by session id', () => {
  it('delivers to the leader when both sides name the same session', () => {
    const hub = new SessionNoteHub();
    const got: string[] = [];
    hub.register({
      sessionId: 'tab-1',
      agentId: 'leader',
      aliases: ['leader'],
      deliver: (note) => got.push(note.body),
    });

    const { delivered } = hub.post({
      sessionId: 'tab-1',
      from: 'worker-1',
      to: 'leader',
      kind: 'result',
      body: 'found it at foo.ts:12',
    });

    expect(delivered).toBe(1);
    expect(got).toEqual(['found it at foo.ts:12']);
  });

  it('drops a note whose session matches no inbox — never guesses one', () => {
    const hub = new SessionNoteHub();
    const got: string[] = [];
    hub.register({
      sessionId: 'tab-1',
      agentId: 'leader',
      aliases: ['leader'],
      deliver: (note) => got.push(note.body),
    });

    // Fail-closed by design: mis-delivery is worse than non-delivery. This is
    // what a worker hit before the owning-session stamp existed, and it stays
    // the outcome for any poster that still names a session no inbox is on.
    const { delivered } = hub.post({
      sessionId: 'sub-session-9',
      from: 'worker-1',
      to: 'leader',
      kind: 'result',
      body: 'found it at foo.ts:12',
    });

    expect(delivered).toBe(0);
    expect(got).toEqual([]);
  });

  it('never delivers a note back to its own sender', () => {
    const hub = new SessionNoteHub();
    const got: string[] = [];
    hub.register({
      sessionId: 'tab-1',
      agentId: 'worker-1',
      deliver: (note) => got.push(note.body),
    });

    hub.post({
      sessionId: 'tab-1',
      from: 'worker-1',
      to: '@session',
      kind: 'note',
      body: 'broadcast',
    });

    expect(got).toEqual([]);
  });

  it('survives an inbox registered without an id', () => {
    // Every Agent attaches at construction, including ones built from a
    // partial context. One malformed registration must not throw the whole
    // fan-out before the healthy inboxes are reached.
    const hub = new SessionNoteHub();
    const got: string[] = [];
    hub.register({
      sessionId: 'tab-1',
      agentId: undefined as unknown as string,
      deliver: () => undefined,
    });
    hub.register({
      sessionId: 'tab-1',
      agentId: 'leader',
      aliases: ['leader'],
      deliver: (note) => got.push(note.body),
    });

    expect(() =>
      hub.post({ sessionId: 'tab-1', from: 'w', to: 'leader', kind: 'note', body: 'hi' }),
    ).not.toThrow();
    expect(got).toEqual(['hi']);
  });
});
