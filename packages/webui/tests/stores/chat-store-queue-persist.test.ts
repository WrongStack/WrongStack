import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../../src/stores/chat-store';

/**
 * The queue/refinement setters, `removeMessage`/`updateLastUserMessage`, the
 * tool-execution eviction inside `addMessage`, and the persist
 * partialize/onRehydrateStorage hooks — all outside the streaming path the
 * other chat suites drive.
 */

const options = useChatStore.persist.getOptions();

function chat() {
  return useChatStore.getState();
}

beforeEach(() => {
  useChatStore.setState({
    messages: [],
    queue: [],
    executions: new Map(),
    toolMessageIdsByUseId: new Map(),
    refining: false,
    pendingRefinement: null,
    runStart: null,
    thinkingBuffer: '',
    thinkingLogBuffer: '',
    thinkingStartedAt: null,
    currentAssistantMessageId: null,
  });
});

describe('queue', () => {
  it('enqueues in arrival order with the default mode', () => {
    chat().enqueue('first');
    chat().enqueue('second');

    expect(chat().queue.map((q) => q.text)).toEqual(['first', 'second']);
    expect(chat().queue[0]).toMatchObject({ mode: 'queue' });
    expect(typeof chat().queue[0]?.addedAt).toBe('number');
  });

  it('records an explicit mode', () => {
    chat().enqueue('steer me', 'steer');
    expect(chat().queue[0]).toMatchObject({ mode: 'steer' });
  });

  it('attaches images only when there are some', () => {
    chat().enqueue('with', 'queue', [{ id: 'i1', dataUrl: 'data:...' } as never]);
    chat().enqueue('without', 'queue', []);

    expect(chat().queue[0]).toHaveProperty('images');
    expect(chat().queue[1]).not.toHaveProperty('images');
  });

  it('dequeues from the front', () => {
    chat().enqueue('a');
    chat().enqueue('b');

    expect(chat().dequeue()).toMatchObject({ text: 'a' });
    expect(chat().queue.map((q) => q.text)).toEqual(['b']);
  });

  it('returns null when the queue is empty', () => {
    expect(chat().dequeue()).toBeNull();
  });

  it('removes a queued item by index', () => {
    chat().enqueue('a');
    chat().enqueue('b');
    chat().enqueue('c');

    chat().removeQueued(1);
    expect(chat().queue.map((q) => q.text)).toEqual(['a', 'c']);
  });

  it('ignores an out-of-range index', () => {
    chat().enqueue('a');
    chat().removeQueued(9);
    expect(chat().queue).toHaveLength(1);
  });

  it('clears the whole queue', () => {
    chat().enqueue('a');
    chat().clearQueue();
    expect(chat().queue).toEqual([]);
  });
});

describe('refinement', () => {
  it('sets and clears the refining flag', () => {
    chat().setRefining(true);
    expect(chat().refining).toBe(true);
    chat().setRefining(false);
    expect(chat().refining).toBe(false);
  });

  it('stores a pending refinement with its images', () => {
    chat().setPendingRefinement('better prompt', [{ id: 'i1' } as never]);
    expect(chat().pendingRefinement).toMatchObject({ text: 'better prompt' });
    expect(chat().pendingRefinement?.images).toHaveLength(1);
  });

  it('defaults the image list to empty', () => {
    chat().setPendingRefinement('better prompt');
    expect(chat().pendingRefinement?.images).toEqual([]);
  });

  it('clears the pending refinement on a null text', () => {
    chat().setPendingRefinement('x');
    chat().setPendingRefinement(null);
    expect(chat().pendingRefinement).toBeNull();
  });
});

describe('removeMessage', () => {
  it('drops the message and reindexes the tool map', () => {
    chat().addMessage({ role: 'user', content: 'hi' });
    const toolId = chat().addMessage({
      role: 'tool',
      content: 'out',
      toolUseId: 'tu1',
    } as never);

    expect(chat().toolMessageIdsByUseId.get('tu1')).toBe(toolId);
    chat().removeMessage(toolId);

    expect(chat().messages).toHaveLength(1);
    expect(chat().toolMessageIdsByUseId.has('tu1')).toBe(false);
  });

  it('is a no-op for an unknown id', () => {
    chat().addMessage({ role: 'user', content: 'hi' });
    chat().removeMessage('nope');
    expect(chat().messages).toHaveLength(1);
  });
});

describe('updateLastUserMessage', () => {
  it('rewrites the most recent user turn', () => {
    chat().addMessage({ role: 'user', content: 'old' });
    chat().addMessage({ role: 'assistant', content: 'reply' });

    chat().updateLastUserMessage('new');
    expect(chat().messages[0]).toMatchObject({ content: 'new' });
    expect(chat().messages[1]).toMatchObject({ content: 'reply' });
  });

  it('picks the last user turn, not the first', () => {
    chat().addMessage({ role: 'user', content: 'first' });
    chat().addMessage({ role: 'user', content: 'second' });

    chat().updateLastUserMessage('edited');
    expect(chat().messages.map((m) => m.content)).toEqual(['first', 'edited']);
  });

  it('leaves the transcript alone when there is no user turn', () => {
    chat().addMessage({ role: 'assistant', content: 'reply' });
    chat().updateLastUserMessage('edited');
    expect(chat().messages[0]).toMatchObject({ content: 'reply' });
  });
});

