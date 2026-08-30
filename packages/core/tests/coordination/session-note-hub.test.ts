import { describe, expect, it } from 'vitest';
import { SessionNoteHub } from '../../src/coordination/session-note-hub.js';
import { makeSessionNoteTool } from '../../src/coordination/session-note-tool.js';
import { Context } from '../../src/core/context.js';
import { consumeSessionNotes, enqueueSessionNote } from '../../src/core/session-notes.js';
import { EventBus } from '../../src/kernel/events.js';
import type { SessionWriter } from '../../src/types/session.js';

function makeWriter(id: string): SessionWriter {
  return {
    id,
    pendingToolUses: [],
    append: async () => {},
    appendBatch: async () => {},
    flush: async () => {},
    close: async () => {},
    recordFileChange: () => {},
    recordSideEffect: () => {},
    writeCheckpoint: async () => {},
    writeFileSnapshot: async () => {},
    truncateToCheckpoint: async () => 0,
    clearSession: async () => {},
    writeInFlightMarker: async () => {},
    clearInFlightMarker: async () => {},
  };
}

function makeCtx(id: string, sessionId = 'sess-1'): Context {
  return new Context({
    systemPrompt: [],
    provider: null as never,
    session: makeWriter(sessionId),
    signal: new AbortController().signal,
    tokenCounter: { account: () => {} } as never,
    cwd: '/tmp',
    projectRoot: '/tmp',
    model: 'test',
    agentId: id,
  });
}

