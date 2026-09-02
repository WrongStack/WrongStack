import { describe, expect, it } from 'vitest';
import {
  HqCommandAuditLog,
  validateHqCommand,
  type HqCommand,
  type HqQueuedCommand,
} from '../../src/hq/commands.js';

function queued(type: string, payload: unknown): HqQueuedCommand {
  return {
    commandId: 'cmd-1',
    type,
    createdAt: '2026-07-02T00:00:00Z',
    payload,
    requiresAck: true,
  };
}

describe('validateHqCommand', () => {
  it('validates a steer command', () => {
    const c = validateHqCommand(queued('steer', { to: 'leader', subject: 'hi', body: 'do x' }));
    expect(c).not.toBeNull();
    expect((c as HqCommand).type).toBe('steer');
  });

  it('validates a steer command with priority', () => {
    const c = validateHqCommand(
      queued('steer', { to: 'leader', subject: 'hi', body: 'do x', priority: 'high' }),
    );
    expect(c).toMatchObject({ type: 'steer', priority: 'high' });
  });

  it('rejects a steer command missing required fields', () => {
    expect(validateHqCommand(queued('steer', { to: 'leader' }))).toBeNull();
  });

  it('validates an abort command', () => {
    expect(validateHqCommand(queued('abort', { target: 'leader' }))).toMatchObject({
      type: 'abort',
      target: 'leader',
    });
    expect(validateHqCommand(queued('abort', { target: 'fleet' }))).toMatchObject({
      type: 'abort',
    });
    expect(validateHqCommand(queued('abort', { target: 'sub-1' }))).toMatchObject({
      type: 'abort',
    });
  });

  it('validates a spawn command with optional fields', () => {
    const c = validateHqCommand(
      queued('spawn', { role: 'bug-hunter', task: 'find bugs', maxIterations: 50 }),
    );
    expect(c).toMatchObject({
      type: 'spawn',
      role: 'bug-hunter',
      task: 'find bugs',
      maxIterations: 50,
    });
  });

  it('validates a broadcast command', () => {
    expect(validateHqCommand(queued('broadcast', { subject: 's', body: 'b' }))).toMatchObject({
      type: 'broadcast',
    });
  });

  it('validates a run-command command', () => {
    const c = validateHqCommand(queued('run-command', { command: 'ls', cwd: '/tmp' }));
    expect(c).toMatchObject({ type: 'run-command', command: 'ls', cwd: '/tmp' });
  });

  it('rejects an unknown command type', () => {
    expect(validateHqCommand(queued('bogus', {}))).toBeNull();
  });

  it('rejects a non-object payload', () => {
    expect(validateHqCommand(queued('steer', 'not-an-object'))).toBeNull();
    expect(validateHqCommand(queued('steer', null))).toBeNull();
  });
});

describe('HqCommandAuditLog', () => {
  it('records and retrieves entries', () => {
    const log = new HqCommandAuditLog();
    log.record({
      commandId: 'c1',
      type: 'steer',
      clientId: 'cl-1',
      enqueuedBy: 'tok-1',
      enqueuedAt: 't1',
      status: 'queued',
    });
    log.record({
      commandId: 'c2',
      type: 'abort',
      clientId: 'cl-1',
      enqueuedBy: 'tok-1',
      enqueuedAt: 't2',
      status: 'queued',
    });
    const recent = log.recent();
    expect(recent).toHaveLength(2);
    expect(recent[1]!.commandId).toBe('c2');
  });

  it('updates an entry by commandId', () => {
    const log = new HqCommandAuditLog();
    log.record({
      commandId: 'c1',
      type: 'steer',
      clientId: 'cl-1',
      enqueuedBy: 'tok-1',
      enqueuedAt: 't1',
      status: 'queued',
    });
    log.update('c1', { status: 'acked', ackStatus: 'completed', ackedAt: 't2' });
    const entry = log.get('c1')!;
    expect(entry.status).toBe('acked');
    expect(entry.ackStatus).toBe('completed');
  });

  it('updates an acknowledgement only for the owning client', () => {
    const log = new HqCommandAuditLog();
    log.record({
      commandId: 'owned',
      type: 'abort',
      clientId: 'client-a',
      enqueuedBy: 'operator',
      enqueuedAt: 't1',
      status: 'queued',
    });

    expect(log.updateForClient('owned', 'client-b', { status: 'acked' })).toBe(false);
    expect(log.recent()[0]?.status).toBe('queued');
    expect(log.updateForClient('owned', 'client-a', { status: 'acked' })).toBe(true);
    expect(log.recent()[0]?.status).toBe('acked');
  });

  it('caps the ring at max entries', () => {
    const log = new HqCommandAuditLog(5);
    for (let i = 0; i < 10; i++) {
      log.record({
        commandId: `c${i}`,
        type: 'steer',
        clientId: 'cl',
        enqueuedBy: 't',
        enqueuedAt: 't',
        status: 'queued',
      });
    }
    expect(log.recent()).toHaveLength(5);
    // Most recent 5 retained.
    expect(log.recent()[0]!.commandId).toBe('c5');
  });
});
