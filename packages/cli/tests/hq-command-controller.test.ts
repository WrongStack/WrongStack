import { describe, expect, it, vi } from 'vitest';
import { createHqCommandDispatcher, type HqCommandController } from '../src/hq-command-controller.js';

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
    const result = await dispatch({ commandId: 'c1', type: 'steer', payload: { to: 'leader', subject: 'hi', body: 'do x' } });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'steer', to: 'leader', subject: 'hi', body: 'do x' }));
    expect(result).toMatchObject({ commandId: 'c1', status: 'accepted' });
  });

  it('steer rejects when no mailbox is available', async () => {
    const controller = makeController({ steerMailbox: undefined });
    const dispatch = createHqCommandDispatcher(controller);
    const result = await dispatch({ commandId: 'c1', type: 'steer', payload: { to: 'leader', subject: 'x', body: 'y' } });
    expect(result.status).toBe('rejected');
  });

  it('broadcast sends to all', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = makeController({ steerMailbox: { send } as never });
    const dispatch = createHqCommandDispatcher(controller);
    const result = await dispatch({ commandId: 'c1', type: 'broadcast', payload: { subject: 's', body: 'b' } });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'all', type: 'broadcast' }));
    expect(result.status).toBe('accepted');
  });

  it('abort leader calls interruptLeader', async () => {
    const interruptLeader = vi.fn(() => true);
    const controller = makeController({ interruptLeader });
    const dispatch = createHqCommandDispatcher(controller);
    const result = await dispatch({ commandId: 'c1', type: 'abort', payload: { target: 'leader' } });
    expect(interruptLeader).toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'completed', message: 'leader aborted' });
  });

  it('abort leader with no active run acks accepted', async () => {
    const controller = makeController({ interruptLeader: () => false });
    const dispatch = createHqCommandDispatcher(controller);
    const result = await dispatch({ commandId: 'c1', type: 'abort', payload: { target: 'leader' } });
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
    const result = await dispatch({ commandId: 'c1', type: 'spawn', payload: { role: 'bug-hunter' } });
    expect(spawnAgent).toHaveBeenCalledWith('bug-hunter', undefined, undefined);
    expect(result).toMatchObject({ status: 'completed' });
  });

  it('spawn rejects when no director (spawnAgent undefined)', async () => {
    const controller = makeController({ spawnAgent: undefined as never });
    const dispatch = createHqCommandDispatcher(controller);
    const result = await dispatch({ commandId: 'c1', type: 'spawn', payload: { role: 'bug-hunter' } });
    expect(result.status).toBe('rejected');
  });

  it('run-command rejects without operator opt-in', async () => {
    const controller = makeController({ allowRunCommand: () => false });
    const dispatch = createHqCommandDispatcher(controller);
    const result = await dispatch({ commandId: 'c1', type: 'run-command', payload: { command: 'ls' } });
    expect(result.status).toBe('rejected');
    expect(result.message).toContain('opt-in');
  });

  it('run-command routes as steer with operator opt-in', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = makeController({ allowRunCommand: () => true, steerMailbox: { send } as never });
    const dispatch = createHqCommandDispatcher(controller);
    const result = await dispatch({ commandId: 'c1', type: 'run-command', payload: { command: 'ls -la' } });
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
