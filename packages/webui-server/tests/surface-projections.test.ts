import {
  projectChatMessage,
  projectFleetMessage,
  projectHqAlertMessage,
  projectHqCommandStatusMessage,
  projectHqEventMessage,
  projectHqFleetMessage,
  projectSessionMessage,
  projectToolMessage,
} from '@wrongstack/webui-protocol';
import { describe, expect, it } from 'vitest';

describe('surface semantic projections', () => {
  it('normalizes session identity and replay metadata', () => {
    expect(
      projectSessionMessage({
        type: 'session.start',
        payload: { sessionId: 's1', provider: 'p', model: 'm', maxContext: 10, reset: true },
      }),
    ).toMatchObject({ id: 's1', provider: 'p', model: 'm', maxContext: 10, reset: true });
  });

  it('projects chat deltas and rejects empty text', () => {
    expect(
      projectChatMessage({ type: 'provider.text_delta', payload: { text: 'hi', messageId: 'm1' } }),
    ).toEqual({ kind: 'text-delta', text: 'hi', messageId: 'm1' });
    expect(projectChatMessage({ type: 'provider.text_delta', payload: { text: 1 } })).toBeNull();
  });

  it('projects tool lifecycle with stable defaults', () => {
    expect(
      projectToolMessage({ type: 'tool.started', payload: { id: 't1', name: 'read' } }),
    ).toMatchObject({
      kind: 'started',
      id: 't1',
      name: 'read',
    });
    expect(
      projectToolMessage({ type: 'tool.executed', payload: { id: 't1', ok: false } }),
    ).toMatchObject({
      kind: 'executed',
      id: 't1',
      ok: false,
      durationMs: 0,
    });
  });

  it('carries SAGE memory lines beside the tool output, never merged into it', () => {
    const sage = [
      '--- SAGE: related project knowledge (Memory Injector) ---',
      '- [fact] <memory id="mem-1">globbing is daemon-backed</memory>',
    ];
    expect(
      projectToolMessage({
        type: 'tool.executed',
        payload: { id: 't1', name: 'glob', ok: true, output: 'packages/a.ts', sage },
      }),
    ).toMatchObject({ kind: 'executed', output: 'packages/a.ts', sage });
  });

  it('omits `sage` when absent and drops non-string entries', () => {
    expect(
      projectToolMessage({ type: 'tool.executed', payload: { id: 't1', ok: true } }),
    ).not.toHaveProperty('sage');
    expect(
      projectToolMessage({
        type: 'tool.executed',
        payload: { id: 't1', ok: true, sage: ['--- SAGE: x ---', 7, null] },
      }),
    ).toMatchObject({ sage: ['--- SAGE: x ---'] });
    expect(
      projectToolMessage({ type: 'tool.executed', payload: { id: 't1', ok: true, sage: 'nope' } }),
    ).not.toHaveProperty('sage');
  });

  it('projects fleet concurrency and safe session lists', () => {
    expect(
      projectFleetMessage({
        type: 'fleet.concurrency_update',
        payload: { fleetConcurrency: 2, fleetConcurrencyMax: 4 },
      }),
    ).toEqual({
      kind: 'concurrency',
      active: 2,
      maximum: 4,
    });
    expect(
      projectFleetMessage({ type: 'sessions.status_update', payload: { sessions: 'bad' } }),
    ).toEqual({
      kind: 'sessions',
      sessions: [],
    });
  });

  it('accepts only complete HQ fleet snapshot envelopes', () => {
    const snapshot = {
      generatedAt: '2026-07-21T00:00:00.000Z',
      clients: [],
      projects: [],
      sessions: [],
      fleets: [],
      mailboxes: [],
      totals: {
        activeProjects: 0,
        activeClients: 0,
        activeSessions: 0,
        activeSubagents: 0,
        unreadMailboxMessages: 0,
        incompleteMailboxMessages: 0,
        totalCostUsd: 0,
      },
    };
    expect(projectHqFleetMessage({ type: 'hq.snapshot', snapshot })).toEqual({
      kind: 'hq-snapshot',
      snapshot,
    });
    expect(projectHqFleetMessage({ type: 'hq.snapshot', snapshot: { totals: {} } })).toBeNull();
  });

  it('rejects HQ fleet snapshots with malformed outer shapes', () => {
    const validTotals = {
      activeProjects: 0,
      activeClients: 0,
      activeSessions: 0,
      activeSubagents: 0,
      unreadMailboxMessages: 0,
      incompleteMailboxMessages: 0,
      totalCostUsd: 0,
    };
    const base = {
      generatedAt: '2026-07-21T00:00:00.000Z',
      clients: [],
      projects: [],
      sessions: [],
      fleets: [],
      mailboxes: [],
      totals: validTotals,
    };
    expect(projectHqFleetMessage({ type: 'hq.snapshot' })).toBeNull();
    expect(projectHqFleetMessage({ type: 'hq.snapshot', snapshot: null })).toBeNull();
    expect(
      projectHqFleetMessage({ type: 'hq.snapshot', snapshot: { ...base, generatedAt: 123 } }),
    ).toBeNull();
    expect(
      projectHqFleetMessage({ type: 'hq.snapshot', snapshot: { ...base, clients: 'bad' } }),
    ).toBeNull();
    expect(
      projectHqFleetMessage({ type: 'hq.snapshot', snapshot: { ...base, projects: {} } }),
    ).toBeNull();
    expect(
      projectHqFleetMessage({ type: 'hq.snapshot', snapshot: { ...base, sessions: true } }),
    ).toBeNull();
    expect(
      projectHqFleetMessage({ type: 'hq.snapshot', snapshot: { ...base, fleets: 1 } }),
    ).toBeNull();
    expect(
      projectHqFleetMessage({ type: 'hq.snapshot', snapshot: { ...base, mailboxes: null } }),
    ).toBeNull();
    expect(
      projectHqFleetMessage({ type: 'hq.snapshot', snapshot: { ...base, totals: null } }),
    ).toBeNull();
    expect(
      projectHqFleetMessage({
        type: 'hq.snapshot',
        snapshot: {
          ...base,
          totals: { ...validTotals, activeClients: 'bad' },
        },
      }),
    ).toBeNull();
  });

  it('accepts optional additive array fields when present', () => {
    const snapshot = {
      generatedAt: '2026-07-21T00:00:00.000Z',
      clients: [],
      projects: [],
      sessions: [],
      fleets: [],
      mailboxes: [],
      machines: [],
      liveSessions: [],
      mcpServers: [],
      totals: {
        activeProjects: 0,
        activeClients: 0,
        activeSessions: 0,
        activeSubagents: 0,
        unreadMailboxMessages: 0,
        incompleteMailboxMessages: 0,
        totalCostUsd: 0,
      },
    };
    expect(projectHqFleetMessage({ type: 'hq.snapshot', snapshot })).toEqual({
      kind: 'hq-snapshot',
      snapshot,
    });
  });

  it('rejects HQ fleet snapshots with non-array optional fields', () => {
    const base = {
      generatedAt: '2026-07-21T00:00:00.000Z',
      clients: [],
      projects: [],
      sessions: [],
      fleets: [],
      mailboxes: [],
      totals: {
        activeProjects: 0,
        activeClients: 0,
        activeSessions: 0,
        activeSubagents: 0,
        unreadMailboxMessages: 0,
        incompleteMailboxMessages: 0,
        totalCostUsd: 0,
      },
    };
    expect(
      projectHqFleetMessage({ type: 'hq.snapshot', snapshot: { ...base, machines: 'bad' } }),
    ).toBeNull();
    expect(
      projectHqFleetMessage({ type: 'hq.snapshot', snapshot: { ...base, liveSessions: {} } }),
    ).toBeNull();
    expect(
      projectHqFleetMessage({ type: 'hq.snapshot', snapshot: { ...base, mcpServers: 42 } }),
    ).toBeNull();
  });

  it('projects valid HQ event envelopes and rejects malformed ones', () => {
    const validEvent = {
      id: 'evt-1',
      type: 'session.started',
      schemaVersion: 1,
      timestamp: '2026-07-21T00:00:00.000Z',
      clientId: 'c1',
      projectId: 'p1',
      seq: 1,
      payload: {},
    };
    expect(projectHqEventMessage({ type: 'hq.event', event: validEvent })).toEqual({
      kind: 'hq-event',
      event: validEvent,
    });
    expect(projectHqEventMessage({ type: 'hq.event', event: null })).toBeNull();
    expect(
      projectHqEventMessage({ type: 'hq.event', event: { ...validEvent, id: 123 } }),
    ).toBeNull();
    expect(
      projectHqEventMessage({ type: 'hq.event', event: { ...validEvent, seq: 'bad' } }),
    ).toBeNull();
    expect(projectHqEventMessage({ type: 'hq.event', event: { type: 'x' } })).toBeNull();
  });

  it('projects valid HQ alert messages and rejects malformed ones', () => {
    const validAlert = {
      type: 'hq.alert',
      severity: 'warn',
      message: 'disk low',
      timestamp: '2026-07-21T00:00:00.000Z',
    };
    expect(projectHqAlertMessage(validAlert)).toEqual({
      kind: 'hq-alert',
      alert: validAlert,
    });
    expect(
      projectHqAlertMessage({ type: 'hq.alert', severity: 'fatal', message: 'x', timestamp: 't' }),
    ).toBeNull();
    expect(
      projectHqAlertMessage({ type: 'hq.alert', severity: 'warn', message: 123, timestamp: 't' }),
    ).toBeNull();
    expect(
      projectHqAlertMessage({ type: 'hq.alert', severity: 'warn', message: 'x', timestamp: 99 }),
    ).toBeNull();
  });

  it('projects valid HQ command status messages and rejects malformed ones', () => {
    const validCommand = {
      commandId: 'cmd-1',
      type: 'steer',
      clientId: 'c1',
      enqueuedBy: 'tok-1',
      enqueuedAt: '2026-07-21T00:00:00.000Z',
      status: 'delivered',
    };
    expect(
      projectHqCommandStatusMessage({ type: 'hq.command_status', command: validCommand }),
    ).toEqual({
      kind: 'hq-command-status',
      command: validCommand,
    });
    expect(projectHqCommandStatusMessage({ type: 'hq.command_status', command: null })).toBeNull();
    expect(
      projectHqCommandStatusMessage({
        type: 'hq.command_status',
        command: { ...validCommand, status: 'invalid' },
      }),
    ).toBeNull();
    expect(
      projectHqCommandStatusMessage({
        type: 'hq.command_status',
        command: { ...validCommand, commandId: 123 },
      }),
    ).toBeNull();
  });
});
