/**
 * Regression tests for the projection mappers (`src/projections.ts`).
 *
 * Projections are the trust boundary between raw wire frames and browser
 * state: every field a client renders passes through one of these functions,
 * and every rejection path exists because a truncated or hostile frame once
 * reached a store. Pin the happy paths, the fallback defaults, and the
 * rejection branches here.
 */

import { describe, expect, it } from 'vitest';
import {
  projectChatMessage,
  projectFleetMessage,
  projectHqAlertMessage,
  projectHqCommandStatusMessage,
  projectHqEventMessage,
  projectHqFleetMessage,
  projectSessionMessage,
  projectToolMessage,
} from '../src/projections.js';

const envelope = (type: string, payload?: unknown): { type: string; payload?: unknown } => ({
  type,
  ...(payload === undefined ? {} : { payload }),
});

const validTotals = {
  activeProjects: 1,
  activeClients: 2,
  activeSessions: 3,
  activeSubagents: 0,
  unreadMailboxMessages: 4,
  incompleteMailboxMessages: 0,
  totalCostUsd: 1.5,
};

const validHqSnapshot = {
  generatedAt: '2026-08-29T00:00:00.000Z',
  clients: [],
  projects: [],
  sessions: [],
  fleets: [],
  mailboxes: [],
  totals: validTotals,
};

describe('projectSessionMessage', () => {
  it('returns null for other message types', () => {
    expect(projectSessionMessage(envelope('session.resume'))).toBeNull();
  });

  it('returns null when the payload is missing or not an object', () => {
    expect(projectSessionMessage(envelope('session.start'))).toBeNull();
    expect(projectSessionMessage(envelope('session.start', 'nope'))).toBeNull();
    expect(projectSessionMessage(envelope('session.start', ['x']))).toBeNull();
  });

  it('projects every documented field with sane fallbacks', () => {
    expect(
      projectSessionMessage(
        envelope('session.start', {
          sessionId: 's1',
          provider: 'anthropic',
          model: 'test-model',
          maxContext: 'not-a-number',
          reset: true,
          isRunning: true,
          replayMessages: [{ role: 'user' }],
          replayMarkers: [{ at: 1 }],
          replayToolMeta: [{ id: 't1' }],
          replayUsage: { input: 10 },
        }),
      ),
    ).toEqual({
      kind: 'session',
      id: 's1',
      provider: 'anthropic',
      model: 'test-model',
      projectName: 'Project',
      cwd: '',
      maxContext: 0,
      startedAt: '',
      reset: true,
      isRunning: true,
      replayMessages: [{ role: 'user' }],
      replayMarkers: [{ at: 1 }],
      replayToolMeta: [{ id: 't1' }],
      replayUsage: { input: 10 },
    });
  });

  it('defaults projectName to "Project" when supplied as a non-string', () => {
    const projected = projectSessionMessage(
      envelope('session.start', { sessionId: 's2', projectName: 42 }),
    );
    expect(projected?.projectName).toBe('Project');
  });

  it('coerces non-array replay fields to null', () => {
    const projected = projectSessionMessage(
      envelope('session.start', { sessionId: 's3', replayMessages: 'oops', replayUsage: 5 }),
    );
    expect(projected?.replayMessages).toBeNull();
    expect(projected?.replayMarkers).toBeNull();
    expect(projected?.replayToolMeta).toBeNull();
    expect(projected?.replayUsage).toBeNull();
  });
});

