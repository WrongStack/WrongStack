import { describe, expect, it } from 'vitest';
import {
  coalesceTextDeltas,
  type EngineEvent,
  emptyEngineState,
  reduceEngine,
  replayEngineBatch,
} from '../src/engine-state';

/** A journal of turns with streamed answers, tools, reasoning and another stream between. */
function journal(turns: number): EngineEvent[] {
  const events: EngineEvent[] = [{ type: 'session.start', payload: { sessionId: 's' }, at: 1 }];
  let at = 10;
  for (let t = 0; t < turns; t++) {
    events.push({ type: 'desktop.user_message', payload: { id: `u${t}`, content: `q${t}` }, at });
    at += 1;
    for (let d = 0; d < 6; d++) {
      events.push({
        type: 'provider.text_delta',
        payload: { messageId: `m${t}`, text: `part ${d}. ` },
        // Some frames carry no time.
        ...(d % 3 ? { at: at++ } : {}),
      });
      if (t % 2 && d === 2)
        events.push({ type: 'provider.text_delta', payload: { messageId: `x${t}`, text: 'side' } });
    }
    events.push({
      type: 'tool.started',
      payload: { id: `t${t}`, name: 'read', input: {} },
      at: at++,
    });
    events.push({ type: 'provider.thinking_delta', payload: { text: 'hmm' }, at: at++ });
    events.push({ type: 'provider.text_delta', payload: { messageId: `m${t}`, text: 'after' } });
    events.push({ type: 'provider.text_delta', payload: { messageId: `m${t}`, text: ' tools' } });
    events.push({ type: 'run.result', payload: { status: 'done', finalText: 'x' }, at: at++ });
  }
  return events;
}

describe('replaying streamed answer text', () => {
  it('joins consecutive deltas of one stream and keeps everything else apart', () => {
    const joined = coalesceTextDeltas([
      { type: 'provider.text_delta', payload: { messageId: 'a', text: 'Hel' }, at: 5 },
      { type: 'provider.text_delta', payload: { messageId: 'a', text: 'lo' } },
      { type: 'provider.text_delta', payload: { messageId: 'a', text: '!' }, at: 9 },
      { type: 'provider.text_delta', payload: { messageId: 'b', text: 'x' } },
      { type: 'tool.started', payload: { id: 't' } },
      { type: 'provider.text_delta', payload: { messageId: 'b', text: 'y' } },
    ]);
    expect(joined).toEqual([
      {
        event: { type: 'provider.text_delta', payload: { messageId: 'a', text: 'Hello!' }, at: 5 },
        lastAt: 9,
      },
      { event: { type: 'provider.text_delta', payload: { messageId: 'b', text: 'x' } } },
      { event: { type: 'tool.started', payload: { id: 't' } } },
      { event: { type: 'provider.text_delta', payload: { messageId: 'b', text: 'y' } } },
    ]);
  });

  it('reads a journal page to the same conversation as frame by frame', () => {
    const events = journal(12);
    const start = { ...emptyEngineState, hydrating: true, synced: false };
    const single = events.reduce(reduceEngine, start);
    for (const size of [1, 7, 50, events.length]) {
      let paged = start;
      for (let i = 0; i < events.length; i += size)
        paged = replayEngineBatch(paged, events.slice(i, i + size), i + size < events.length);
      expect(paged.messages).toEqual(single.messages);
      expect(paged.lastAt).toBe(single.lastAt);
      expect(paged.running).toBe(single.running);
      expect(paged.activeTextMessageId).toBe(single.activeTextMessageId);
      expect(paged.turnStats).toEqual(single.turnStats);
      expect(paged.activity).toEqual(single.activity);
    }
  });
});
