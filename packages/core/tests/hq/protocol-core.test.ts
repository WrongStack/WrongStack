/**
 * Tests for hq/protocol/core.ts — parseHqFrame and protocol validation.
 * Covers: JSON parsing, type validation, all 4 client frame types,
 * malformed payloads, and edge cases.
 */
import { describe, expect, it } from 'vitest';
import { HQ_PROTOCOL_VERSION, parseHqFrame } from '../../src/hq/protocol/core.js';

describe('parseHqFrame', { retry: 1 }, () => {
  // ── JSON parsing ───────────────────────────────────────────────────────

  it('rejects invalid JSON', () => {
    const result = parseHqFrame('not json');
    expect(result).toEqual({ ok: false, reason: 'invalid-json' });
  });

  it('rejects empty string', () => {
    const result = parseHqFrame('');
    expect(result).toEqual({ ok: false, reason: 'invalid-json' });
  });

  it('accepts Buffer input', () => {
    const frame = JSON.stringify({
      type: 'client.hello',
      payload: {
        protocolVersion: 1,
        client: { clientId: 'c1', kind: 'cli', machineId: 'm1', startedAt: '2026-01-01T00:00:00Z' },
        project: {
          projectId: 'p1',
          projectName: 'test',
          projectRoot: '/test',
          machineId: 'm1',
          workspaceKind: 'git',
        },
        capabilities: [],
      },
    });
    const result = parseHqFrame(Buffer.from(frame));
    expect(result.ok).toBe(true);
  });

  // ── Type validation ────────────────────────────────────────────────────

  it('rejects non-object JSON', () => {
    expect(parseHqFrame('"string"')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseHqFrame('42')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseHqFrame('null')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects object without type field', () => {
    expect(parseHqFrame('{"foo": "bar"}')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects non-string type field', () => {
    expect(parseHqFrame('{"type": 42}')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects unknown frame type', () => {
    expect(parseHqFrame('{"type": "client.unknown"}')).toEqual({
      ok: false,
      reason: 'unknown-type',
    });
    expect(parseHqFrame('{"type": "server.hello"}')).toEqual({ ok: false, reason: 'unknown-type' });
  });

  // ── client.hello ───────────────────────────────────────────────────────

  it('parses valid client.hello', () => {
    const frame = {
      type: 'client.hello',
      payload: {
        protocolVersion: HQ_PROTOCOL_VERSION,
        client: { clientId: 'c1', kind: 'cli', machineId: 'm1', startedAt: '2026-01-01T00:00:00Z' },
        project: {
          projectId: 'p1',
          projectName: 'Test Project',
          projectRoot: '/test',
          machineId: 'm1',
          workspaceKind: 'git',
        },
        capabilities: [],
      },
    };
    const result = parseHqFrame(JSON.stringify(frame));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frame.type).toBe('client.hello');
    }
  });

  it('rejects client.hello with missing payload', () => {
    const result = parseHqFrame('{"type": "client.hello"}');
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects client.hello with invalid client identity', () => {
    const frame = {
      type: 'client.hello',
      payload: {
        protocolVersion: 1,
        client: { clientId: 'c1' }, // missing kind, machineId, startedAt
        project: {
          projectId: 'p1',
          projectName: 'test',
          projectRoot: '/test',
          machineId: 'm1',
          workspaceKind: 'git',
        },
        capabilities: [],
      },
    };
    const result = parseHqFrame(JSON.stringify(frame));
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects client.hello with invalid client kind', () => {
    const frame = {
      type: 'client.hello',
      payload: {
        protocolVersion: 1,
        client: {
          clientId: 'c1',
          kind: 'invalid-kind',
          machineId: 'm1',
          startedAt: '2026-01-01T00:00:00Z',
        },
        project: {
          projectId: 'p1',
          projectName: 'test',
          projectRoot: '/test',
          machineId: 'm1',
          workspaceKind: 'git',
        },
        capabilities: [],
      },
    };
    const result = parseHqFrame(JSON.stringify(frame));
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('accepts client.hello with valid tui kind', () => {
    const frame = {
      type: 'client.hello',
      payload: {
        protocolVersion: 1,
        client: { clientId: 'c1', kind: 'tui', machineId: 'm1', startedAt: '2026-01-01T00:00:00Z' },
        project: {
          projectId: 'p1',
          projectName: 'test',
          projectRoot: '/test',
          machineId: 'm1',
          workspaceKind: 'git',
        },
        capabilities: [],
      },
    };
    const result = parseHqFrame(JSON.stringify(frame));
    expect(result.ok).toBe(true);
  });

  it('accepts client.hello with valid webui kind', () => {
    const frame = {
      type: 'client.hello',
      payload: {
        protocolVersion: 1,
        client: {
          clientId: 'c1',
          kind: 'webui',
          machineId: 'm1',
          startedAt: '2026-01-01T00:00:00Z',
        },
        project: {
          projectId: 'p1',
          projectName: 'test',
          projectRoot: '/test',
          machineId: 'm1',
          workspaceKind: 'directory',
        },
        capabilities: [],
      },
    };
    const result = parseHqFrame(JSON.stringify(frame));
    expect(result.ok).toBe(true);
  });

  // ── client.event ───────────────────────────────────────────────────────

  it('parses valid client.event', () => {
    const frame = {
      type: 'client.event',
      event: {
        id: 'evt-1',
        type: 'usage',
        schemaVersion: HQ_PROTOCOL_VERSION,
        timestamp: '2026-01-01T00:00:00Z',
        clientId: 'c1',
        projectId: 'p1',
        seq: 1,
        payload: {},
      },
    };
    const result = parseHqFrame(JSON.stringify(frame));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frame.type).toBe('client.event');
    }
  });

  it('rejects client.event with missing event', () => {
    const result = parseHqFrame('{"type": "client.event"}');
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects client.event with invalid event envelope', () => {
    const result = parseHqFrame('{"type": "client.event", "event": {"foo": "bar"}}');
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  // ── client.command_poll ────────────────────────────────────────────────

  it('parses valid client.command_poll', () => {
    const frame = {
      type: 'client.command_poll',
      clientId: 'c1',
      projectId: 'p1',
    };
    const result = parseHqFrame(JSON.stringify(frame));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frame.type).toBe('client.command_poll');
    }
  });

  it('parses command_poll with optional fields', () => {
    const frame = {
      type: 'client.command_poll',
      clientId: 'c1',
      projectId: 'p1',
      afterCommandId: 'cmd-1',
      limit: 10,
    };
    const result = parseHqFrame(JSON.stringify(frame));
    expect(result.ok).toBe(true);
    if (result.ok && result.frame.type === 'client.command_poll') {
      expect(result.frame.afterCommandId).toBe('cmd-1');
      expect(result.frame.limit).toBe(10);
    }
  });

  it('rejects command_poll with missing clientId', () => {
    const result = parseHqFrame('{"type": "client.command_poll", "projectId": "p1"}');
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  // ── client.command_ack ─────────────────────────────────────────────────

  it('parses valid client.command_ack', () => {
    const frame = {
      type: 'client.command_ack',
      clientId: 'c1',
      projectId: 'p1',
      commandId: 'cmd-1',
      status: 'completed',
    };
    const result = parseHqFrame(JSON.stringify(frame));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frame.type).toBe('client.command_ack');
    }
  });

  it('parses command_ack with message', () => {
    const frame = {
      type: 'client.command_ack',
      clientId: 'c1',
      projectId: 'p1',
      commandId: 'cmd-1',
      status: 'failed',
      message: 'something went wrong',
    };
    const result = parseHqFrame(JSON.stringify(frame));
    expect(result.ok).toBe(true);
    if (result.ok && result.frame.type === 'client.command_ack') {
      expect(result.frame.message).toBe('something went wrong');
    }
  });

  it('rejects command_ack with invalid status', () => {
    const frame = {
      type: 'client.command_ack',
      clientId: 'c1',
      projectId: 'p1',
      commandId: 'cmd-1',
      status: 'invalid-status',
    };
    const result = parseHqFrame(JSON.stringify(frame));
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects command_ack with missing commandId', () => {
    const frame = {
      type: 'client.command_ack',
      clientId: 'c1',
      projectId: 'p1',
      status: 'completed',
    };
    const result = parseHqFrame(JSON.stringify(frame));
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('HQ_PROTOCOL_VERSION', () => {
  it('is 1', () => {
    expect(HQ_PROTOCOL_VERSION).toBe(1);
  });
});
