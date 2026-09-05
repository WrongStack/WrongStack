import { describe, expect, it, vi } from 'vitest';
import {
  createHqCommandDispatcher,
  type HqCommandController,
} from '../src/hq-command-controller.js';

function makeController(overrides: Partial<HqCommandController> = {}): HqCommandController {
  return {
    steerMailbox: {
      send: vi.fn().mockResolvedValue(undefined),
    } as never,
    interruptLeader: vi.fn(() => false),
    sessionTag: () => 'session-tag-1',
    allowRunCommand: () => false,
    ...overrides,
  };
}

describe('createHqCommandDispatcher', () => {
  it('steer sends a mailbox message and acks accepted', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = makeController({ steerMailbox: { send } as never });
    const dispatch = createHqCommandDispatcher(controller);
    const result = await dispatch({
      commandId: 'c1',
      type: 'steer',
      payload: { to: 'leader', subject: 'hi', body: 'do x' },
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'steer', to: 'leader', subject: 'hi', body: 'do x' }),
    );
    expect(result).toMatchObject({ commandId: 'c1', status: 'accepted' });
  });

  it('steer rejects when no mailbox is available', async () => {
    const controller = makeController({ steerMailbox: undefined });
    const dispatch = createHqCommandDispatcher(controller);
    const result = await dispatch({
      commandId: 'c1',
      type: 'steer',
      payload: { to: 'leader', subject: 'x', body: 'y' },
    });
    expect(result.status).toBe('rejected');
  });

  it('broadcast sends to all', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = makeController({ steerMailbox: { send } as never });
    const dispatch = createHqCommandDispatcher(controller);
    const result = await dispatch({
      commandId: 'c1',
      type: 'broadcast',
      payload: { subject: 's', body: 'b' },
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'all', type: 'broadcast' }));
    expect(result.status).toBe('accepted');
  });

  it('abort leader calls interruptLeader', async () => {
    const interruptLeader = vi.fn(() => true);
    const controller = makeController({ interruptLeader });
    const dispatch = createHqCommandDispatcher(controller);
    const result = await dispatch({
      commandId: 'c1',
      type: 'abort',
      payload: { target: 'leader' },
    });
    expect(interruptLeader).toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'completed', message: 'leader aborted' });
  });

  it('abort leader with no active run acks accepted', async () => {
    const controller = makeController({ interruptLeader: () => false });
    const dispatch = createHqCommandDispatcher(controller);
    const result = await dispatch({
      commandId: 'c1',
      type: 'abort',
      payload: { target: 'leader' },
    });
    expect(result.status).toBe('accepted');
  });

  it('abort fleet calls killFleet', async () => {
    const killFleet = vi.fn(async () => 3);
    const controller = makeController({ killFleet });
    const dispatch = createHqCommandDispatcher(controller);
    const result = await dispatch({ commandId: 'c1', type: 'abort', payload: { target: 'fleet' } });
    expect(killFleet).toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'completed' });
    expect(result.message).toContain('3');
  });

  it('abort subagent calls terminateAgent', async () => {
    const terminateAgent = vi.fn(async () => true);
    const controller = makeController({ terminateAgent });
    const dispatch = createHqCommandDispatcher(controller);
    const result = await dispatch({ commandId: 'c1', type: 'abort', payload: { target: 'sub-9' } });
    expect(terminateAgent).toHaveBeenCalledWith('sub-9');
    expect(result.status).toBe('completed');
  });

  it('spawn calls spawnAgent and returns completed', async () => {
    const spawnAgent = vi.fn(async () => 'new-sub-1');
    const controller = makeController({ spawnAgent });
    const dispatch = createHqCommandDispatcher(controller);
    const result = await dispatch({
      commandId: 'c1',
      type: 'spawn',
      payload: { role: 'bug-hunter' },
    });
    expect(spawnAgent).toHaveBeenCalledWith('bug-hunter', undefined, undefined);
    expect(result).toMatchObject({ status: 'completed' });
  });

  it('spawn rejects when no director (spawnAgent undefined)', async () => {
    const controller = makeController({ spawnAgent: undefined as never });
    const dispatch = createHqCommandDispatcher(controller);
    const result = await dispatch({
      commandId: 'c1',
      type: 'spawn',
      payload: { role: 'bug-hunter' },
    });
    expect(result.status).toBe('rejected');
  });

  it('run-command rejects without operator opt-in', async () => {
    const controller = makeController({ allowRunCommand: () => false });
    const dispatch = createHqCommandDispatcher(controller);
    const result = await dispatch({
      commandId: 'c1',
      type: 'run-command',
      payload: { command: 'ls' },
    });
    expect(result.status).toBe('rejected');
    expect(result.message).toContain('opt-in');
  });

  it('run-command routes as steer with operator opt-in', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = makeController({
      allowRunCommand: () => true,
      steerMailbox: { send } as never,
    });
    const dispatch = createHqCommandDispatcher(controller);
    const result = await dispatch({
      commandId: 'c1',
      type: 'run-command',
      payload: { command: 'ls -la' },
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'steer', to: 'leader' }));
    expect(result.status).toBe('accepted');
  });

  it('unknown command type is rejected', async () => {
    const controller = makeController();
    const dispatch = createHqCommandDispatcher(controller);
    const result = await dispatch({ commandId: 'c1', type: 'bogus', payload: {} });
    expect(result.status).toBe('rejected');
  });

  it('a throwing dispatch target produces a failed ack (never throws)', async () => {
    const controller = makeController({
      spawnAgent: async () => {
        throw new Error('director exploded');
      },
    });
    const dispatch = createHqCommandDispatcher(controller);
    const result = await dispatch({ commandId: 'c1', type: 'spawn', payload: { role: 'x' } });
    expect(result.status).toBe('failed');
    expect(result.message).toContain('director exploded');
  });
});

