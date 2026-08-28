import { describe, expect, it } from 'vitest';
import { Context } from '../../src/core/context.js';
import {
  buildSessionNoteBlock,
  consumeSessionNotes,
  enqueueSessionNote,
  pendingSessionNoteCount,
} from '../../src/core/session-notes.js';
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

function makeCtx(): Context {
  return new Context({
    systemPrompt: [],
    provider: null as never,
    session: makeWriter('x'),
    signal: new AbortController().signal,
    tokenCounter: { account: () => {} } as never,
    cwd: '/tmp',
    projectRoot: '/tmp',
    model: 'test',
  });
}

describe('enqueueSessionNote', () => {
  it('queues a note and consume drains FIFO', () => {
    const ctx = makeCtx();
    expect(pendingSessionNoteCount(ctx)).toBe(0);
    expect(
      enqueueSessionNote(ctx, { from: 'explore-companion', kind: 'result', body: 'file.ts:1' }),
    ).toBe(1);
    enqueueSessionNote(ctx, { from: 'worker', kind: 'note', body: 'second', subject: 'fyi' });
    expect(pendingSessionNoteCount(ctx)).toBe(2);
    const notes = consumeSessionNotes(ctx);
    expect(notes.map((n) => n.body)).toEqual(['file.ts:1', 'second']);
    expect(consumeSessionNotes(ctx)).toEqual([]);
  });

  it('ignores blank bodies', () => {
    const ctx = makeCtx();
    expect(enqueueSessionNote(ctx, { from: 'a', kind: 'note', body: '  ' })).toBe(0);
  });
});

describe('buildSessionNoteBlock', () => {
  it('labels kind and sender without user-/btw framing', () => {
    const text = buildSessionNoteBlock([
      {
        from: 'explore-companion',
        kind: 'result',
        body: 'src/a.ts:10 — spawn',
        subject: '[explore]',
      },
    ]);
    expect(text).toMatch(/SESSION RESULT from explore-companion/);
    expect(text).toMatch(/\[explore\]/);
    expect(text).toContain('src/a.ts:10 — spawn');
    expect(text).not.toMatch(/the user added this/i);
  });
});