describe('projectChatMessage', () => {
  it('returns null when the payload is not an object', () => {
    expect(projectChatMessage(envelope('provider.response'))).toBeNull();
  });

  it('returns null for unknown message types', () => {
    expect(projectChatMessage(envelope('chat.unknown', { text: 'x' }))).toBeNull();
  });

  it('projects thinking deltas and drops empty ones', () => {
    expect(projectChatMessage(envelope('provider.thinking_delta', { text: 'hmm' }))).toEqual({
      kind: 'thinking-delta',
      text: 'hmm',
    });
    expect(projectChatMessage(envelope('provider.thinking_delta', { text: '' }))).toBeNull();
    expect(projectChatMessage(envelope('provider.thinking_delta', {}))).toBeNull();
  });

  it('projects text deltas with their message id', () => {
    expect(
      projectChatMessage(envelope('provider.text_delta', { text: 'hi', messageId: 'm1' })),
    ).toEqual({ kind: 'text-delta', text: 'hi', messageId: 'm1' });
    expect(projectChatMessage(envelope('provider.text_delta', { text: 'hi' }))).toEqual({
      kind: 'text-delta',
      text: 'hi',
      messageId: '',
    });
  });

  it('projects responses with content and stop reason', () => {
    expect(
      projectChatMessage(
        envelope('provider.response', { content: 'done', stopReason: 'end_turn' }),
      ),
    ).toEqual({ kind: 'response', content: 'done', stopReason: 'end_turn' });
  });

  it('projects run results, defaulting iterations and omitting a missing finalText', () => {
    expect(projectChatMessage(envelope('run.result', { status: 'ok' }))).toEqual({
      kind: 'run-result',
      status: 'ok',
      iterations: 1,
    });
    expect(
      projectChatMessage(envelope('run.result', { status: 'ok', iterations: 4, finalText: 'fin' })),
    ).toEqual({ kind: 'run-result', status: 'ok', iterations: 4, finalText: 'fin' });
  });

  it('projects errors with a default message', () => {
    expect(projectChatMessage(envelope('error', {}))).toEqual({
      kind: 'error',
      message: 'Run failed',
    });
    expect(projectChatMessage(envelope('error', { message: 'boom' }))).toEqual({
      kind: 'error',
      message: 'boom',
    });
  });
});

describe('projectToolMessage', () => {
  it('returns null when the payload is not an object', () => {
    expect(projectToolMessage(envelope('tool.started'))).toBeNull();
  });

  it('returns null for unknown message types', () => {
    expect(projectToolMessage(envelope('tool.nope', { id: 'x' }))).toBeNull();
  });

  it('projects tool.started with id falling back to the tool name', () => {
    expect(
      projectToolMessage(
        envelope('tool.started', { name: 'read', messageId: 'm1', input: { a: 1 } }),
      ),
    ).toEqual({ kind: 'started', id: 'read', name: 'read', input: { a: 1 }, messageId: 'm1' });
    expect(
      projectToolMessage(envelope('tool.started', { id: 't9', name: 'grep', input: null })),
    ).toEqual({ kind: 'started', id: 't9', name: 'grep', input: null, messageId: '' });
  });

  it('projects tool.progress with trimmed event text', () => {
    expect(
      projectToolMessage(
        envelope('tool.progress', {
          id: 't1',
          name: 'bash',
          event: { type: 'stdout', text: '  out  \n' },
        }),
      ),
    ).toEqual({ kind: 'progress', id: 't1', name: 'bash', eventType: 'stdout', text: 'out' });
    expect(projectToolMessage(envelope('tool.progress', { id: 't1', name: 'bash' }))).toEqual({
      kind: 'progress',
      id: 't1',
      name: 'bash',
      eventType: '',
      text: '',
    });
  });

  it('projects tool.executed defaulting ok to true and duration to 0', () => {
    expect(projectToolMessage(envelope('tool.executed', { id: 't1', name: 'bash' }))).toEqual({
      kind: 'executed',
      id: 't1',
      name: 'bash',
      ok: true,
      durationMs: 0,
    });
    expect(
      projectToolMessage(
        envelope('tool.executed', {
          id: 't2',
          name: 'bash',
          ok: false,
          durationMs: 12,
          output: 'err',
        }),
      ),
    ).toEqual({
      kind: 'executed',
      id: 't2',
      name: 'bash',
      ok: false,
      durationMs: 12,
      output: 'err',
    });
  });

  it('filters non-string lines out of the sage block and omits it when absent', () => {
    const withSage = projectToolMessage(
      envelope('tool.executed', { id: 't3', name: 'x', sage: ['header', 42, 'body'] }),
    );
    expect(withSage).toEqual({
      kind: 'executed',
      id: 't3',
      name: 'x',
      ok: true,
      durationMs: 0,
      sage: ['header', 'body'],
    });
    const withoutSage = projectToolMessage(
      envelope('tool.executed', { id: 't4', name: 'x', sage: 'nope' }),
    );
    expect(withoutSage).not.toHaveProperty('sage');
    expect(withoutSage).not.toHaveProperty('output');
  });
});

