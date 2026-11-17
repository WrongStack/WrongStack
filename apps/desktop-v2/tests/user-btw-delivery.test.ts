import { describe, expect, it, vi } from 'vitest';
import { dispatchComposer } from '../src/composer-model';
import { emptyEngineState, reduceEngine } from '../src/engine-state';

function ports(running = true, supported = true) {
  const state = {
    ...reduceEngine(emptyEngineState, {
      type: 'session.start',
      payload: {
        sessionId: 'own-session',
        provider: 'local',
        model: 'test',
        protocolCapabilities: supported
          ? ['session.user-btw', 'session.prompt-queue', 'session.user-ack']
          : [],
      },
    }),
    running,
  };
  return {
    current: () => state,
    command: vi.fn(async () => ({ id: 'btw:test', items: [] })),
    send: vi.fn(async () => {}),
    waitForIdle: vi.fn(async () => {}),
    onBtwSaved: vi.fn(),
  };
}

describe('human BTW delivery', () => {
  it('delivers instructions to the live leader without peer mail, aborting, or a lingering notice', async () => {
    const p = ports();
    expect(await dispatchComposer('  Preserve the public API  ', 'btw', p)).toBe('');
    expect(p.command).toHaveBeenCalledExactlyOnceWith(
      'btw.add',
      { text: 'Preserve the public API' },
      ['btw.state'],
    );
    expect(p.onBtwSaved).toHaveBeenCalledWith('btw:test', 'Preserve the public API');
    expect(p.send).not.toHaveBeenCalled();
    expect(p.waitForIdle).not.toHaveBeenCalled();
  });
  it('fails closed on an older engine instead of downgrading a user instruction to FYI', async () => {
    const p = ports(true, false);
    await expect(dispatchComposer('User instruction', 'btw', p)).rejects.toThrow(
      /restart.*engine/i,
    );
    expect(p.command).not.toHaveBeenCalled();
    expect(p.onBtwSaved).not.toHaveBeenCalled();
  });
  it('retains ordinary idle-message delivery and does not leave a queued-success banner', async () => {
    const p = ports(false);
    await dispatchComposer('A normal user turn', 'btw', p);
    expect(p.command).toHaveBeenCalledWith(
      'user_message',
      expect.objectContaining({ content: 'A normal user turn' }),
      ['key.operation_result'],
    );
    p.command.mockClear();
    expect(await dispatchComposer('Next task', 'queue', p)).toBe('');
    expect(p.command).toHaveBeenCalledWith('queue.add', { text: 'Next task' }, ['queue.state']);
  });
  it('removes drained queue entries immediately and ignores a late pending snapshot', () => {
    let state = reduceEngine(emptyEngineState, {
      type: 'session.start',
      payload: { sessionId: 'own-session' },
    });
    const item = { id: 'q1', text: 'Next task', addedAt: 1, imageCount: 0 };
    state = reduceEngine(state, {
      type: 'queue.state',
      payload: { sessionId: 'own-session', items: [item] },
    });
    expect(state.queue).toHaveLength(1);
    const foreign = reduceEngine(state, {
      type: 'queue.drained',
      payload: { sessionId: 'other-session', item },
    });
    expect(foreign).toBe(state);
    state = reduceEngine(state, {
      type: 'queue.drained',
      payload: { sessionId: 'own-session', item },
    });
    expect(state.queue).toEqual([]);
    state = reduceEngine(state, {
      type: 'queue.state',
      payload: { sessionId: 'own-session', items: [item] },
    });
    expect(state.queue).toEqual([]);
    expect(state.messages.filter((message) => message.id === 'queue:q1')).toHaveLength(1);
  });
});