describe('createHqCommandDispatcher — session scoping', () => {
  // The bare `leader` alias is answered by EVERY leader in the project, and
  // unread state is per reader, so without a session-affinity stamp a steer
  // aimed at one HQ session is also consumed by every other terminal open on
  // the same project.
  it('stamps session affinity on leader-addressed steer/btw/queue', async () => {
    for (const type of ['steer', 'btw', 'queue'] as const) {
      const send = vi.fn().mockResolvedValue(undefined);
      const dispatch = createHqCommandDispatcher(
        makeController({ steerMailbox: { send } as never, sessionId: () => 'sess-42' }),
      );
      await dispatch({ commandId: 'c1', type, payload: { to: 'leader', body: 'b' } });
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'leader', sessionAffinity: { sessionId: 'sess-42' } }),
      );
    }
  });

  it('leaves an explicitly addressed recipient unscoped', async () => {
    // A subagent delegated from another tab carries THAT tab's owning session;
    // stamping the leader's session would drop the message at the receiver.
    const send = vi.fn().mockResolvedValue(undefined);
    const dispatch = createHqCommandDispatcher(
      makeController({ steerMailbox: { send } as never, sessionId: () => 'sess-42' }),
    );
    await dispatch({
      commandId: 'c1',
      type: 'steer',
      payload: { to: 'reviewer-3', body: 'b' },
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'reviewer-3' }));
    expect(send.mock.calls[0]![0]).not.toHaveProperty('sessionAffinity');
  });

  it('leaves a broadcast project-wide', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const dispatch = createHqCommandDispatcher(
      makeController({ steerMailbox: { send } as never, sessionId: () => 'sess-42' }),
    );
    await dispatch({ commandId: 'c1', type: 'broadcast', payload: { body: 'b' } });
    expect(send.mock.calls[0]![0]).not.toHaveProperty('sessionAffinity');
  });

  it('stays project-wide when no session id is known', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const dispatch = createHqCommandDispatcher(makeController({ steerMailbox: { send } as never }));
    await dispatch({ commandId: 'c1', type: 'steer', payload: { to: 'leader', body: 'b' } });
    expect(send.mock.calls[0]![0]).not.toHaveProperty('sessionAffinity');
  });

  it('routes run-command to the selected session only', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const dispatch = createHqCommandDispatcher(
      makeController({
        steerMailbox: { send } as never,
        sessionId: () => 'sess-42',
        allowRunCommand: () => true,
      }),
    );
    await dispatch({ commandId: 'c1', type: 'run-command', payload: { command: 'ls' } });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'leader', sessionAffinity: { sessionId: 'sess-42' } }),
    );
  });
});