describe('tool execution eviction', () => {
  it('drops executions whose tool message the trim window evicted', () => {
    const toolId = chat().addMessage({
      role: 'tool',
      content: 'out',
      toolUseId: 'tu1',
    } as never);
    chat().addExecution({ id: 'tu1', name: 'Read', status: 'completed' } as never);
    expect(chat().executions.size).toBe(1);

    // Removing the tool message unlinks the use id...
    chat().removeMessage(toolId);
    // ...and the next addMessage garbage-collects the orphaned execution.
    chat().addMessage({ role: 'user', content: 'next' });

    expect(chat().executions.size).toBe(0);
  });

  it('keeps an execution whose tool message is still present', () => {
    chat().addMessage({ role: 'tool', content: 'out', toolUseId: 'tu1' } as never);
    chat().addExecution({ id: 'tu1', name: 'Read', status: 'completed' } as never);
    chat().addMessage({ role: 'user', content: 'next' });

    expect(chat().executions.get('tu1')).toMatchObject({ name: 'Read' });
  });
});

describe('appendToolProgressLines', () => {
  it('is a no-op for an empty batch', () => {
    const id = chat().addMessage({ role: 'tool', content: '' });
    const before = chat().messages;
    chat().appendToolProgressLines(id, []);
    expect(chat().messages).toBe(before);
  });

  it('accumulates lines across calls', () => {
    const id = chat().addMessage({ role: 'tool', content: '' });
    chat().appendToolProgressLines(id, ['a']);
    chat().appendToolProgressLines(id, ['b', 'c']);

    expect(chat().messages[0]?.progressLines).toEqual(['a', 'b', 'c']);
  });

  it('ignores an unknown message id', () => {
    const id = chat().addMessage({ role: 'tool', content: '' });
    chat().appendToolProgressLines('nope', ['a']);
    expect(chat().messages[0]?.progressLines).toBeUndefined();
    expect(id).toBeTruthy();
  });
});

describe('thinking buffers', () => {
  it('stamps the start time on the first fragment only', () => {
    chat().appendThinking('one ');
    const started = chat().thinkingStartedAt;
    chat().appendThinking('two');

    expect(chat().thinkingBuffer).toBe('one two');
    expect(chat().thinkingStartedAt).toBe(started);
  });

  it('keeps the log buffer alongside the live buffer', () => {
    chat().appendThinking('abc');
    expect(chat().thinkingLogBuffer).toBe('abc');
  });
});

describe('setRunStart', () => {
  it('writes straight through', () => {
    chat().setRunStart({ at: 1, prompt: 'go' } as never);
    expect(chat().runStart).toMatchObject({ prompt: 'go' });
  });
});

describe('persist partialize (per-lane)', () => {
  const partialize = options.partialize as (s: unknown) => {
    activeSessionId: string;
    lanes: Record<string, { messages: unknown[]; queue: Array<{ images?: unknown }> }>;
  };

  /** One lane's worth of persisted state, in the registry's shape. */
  function lanesOf(lane: Record<string, unknown>, sid = 'sess_a') {
    return {
      activeSessionId: sid,
      lanes: { [sid]: { thinkingLogBuffer: '', messages: [], queue: [], ...lane } },
    };
  }

  it('strips image data urls from persisted attachments', () => {
    const out = partialize(
      lanesOf({
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: 'x',
            attachments: [{ id: 'a', dataUrl: 'data:huge' }],
          },
        ],
      }),
    );

    const attachments = (
      out.lanes.sess_a!.messages as Array<{ attachments: Array<{ dataUrl?: string }> }>
    )[0]!.attachments;
    expect(attachments[0]?.dataUrl).toBeUndefined();
    // The chip metadata survives so the bubble can render a placeholder.
    expect(attachments[0]).toHaveProperty('id', 'a');
  });

  it('leaves a message with no attachments untouched', () => {
    const message = { id: 'm1', role: 'user', content: 'x' };
    const out = partialize(lanesOf({ messages: [message] }));
    expect(out.lanes.sess_a!.messages[0]).toBe(message);
  });

  it('leaves attachments with no data url untouched', () => {
    const message = { id: 'm1', role: 'user', content: 'x', attachments: [{ id: 'a' }] };
    const out = partialize(lanesOf({ messages: [message] }));
    expect(out.lanes.sess_a!.messages[0]).toBe(message);
  });

  it('drops images from queued items', () => {
    const out = partialize(
      lanesOf({ queue: [{ text: 'a', images: [{ id: 'i' }] }, { text: 'b' }] }),
    );
    const queue = out.lanes.sess_a!.queue;
    expect(queue[0]?.images).toBeUndefined();
    expect(queue[1]).not.toHaveProperty('images');
  });

  it('persists only the whitelisted keys, per lane', () => {
    const out = partialize({
      activeSessionId: 'sess_a',
      lanes: {
        sess_a: {
          messages: [],
          queue: [],
          thinkingLogBuffer: 'log',
          executions: new Map(),
          refining: true,
          abortController: new AbortController(),
        },
      },
    });

    expect(Object.keys(out).sort()).toEqual(['activeSessionId', 'lanes']);
    expect(Object.keys(out.lanes.sess_a!).sort()).toEqual([
      'messages',
      'queue',
      'thinkingLogBuffer',
    ]);
  });

  it('keeps every open lane, so a reload restores all four tabs', () => {
    const out = partialize({
      activeSessionId: 'sess_b',
      lanes: {
        sess_a: { messages: [{ id: 'a' }], queue: [], thinkingLogBuffer: '' },
        sess_b: { messages: [{ id: 'b' }], queue: [], thinkingLogBuffer: '' },
        sess_c: { messages: [{ id: 'c' }], queue: [], thinkingLogBuffer: '' },
      },
    });
    expect(Object.keys(out.lanes).sort()).toEqual(['sess_a', 'sess_b', 'sess_c']);
    expect(out.activeSessionId).toBe('sess_b');
  });
});