describe('projectFleetMessage', () => {
  it('returns null when the payload is not an object', () => {
    expect(projectFleetMessage(envelope('fleet.concurrency_update'))).toBeNull();
  });

  it('returns null for unknown message types', () => {
    expect(projectFleetMessage(envelope('fleet.unknown', { x: 1 }))).toBeNull();
  });

  it('projects concurrency updates with optional fields left undefined', () => {
    expect(
      projectFleetMessage(
        envelope('fleet.concurrency_update', { fleetConcurrency: 2, fleetConcurrencyMax: 5 }),
      ),
    ).toEqual({
      kind: 'concurrency',
      active: 2,
      maximum: 5,
      maxSpawns: undefined,
      usedSpawns: undefined,
      remainingSpawns: undefined,
      maxSpawnsSource: undefined,
      maxConcurrentSource: undefined,
      effectiveSource: undefined,
      checkpointMaxSpawns: undefined,
      ceilingMismatch: undefined,
    });
    expect(
      projectFleetMessage(
        envelope('fleet.concurrency_update', {
          fleetConcurrency: 'x',
          fleetConcurrencyMax: 5,
          maxSpawns: 3,
          usedSpawns: 1,
          remainingSpawns: 2,
          maxSpawnsSource: 'config',
          ceilingMismatch: true,
        }),
      ),
    ).toEqual({
      kind: 'concurrency',
      active: 0,
      maximum: 5,
      maxSpawns: 3,
      usedSpawns: 1,
      remainingSpawns: 2,
      maxSpawnsSource: 'config',
      ceilingMismatch: true,
    });
  });

  it('passes client status payloads through verbatim', () => {
    const payload = { clientId: 'c1', status: 'online' };
    expect(projectFleetMessage(envelope('client.status_update', payload))).toEqual({
      kind: 'client-status',
      status: payload,
    });
  });

  it('projects session status arrays and rejects non-arrays', () => {
    expect(
      projectFleetMessage(envelope('sessions.status_update', { sessions: [{ id: 's1' }] })),
    ).toEqual({ kind: 'sessions', sessions: [{ id: 's1' }] });
    expect(projectFleetMessage(envelope('sessions.status_update', { sessions: 'nope' }))).toEqual({
      kind: 'sessions',
      sessions: [],
    });
  });

  it('projects coordinator stats keeping only record entries', () => {
    expect(
      projectFleetMessage(
        envelope('coordinator.stats', { subagentStatuses: [{ id: 'a1' }, 'junk', 5] }),
      ),
    ).toEqual({ kind: 'coordinator', agents: [{ id: 'a1' }] });
    expect(
      projectFleetMessage(envelope('coordinator.stats', { subagentStatuses: 'nope' })),
    ).toEqual({
      kind: 'coordinator',
      agents: [],
    });
  });
});

describe('projectHqFleetMessage', () => {
  it('returns null for other message types', () => {
    expect(projectHqFleetMessage({ type: 'hq.event' })).toBeNull();
  });

  it('accepts a well-formed snapshot', () => {
    expect(projectHqFleetMessage({ type: 'hq.snapshot', snapshot: validHqSnapshot })).toEqual({
      kind: 'hq-snapshot',
      snapshot: validHqSnapshot,
    });
  });

  it('rejects snapshots missing required arrays or fields', () => {
    expect(
      projectHqFleetMessage({
        type: 'hq.snapshot',
        snapshot: { ...validHqSnapshot, generatedAt: 5 },
      }),
    ).toBeNull();
    expect(
      projectHqFleetMessage({
        type: 'hq.snapshot',
        snapshot: { ...validHqSnapshot, clients: 'x' },
      }),
    ).toBeNull();
    expect(
      projectHqFleetMessage({ type: 'hq.snapshot', snapshot: { ...validHqSnapshot, totals: {} } }),
    ).toBeNull();
    expect(
      projectHqFleetMessage({
        type: 'hq.snapshot',
        snapshot: { ...validHqSnapshot, totals: null },
      }),
    ).toBeNull();
    expect(projectHqFleetMessage({ type: 'hq.snapshot' })).toBeNull();
    expect(projectHqFleetMessage({ type: 'hq.snapshot', snapshot: 'x' })).toBeNull();
  });

  it('rejects snapshots whose optional arrays have the wrong type', () => {
    expect(
      projectHqFleetMessage({
        type: 'hq.snapshot',
        snapshot: { ...validHqSnapshot, machines: 42 },
      }),
    ).toBeNull();
    expect(
      projectHqFleetMessage({
        type: 'hq.snapshot',
        snapshot: { ...validHqSnapshot, liveSessions: {} },
      }),
    ).toBeNull();
    expect(
      projectHqFleetMessage({
        type: 'hq.snapshot',
        snapshot: { ...validHqSnapshot, mcpServers: 'x' },
      }),
    ).toBeNull();
  });

  it('accepts snapshots without the optional arrays', () => {
    expect(
      projectHqFleetMessage({ type: 'hq.snapshot', snapshot: validHqSnapshot }),
    ).not.toBeNull();
  });
});

