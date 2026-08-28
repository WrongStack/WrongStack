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