describe('SessionNoteHub', () => {
  it('delivers to the leader alias in the same session only', () => {
    const hub = new SessionNoteHub();
    const leader = makeCtx('leader');
    const other = makeCtx('leader', 'sess-other');
    hub.register({
      sessionId: 'sess-1',
      agentId: 'leader',
      aliases: ['leader'],
      deliver: (n) => enqueueSessionNote(leader, n),
    });
    hub.register({
      sessionId: 'sess-other',
      agentId: 'leader',
      aliases: ['leader'],
      deliver: (n) => enqueueSessionNote(other, n),
    });

    const result = hub.post({
      sessionId: 'sess-1',
      from: 'explore-companion-abc',
      to: 'leader',
      kind: 'result',
      body: 'found it',
      subject: '[explore]',
    });
    expect(result.delivered).toBe(1);
    expect(consumeSessionNotes(leader).map((n) => n.body)).toEqual(['found it']);
    expect(consumeSessionNotes(other)).toEqual([]);
  });

  it('does not echo a note back to its sender', () => {
    const hub = new SessionNoteHub();
    const worker = makeCtx('worker-1');
    hub.register({
      sessionId: 'sess-1',
      agentId: 'worker-1',
      deliver: (n) => enqueueSessionNote(worker, n),
    });
    expect(
      hub.post({
        sessionId: 'sess-1',
        from: 'worker-1',
        to: 'worker-1',
        kind: 'note',
        body: 'loop',
      }).delivered,
    ).toBe(0);
    expect(consumeSessionNotes(worker)).toEqual([]);
  });

  it('broadcasts @session to every other live inbox', () => {
    const hub = new SessionNoteHub();
    const leader = makeCtx('leader');
    const worker = makeCtx('worker-1');
    hub.register({
      sessionId: 'sess-1',
      agentId: 'leader',
      aliases: ['leader'],
      deliver: (n) => enqueueSessionNote(leader, n),
    });
    hub.register({
      sessionId: 'sess-1',
      agentId: 'worker-1',
      deliver: (n) => enqueueSessionNote(worker, n),
    });
    expect(
      hub.post({
        sessionId: 'sess-1',
        from: 'leader',
        to: '@session',
        kind: 'steer',
        body: 'pause the probe',
      }).delivered,
    ).toBe(1);
    expect(consumeSessionNotes(worker)[0]?.body).toBe('pause the probe');
    expect(consumeSessionNotes(leader)).toEqual([]);
  });

  it('emits session.note for observers', () => {
    const hub = new SessionNoteHub();
    const events = new EventBus();
    const seen: string[] = [];
    events.on('session.note', (e) => seen.push(`${e.to}:${e.body}`));
    hub.post({
      sessionId: 'sess-1',
      from: 'a',
      to: 'leader',
      kind: 'note',
      body: 'hi',
      events,
    });
    expect(seen).toEqual(['leader:hi']);
  });

  it('drops the cached session bus once the last contributing inbox unregisters', () => {
    const hub = new SessionNoteHub();
    const firstBus = new EventBus();
    const secondBus = new EventBus();
    const firstSeen: string[] = [];
    const secondSeen: string[] = [];
    firstBus.on('session.note', (e) => firstSeen.push(e.body));
    secondBus.on('session.note', (e) => secondSeen.push(e.body));

    const offFirst = hub.register({
      sessionId: 'sess-1',
      agentId: 'leader',
      events: firstBus,
      deliver: () => {},
    });
    const offSecond = hub.register({
      sessionId: 'sess-1',
      agentId: 'worker-1',
      events: secondBus,
      deliver: () => {},
    });

    // First-wins: the first contributor's bus carries session.note.
    hub.post({ sessionId: 'sess-1', from: 'a', to: 'worker-1', kind: 'note', body: 'one' });
    expect(firstSeen).toEqual(['one']);

    // While another contributor is live, the cached bus must survive.
    offFirst();
    hub.post({ sessionId: 'sess-1', from: 'a', to: 'worker-1', kind: 'note', body: 'two' });
    expect(firstSeen).toEqual(['one', 'two']);

    // After the last contributor unregisters the cached bus is dropped — no
    // zombie emissions on a torn-down agent's bus.
    offSecond();
    hub.post({ sessionId: 'sess-1', from: 'a', to: 'worker-1', kind: 'note', body: 'three' });
    expect(firstSeen).toEqual(['one', 'two']);
    expect(secondSeen).toEqual([]);

    // A later live inbox re-primes the cache with its own bus.
    const thirdBus = new EventBus();
    const thirdSeen: string[] = [];
    thirdBus.on('session.note', (e) => thirdSeen.push(e.body));
    const offThird = hub.register({
      sessionId: 'sess-1',
      agentId: 'leader-2',
      events: thirdBus,
      deliver: () => {},
    });
    hub.post({ sessionId: 'sess-1', from: 'a', to: 'leader-2', kind: 'note', body: 'four' });
    expect(thirdSeen).toEqual(['four']);
    expect(firstSeen).toEqual(['one', 'two']);
    offThird();
  });

  it('treats a disposer as single-use so a repeated call cannot drop a live bus', () => {
    const hub = new SessionNoteHub();
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('session.note', (e) => seen.push(e.body));
    const offA = hub.register({ sessionId: 'sess-1', agentId: 'a', events: bus, deliver: () => {} });
    const offB = hub.register({ sessionId: 'sess-1', agentId: 'b', events: bus, deliver: () => {} });

    offA();
    offA(); // Second call must not decrement the ref count again.
    hub.post({ sessionId: 'sess-1', from: 'x', to: 'b', kind: 'note', body: 'still live' });
    expect(seen).toEqual(['still live']);

    offB();
    hub.post({ sessionId: 'sess-1', from: 'x', to: 'b', kind: 'note', body: 'after last' });
    expect(seen).toEqual(['still live']);
  });
});

describe('session_note tool', () => {
  it('posts onto the process hub', async () => {
    const { sessionNoteHub } = await import('../../src/coordination/session-note-hub.js');
    const leader = makeCtx('leader');
    const off = sessionNoteHub.register({
      sessionId: 'sess-1',
      agentId: 'leader',
      aliases: ['leader'],
      deliver: (n) => enqueueSessionNote(leader, n),
    });
    const tool = makeSessionNoteTool();
    const worker = makeCtx('worker-1');
    const out = (await tool.execute(
      { to: 'leader', kind: 'result', body: 'map src/a.ts' },
      worker,
      { signal: new AbortController().signal },
    )) as { ok: boolean; delivered: number };
    expect(out.ok).toBe(true);
    expect(out.delivered).toBe(1);
    expect(consumeSessionNotes(leader)[0]?.body).toBe('map src/a.ts');
    off();
  });
});