describe('projectHqEventMessage', () => {
  const event = {
    id: 'e1',
    type: 'session.start',
    timestamp: '2026-08-29T00:00:00.000Z',
    clientId: 'c1',
    projectId: 'p1',
    seq: 7,
  };

  it('returns null for other message types', () => {
    expect(projectHqEventMessage({ type: 'hq.alert', event })).toBeNull();
  });

  it('accepts a well-formed event', () => {
    expect(projectHqEventMessage({ type: 'hq.event', event })).toEqual({ kind: 'hq-event', event });
  });

  it('rejects events missing any required field', () => {
    for (const key of ['id', 'type', 'timestamp', 'clientId', 'projectId'] as const) {
      const broken = { ...event, [key]: undefined };
      expect(projectHqEventMessage({ type: 'hq.event', event: broken }), key).toBeNull();
    }
    expect(
      projectHqEventMessage({ type: 'hq.event', event: { ...event, seq: 'seven' } }),
    ).toBeNull();
    expect(projectHqEventMessage({ type: 'hq.event' })).toBeNull();
  });
});

describe('projectHqAlertMessage', () => {
  it('returns null for other message types', () => {
    expect(projectHqAlertMessage({ type: 'hq.event', severity: 'info' })).toBeNull();
  });

  it('accepts the three documented severities', () => {
    for (const severity of ['info', 'warn', 'error'] as const) {
      expect(
        projectHqAlertMessage({ type: 'hq.alert', severity, message: 'm', timestamp: 't' }),
      ).toEqual({
        kind: 'hq-alert',
        alert: { type: 'hq.alert', severity, message: 'm', timestamp: 't' },
      });
    }
  });

  it('rejects unknown severities and malformed fields', () => {
    expect(
      projectHqAlertMessage({
        type: 'hq.alert',
        severity: 'critical',
        message: 'm',
        timestamp: 't',
      }),
    ).toBeNull();
    expect(
      projectHqAlertMessage({ type: 'hq.alert', severity: 'info', timestamp: 't' }),
    ).toBeNull();
    expect(projectHqAlertMessage({ type: 'hq.alert', severity: 'info', message: 'm' })).toBeNull();
    expect(
      projectHqAlertMessage({ type: 'hq.alert', severity: 3, message: 'm', timestamp: 't' }),
    ).toBeNull();
  });
});

describe('projectHqCommandStatusMessage', () => {
  const command = {
    commandId: 'cmd1',
    type: 'session.focus',
    clientId: 'c1',
    enqueuedBy: 'browser',
    enqueuedAt: '2026-08-29T00:00:00.000Z',
    status: 'queued',
  };

  it('returns null for other message types', () => {
    expect(projectHqCommandStatusMessage({ type: 'hq.alert', command })).toBeNull();
  });

  it('accepts the three documented statuses', () => {
    for (const status of ['queued', 'delivered', 'acked'] as const) {
      const entry = { ...command, status };
      expect(projectHqCommandStatusMessage({ type: 'hq.command_status', command: entry })).toEqual({
        kind: 'hq-command-status',
        command: entry,
      });
    }
  });

  it('rejects unknown statuses and missing fields', () => {
    expect(
      projectHqCommandStatusMessage({
        type: 'hq.command_status',
        command: { ...command, status: 'failed' },
      }),
    ).toBeNull();
    expect(
      projectHqCommandStatusMessage({
        type: 'hq.command_status',
        command: { ...command, commandId: 5 },
      }),
    ).toBeNull();
    expect(projectHqCommandStatusMessage({ type: 'hq.command_status' })).toBeNull();
  });
});
