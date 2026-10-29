import { describe, expect, it, vi } from 'vitest';
import { dispatchComposer, refinementText, sessionEffort } from '../src/composer-model';
import {
  type EngineState,
  emptyEngineState,
  reduceEngine,
  replayEngineBatch,
} from '../src/engine-state';

function fixture(running = false) {
  let state: EngineState = reduceEngine(emptyEngineState, {
    type: 'session.start',
    payload: {
      sessionId: 'native-a',
      provider: 'local',
      model: 'reasoner',
      protocolCapabilities: ['session.prompt-queue', 'session.user-ack'],
    },
  });
  state = { ...state, running };
  const send = vi.fn(async () => {});
  const command = vi.fn(async () => ({}));
  const waitForIdle = vi.fn(async () => {
    state = { ...state, running: false };
  });
  return {
    current: () => state,
    update: (patch: Partial<EngineState>) => {
      state = { ...state, ...patch };
    },
    send,
    command,
    waitForIdle,
  };
}
describe('desktop composer delivery contracts', () => {
  it('carries an approved fresh context only through an idle human turn, including refinement metadata', async () => {
    const ports = fixture();
    ports.update({
      results: {
        ...ports.current().results,
        'session.start': {
          ...ports.current().results['session.start'],
          protocolCapabilities: ['session.user-ack', 'context.topic-boundary'],
        },
      },
    });
    await dispatchComposer(
      'Approved topic after refinement',
      'btw',
      ports,
      'Original new topic',
      [],
      true,
    );
    expect(ports.command).toHaveBeenCalledWith(
      'user_message',
      expect.objectContaining({ freshContext: true, journalRaw: 'Original new topic' }),
      ['key.operation_result'],
    );
    const unsupported = fixture();
    await expect(
      dispatchComposer('new topic', 'btw', unsupported, undefined, [], true),
    ).rejects.toThrow('supporting engine');
    expect(unsupported.command).not.toHaveBeenCalled();
    for (const mode of ['queue', 'steer', 'btw'] as const) {
      const busy = fixture(true);
      await expect(dispatchComposer('new topic', mode, busy, undefined, [], true)).rejects.toThrow(
        'idle conversation',
      );
      expect(busy.send).not.toHaveBeenCalled();
      expect(busy.command).not.toHaveBeenCalled();
    }
  });
  it('preserves binary attachments through direct, queued and reviewed steering submissions', async () => {
    const images = [{ data: 'iVBORw0KGgo=', mediaType: 'image/png', name: 'screen.png' }];
    for (const mode of ['btw', 'queue', 'steer'] as const) {
      const ports = fixture(mode === 'steer');
      await dispatchComposer('Reviewed final text', mode, ports, 'Original text', images);
      expect(ports.command).toHaveBeenCalledWith(
        mode === 'queue' ? 'queue.add' : 'user_message',
        expect.objectContaining({ images, journalRaw: 'Original text' }),
        [mode === 'queue' ? 'queue.state' : 'key.operation_result'],
      );
    }
  });
  it('queues a busy image-aware BTW rather than delivering filenames through text-only mailbox', async () => {
    const ports = fixture(true);
    const images = [{ data: 'iVBORw0KGgo=', mediaType: 'image/png' }];
    await dispatchComposer('', 'btw', ports, undefined, images);
    expect(ports.command).toHaveBeenCalledExactlyOnceWith('queue.add', { text: '', images }, [
      'queue.state',
    ]);
    expect(ports.send).not.toHaveBeenCalled();
  });
  it('refuses bad attachments before stopping an active turn', async () => {
    const ports = fixture(true);
    await expect(
      dispatchComposer('Steer', 'steer', ports, undefined, [
        { data: 'bad!', mediaType: 'image/png' },
      ]),
    ).rejects.toThrow('invalid');
    expect(ports.send).not.toHaveBeenCalled();
    expect(ports.command).not.toHaveBeenCalled();
  });
  it('does not discard files into an unacknowledged legacy direct submission', async () => {
    const ports = fixture(true);
    ports.update({ results: { 'session.start': { protocolCapabilities: [] } } });
    await expect(
      dispatchComposer('Steer', 'steer', ports, undefined, [
        { data: 'iVBORw0KGgo=', mediaType: 'image/png' },
      ]),
    ).rejects.toThrow('cannot confirm file acceptance');
    expect(ports.send).not.toHaveBeenCalled();
  });
  it('does not turn a normal prompt into BTW while replaying a partial old journal page', async () => {
    const ports = fixture();
    const partial = replayEngineBatch(
      ports.current(),
      [
        {
          type: 'desktop.user_message',
          payload: { id: 'old', content: 'Historical running turn' },
        },
      ],
      true,
    );
    ports.update(partial);
    await expect(dispatchComposer('New human prompt', 'btw', ports)).rejects.toThrow(
      'history is still syncing',
    );
    expect(ports.command).not.toHaveBeenCalled();
    ports.update(
      replayEngineBatch(partial, [{ type: 'run.result', payload: { status: 'done' } }], false),
    );
    await dispatchComposer('New human prompt', 'btw', ports);
    expect(ports.command).toHaveBeenCalledExactlyOnceWith(
      'user_message',
      expect.objectContaining({ content: 'New human prompt' }),
      ['key.operation_result'],
    );
  });
  it('keeps normal human messages on the direct user turn path with an acknowledgement', async () => {
    const ports = fixture();
    await dispatchComposer('A new human instruction', 'btw', ports);
    expect(ports.command).toHaveBeenCalledExactlyOnceWith(
      'user_message',
      expect.objectContaining({ content: 'A new human instruction', id: expect.any(String) }),
      ['key.operation_result'],
    );
    expect(ports.send).not.toHaveBeenCalled();
  });
  it('keeps an approved refinement original with the engine-owned queued prompt', async () => {
    const ports = fixture();
    await dispatchComposer('Approved refined text', 'queue', ports, 'Original user text');
    expect(ports.command).toHaveBeenCalledExactlyOnceWith(
      'queue.add',
      { text: 'Approved refined text', journalRaw: 'Original user text' },
      ['queue.state'],
    );
  });
  it('sends a running BTW through the session mailbox without interrupting or starting a turn', async () => {
    const ports = fixture(true);
    await dispatchComposer('  Keep the API stable.  ', 'btw', ports);
    expect(ports.command).toHaveBeenCalledExactlyOnceWith(
      'mailbox.send',
      expect.objectContaining({
        to: 'leader',
        type: 'btw',
        body: 'Keep the API stable.',
      }),
      ['mailbox.sent'],
    );
    expect(ports.send).not.toHaveBeenCalled();
    expect(ports.waitForIdle).not.toHaveBeenCalled();
  });
  it('hands queue ownership to the engine while busy and while idle', async () => {
    for (const busy of [true, false]) {
      const ports = fixture(busy);
      await dispatchComposer('Next task', 'queue', ports);
      expect(ports.command).toHaveBeenCalledExactlyOnceWith('queue.add', { text: 'Next task' }, [
        'queue.state',
      ]);
      expect(ports.send).not.toHaveBeenCalled();
    }
  });
  it('waits for the actual stop boundary before handing a steering instruction to the engine', async () => {
    const ports = fixture(true);
    const order: string[] = [];
    ports.send.mockImplementation(async () => {
      order.push('abort');
    });
    ports.waitForIdle.mockImplementation(async () => {
      order.push('settled');
      ports.update({ running: false });
    });
    ports.command.mockImplementation(async () => {
      order.push('accepted');
      return {};
    });
    await dispatchComposer('Change direction', 'steer', ports);
    expect(order).toEqual(['abort', 'settled', 'accepted']);
    expect(ports.send).toHaveBeenCalledExactlyOnceWith('abort');
  });
  it('refuses steering over an existing queue on an engine without front placement', async () => {
    const ports = fixture(true);
    ports.update({ queue: [{ id: 'pending', text: 'Keep me', imageCount: 0, addedAt: 1 }] });
    await expect(dispatchComposer('New direction', 'steer', ports)).rejects.toThrow(
      'Remove pending queued prompts',
    );
    expect(ports.send).not.toHaveBeenCalled();
    expect(ports.command).not.toHaveBeenCalled();
  });
  it('places a steering instruction ahead of the queue before stopping the run', async () => {
    const ports = fixture(true);
    const start = ports.current().results['session.start'] ?? {};
    ports.update({
      queue: [{ id: 'pending', text: 'Keep me', imageCount: 0, addedAt: 1 }],
      results: {
        ...ports.current().results,
        'session.start': {
          ...start,
          protocolCapabilities: [
            'session.prompt-queue',
            'session.prompt-queue-front',
            'session.user-ack',
          ],
        },
      },
    });
    const order: string[] = [];
    ports.command.mockImplementation(async () => {
      order.push('queued first');
      return {};
    });
    ports.send.mockImplementation(async () => {
      order.push('abort');
    });
    expect(await dispatchComposer('New direction', 'steer', ports)).toMatch(/ahead of/);
    expect(order).toEqual(['queued first', 'abort']);
    expect(ports.command).toHaveBeenCalledExactlyOnceWith(
      'queue.add',
      { text: 'New direction', front: true },
      ['queue.state'],
    );
    expect(ports.waitForIdle).not.toHaveBeenCalled();
    ports.command.mockClear();
    ports.send.mockRejectedValueOnce(Error('socket closed'));
    expect(await dispatchComposer('Again', 'steer', ports)).toMatch(/could not be stopped/);
    ports.command.mockRejectedValueOnce(Error('The queue is full (50 prompts).'));
    ports.send.mockClear();
    await expect(dispatchComposer('Refused', 'steer', ports)).rejects.toThrow('queue is full');
    expect(ports.send).not.toHaveBeenCalled();
  });
  it('propagates refusal and prevents a detached or question-blocked session from consuming a draft', async () => {
    const ports = fixture();
    ports.command.mockRejectedValue(Error('Queue full'));
    await expect(dispatchComposer('Keep this draft', 'queue', ports)).rejects.toThrow('Queue full');
    ports.update({ connected: false });
    ports.command.mockClear();
    await expect(dispatchComposer('Keep this draft', 'queue', ports)).rejects.toThrow(
      'draft is kept',
    );
    expect(ports.command).not.toHaveBeenCalled();
    const steer = fixture(true);
    steer.waitForIdle.mockImplementation(async () => {
      steer.update({ running: false, connected: false });
    });
    await expect(dispatchComposer('Keep this steering draft', 'steer', steer)).rejects.toThrow(
      'session changed',
    );
    expect(steer.command).not.toHaveBeenCalled();
  });
  it('never fabricates a refinement version from a missing or empty response', () => {
    expect(refinementText({}, 'original', 'Original instructions')).toBe('Original instructions');
    expect(() => refinementText({ refined: '' }, 'refined', 'Original')).toThrow('did not return');
    expect(refinementText({ english: 'English instructions' }, 'english', 'Original')).toBe(
      'English instructions',
    );
  });
});
describe('session effort and queue projection', () => {
  it('uses the active model vocabulary, preserves a saved unsupported choice and hides only explicit non-support', () => {
    const ports = fixture();
    ports.update({
      results: {
        ...ports.current().results,
        'prefs.updated': { reasoningEffort: 'max' },
        'provider.models': {
          provider: 'local',
          models: [
            { id: 'reasoner', reasoningEffortLevels: ['low', 'high', 'unknown', 'constructor'] },
          ],
        },
      },
    });
    expect(sessionEffort(ports.current())).toMatchObject({
      hidden: false,
      current: 'max',
      options: ['low', 'high', 'max'],
      unsupported: true,
    });
    ports.update({
      results: { 'session.start': { provider: 'old', model: 'old', effortSupported: false } },
    });
    expect(sessionEffort(ports.current())).toMatchObject({
      hidden: false,
      options: expect.arrayContaining(['none', 'max']),
    });
    ports.update({
      results: {
        'session.start': { provider: 'local', model: 'reasoner', effortSupported: false },
      },
    });
    expect(sessionEffort(ports.current()).hidden).toBe(true);
  });
  it('projects drained turns once and excludes already-started prompts from delayed queue snapshots', () => {
    let state = fixture().current();
    const item = { id: 'q-1', text: 'Queued task', addedAt: 1, imageCount: 0 };
    state = reduceEngine(state, {
      type: 'queue.state',
      payload: { sessionId: 'native-a', items: [item] },
    });
    expect(state.queue).toHaveLength(1);
    state = reduceEngine(state, {
      type: 'queue.drained',
      payload: { sessionId: 'native-a', item },
    });
    state = reduceEngine(state, {
      type: 'queue.drained',
      payload: { sessionId: 'native-a', item },
    });
    state = reduceEngine(state, {
      type: 'queue.state',
      payload: { sessionId: 'native-a', items: [item] },
    });
    expect(state.queue).toEqual([]);
    expect(state.messages).toHaveLength(1);
    expect(state.running).toBe(true);
    expect(
      reduceEngine(state, { type: 'queue.drained', payload: { sessionId: 'native-b', item } }),
    ).toBe(state);
  });
});
