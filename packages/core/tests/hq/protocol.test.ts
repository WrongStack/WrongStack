import { describe, expect, it } from 'vitest';
import {
  createHqEventEnvelope,
  DEFAULT_HQ_REDACTION_POLICY,
  HQ_PROTOCOL_VERSION,
  type HqMailboxSnapshotPayload,
  type HqSnapshot,
  parseHqEventPayload,
  parseHqFrame,
} from '../../src/hq/protocol.js';

describe('HQ protocol', () => {
  it('creates versioned event envelopes with optional ids omitted when absent', () => {
    const event = createHqEventEnvelope({
      id: 'evt_1',
      type: 'session.status',
      timestamp: '2026-06-21T12:00:00.000Z',
      clientId: 'client_1',
      projectId: 'project_1',
      seq: 42,
      payload: { status: 'running' },
    });

    expect(event).toEqual({
      id: 'evt_1',
      type: 'session.status',
      schemaVersion: HQ_PROTOCOL_VERSION,
      timestamp: '2026-06-21T12:00:00.000Z',
      clientId: 'client_1',
      projectId: 'project_1',
      seq: 42,
      payload: { status: 'running' },
    });
    expect('sessionId' in event).toBe(false);
    expect('runId' in event).toBe(false);
  });

  it('includes optional session and run ids when provided', () => {
    const event = createHqEventEnvelope({
      id: 'evt_2',
      type: 'fleet.snapshot',
      timestamp: '2026-06-21T12:00:00.000Z',
      clientId: 'client_1',
      projectId: 'project_1',
      sessionId: 'session_1',
      runId: 'run_1',
      seq: 1,
      payload: { activeSubagents: 2 },
    });

    expect(event.sessionId).toBe('session_1');
    expect(event.runId).toBe('run_1');
  });

  it('supports mailbox snapshot events as first-class cross-project telemetry', () => {
    const payload: HqMailboxSnapshotPayload = {
      mailboxId: 'project_1:mailbox',
      scope: 'project',
      messages: [
        {
          messageId: 'msg_1',
          from: 'leader@a',
          to: '*',
          type: 'status',
          subject: 'Fleet done',
          priority: 'normal',
          timestamp: '2026-06-21T12:00:00.000Z',
          completed: false,
          unreadCount: 2,
          readCount: 1,
          hasBody: true,
          bodyPreview: 'Completed the HQ protocol phase',
        },
      ],
      agents: [
        {
          agentId: 'leader@a',
          name: 'Leader',
          sessionId: 'session_1',
          status: 'running',
          iterations: 3,
          toolCalls: 10,
          lastActivityAt: '2026-06-21T12:00:00.000Z',
          lastSeenAt: '2026-06-21T12:00:00.000Z',
          online: true,
          source: 'cli',
        },
      ],
      totals: {
        messages: 1,
        unread: 2,
        incomplete: 1,
        highPriority: 0,
        onlineAgents: 1,
      },
    };

    const event = createHqEventEnvelope({
      id: 'evt_mailbox_1',
      type: 'mailbox.snapshot',
      timestamp: '2026-06-21T12:00:00.000Z',
      clientId: 'client_1',
      projectId: 'project_1',
      seq: 3,
      payload,
    });

    expect(event.type).toBe('mailbox.snapshot');
    expect(event.payload.totals.unread).toBe(2);
    expect(event.payload.messages[0]?.bodyPreview).toBe('Completed the HQ protocol phase');
  });

  it('includes mailbox rollups in the global snapshot shape', () => {
    const snapshot: HqSnapshot = {
      generatedAt: '2026-06-21T12:00:00.000Z',
      clients: [],
      projects: [],
      sessions: [],
      fleets: [],
      mailboxes: [
        {
          mailboxId: 'project_1:mailbox',
          projectId: 'project_1',
          scope: 'project',
          messageCount: 5,
          unreadCount: 2,
          incompleteCount: 1,
          highPriorityCount: 1,
          onlineAgentCount: 3,
          lastActivityAt: '2026-06-21T12:00:00.000Z',
        },
      ],
      totals: {
        activeProjects: 1,
        activeClients: 1,
        activeSessions: 0,
        activeSubagents: 0,
        unreadMailboxMessages: 2,
        incompleteMailboxMessages: 1,
        totalCostUsd: 0,
      },
    };

    expect(snapshot.mailboxes[0]?.unreadCount).toBe(2);
    expect(snapshot.totals.incompleteMailboxMessages).toBe(1);
  });

  it('defaults to full HQ content', () => {
    expect(DEFAULT_HQ_REDACTION_POLICY).toEqual({
      rawContent: true,
      toolArgs: 'full',
      paths: 'full',
    });
  });
});

describe('parseHqFrame', () => {
  const validHello = {
    type: 'client.hello',
    payload: {
      protocolVersion: HQ_PROTOCOL_VERSION,
      client: {
        clientId: 'cli_1',
        kind: 'tui',
        machineId: 'm_1',
        startedAt: '2026-06-21T00:00:00.000Z',
      },
      project: {
        projectId: 'p_1',
        projectRoot: '/tmp/proj',
        projectName: 'proj',
        machineId: 'm_1',
        workspaceKind: 'git',
      },
      capabilities: ['telemetry.publish'],
    },
  };

  it('parses a valid client.hello frame with narrow-typed payload', () => {
    const result = parseHqFrame(JSON.stringify(validHello));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.type).toBe('client.hello');
    if (result.frame.type !== 'client.hello') return;
    expect(result.frame.payload.protocolVersion).toBe(HQ_PROTOCOL_VERSION);
    expect(result.frame.payload.client.clientId).toBe('cli_1');
    expect(result.frame.payload.capabilities).toEqual(['telemetry.publish']);
  });

  it('recognizes a mailbox-serve HQ client', () => {
    const frame = structuredClone(validHello);
    frame.payload.client.kind = 'mailbox';
    frame.payload.capabilities = ['telemetry.publish', 'mailbox.summary', 'mailbox.serve'];
    const result = parseHqFrame(JSON.stringify(frame));
    expect(result.ok).toBe(true);
    if (!result.ok || result.frame.type !== 'client.hello') return;
    expect(result.frame.payload.client.kind).toBe('mailbox');
    expect(result.frame.payload.capabilities).toContain('mailbox.serve');
  });

  it('parses a valid client.event frame with the embedded HqEventEnvelope', () => {
    const event = {
      type: 'client.event',
      event: {
        id: 'evt_1',
        type: 'mailbox.snapshot',
        schemaVersion: HQ_PROTOCOL_VERSION,
        timestamp: '2026-06-21T00:00:00.000Z',
        clientId: 'cli_1',
        projectId: 'p_1',
        seq: 1,
        payload: { mailboxId: 'm_1', messages: [], agents: [], totals: {} },
      },
    };
    const result = parseHqFrame(JSON.stringify(event));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.type).toBe('client.event');
    if (result.frame.type !== 'client.event') return;
    expect(result.frame.event.id).toBe('evt_1');
    expect(result.frame.event.seq).toBe(1);
  });

  it('parses a valid client.command_poll frame with optional fields omitted', () => {
    const poll = { type: 'client.command_poll', clientId: 'cli_1', projectId: 'p_1' };
    const result = parseHqFrame(JSON.stringify(poll));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.type).toBe('client.command_poll');
    if (result.frame.type !== 'client.command_poll') return;
    expect(result.frame.clientId).toBe('cli_1');
    expect(result.frame.projectId).toBe('p_1');
  });

  it('preserves the command poll cursor and bounded limit', () => {
    const result = parseHqFrame(
      JSON.stringify({
        type: 'client.command_poll',
        clientId: 'cli_1',
        projectId: 'p_1',
        afterCommandId: 'cmd_24',
        limit: 25,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.frame.type !== 'client.command_poll') return;
    expect(result.frame.afterCommandId).toBe('cmd_24');
    expect(result.frame.limit).toBe(25);
  });

  it('parses a valid client.command_ack frame including the status enum', () => {
    const ack = {
      type: 'client.command_ack',
      clientId: 'cli_1',
      projectId: 'p_1',
      commandId: 'cmd_1',
      status: 'completed',
    };
    const result = parseHqFrame(JSON.stringify(ack));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.type).toBe('client.command_ack');
    if (result.frame.type !== 'client.command_ack') return;
    expect(result.frame.status).toBe('completed');
    expect(result.frame.commandId).toBe('cmd_1');
  });

  it('accepts a Buffer input in addition to a string', () => {
    const result = parseHqFrame(Buffer.from(JSON.stringify(validHello), 'utf8'));
    expect(result.ok).toBe(true);
  });

  it('returns invalid-json for non-JSON payloads', () => {
    const result = parseHqFrame('{not json');
    expect(result).toEqual({ ok: false, reason: 'invalid-json' });
  });

  it('returns unknown-type for top-level frames whose type is not in the client union', () => {
    const result = parseHqFrame(JSON.stringify({ type: 'hq.snapshot', snapshot: {} }));
    expect(result).toEqual({ ok: false, reason: 'unknown-type' });
  });

  it('returns malformed for a top-level non-object payload', () => {
    const result = parseHqFrame(JSON.stringify('hello'));
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns malformed for an object without a string type', () => {
    const result = parseHqFrame(JSON.stringify({ type: 42 }));
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns malformed for a client.hello missing required client identity', () => {
    const bad = {
      type: 'client.hello',
      payload: {
        protocolVersion: HQ_PROTOCOL_VERSION,
        client: { clientId: 'cli_1' }, // missing kind, machineId, startedAt
        project: validHello.payload.project,
        capabilities: [],
      },
    };
    const result = parseHqFrame(JSON.stringify(bad));
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns malformed for a client.event whose event envelope is missing seq', () => {
    const bad = {
      type: 'client.event',
      event: {
        id: 'evt_1',
        type: 'mailbox.snapshot',
        schemaVersion: HQ_PROTOCOL_VERSION,
        timestamp: '2026-06-21T00:00:00.000Z',
        clientId: 'cli_1',
        projectId: 'p_1',
        // seq missing
        payload: {},
      },
    };
    const result = parseHqFrame(JSON.stringify(bad));
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns malformed for a client.command_poll missing clientId', () => {
    const result = parseHqFrame(JSON.stringify({ type: 'client.command_poll', projectId: 'p_1' }));
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns malformed for a client.command_ack missing status', () => {
    const bad = {
      type: 'client.command_ack',
      clientId: 'cli_1',
      projectId: 'p_1',
      commandId: 'cmd_1',
    };
    const result = parseHqFrame(JSON.stringify(bad));
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects invalid capability, workspace, schema, poll-limit, and ack-status values', () => {
    const badCapability = structuredClone(validHello);
    badCapability.payload.capabilities = ['control.execute'];
    expect(parseHqFrame(JSON.stringify(badCapability))).toEqual({
      ok: false,
      reason: 'malformed',
    });

    const badWorkspace = structuredClone(validHello);
    badWorkspace.payload.project.workspaceKind = 'local';
    expect(parseHqFrame(JSON.stringify(badWorkspace))).toEqual({
      ok: false,
      reason: 'malformed',
    });

    const badSchema = {
      type: 'client.event',
      event: {
        id: 'evt_bad',
        type: 'custom.event',
        schemaVersion: 99,
        timestamp: new Date().toISOString(),
        clientId: 'cli_1',
        projectId: 'p_1',
        seq: 1,
        payload: {},
      },
    };
    expect(parseHqFrame(JSON.stringify(badSchema))).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(
      parseHqFrame(
        JSON.stringify({
          type: 'client.command_poll',
          clientId: 'cli_1',
          projectId: 'p_1',
          limit: 0,
        }),
      ),
    ).toEqual({ ok: false, reason: 'malformed' });
    expect(
      parseHqFrame(
        JSON.stringify({
          type: 'client.command_ack',
          clientId: 'cli_1',
          projectId: 'p_1',
          commandId: 'cmd_1',
          status: 'maybe',
        }),
      ),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  // ── client.resume (sync ladder — workstream B1) ──────────────────────────

  it('parses a valid client.resume frame with the required lastSeqSeen field', () => {
    const frame = { type: 'client.resume', lastSeqSeen: 42 };
    const result = parseHqFrame(JSON.stringify(frame));
    expect(result.ok).toBe(true);
    if (result.ok && result.frame.type === 'client.resume') {
      expect(result.frame.lastSeqSeen).toBe(42);
    }
  });

  it('parses client.resume with optional clientId and projectId', () => {
    const frame = {
      type: 'client.resume',
      lastSeqSeen: 100,
      clientId: 'c1',
      projectId: 'p1',
    };
    const result = parseHqFrame(JSON.stringify(frame));
    expect(result.ok).toBe(true);
    if (result.ok && result.frame.type === 'client.resume') {
      expect(result.frame.clientId).toBe('c1');
      expect(result.frame.projectId).toBe('p1');
    }
  });

  it('rejects client.resume with negative lastSeqSeen', () => {
    const frame = { type: 'client.resume', lastSeqSeen: -1 };
    const result = parseHqFrame(JSON.stringify(frame));
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects client.resume with non-integer lastSeqSeen', () => {
    const frame = { type: 'client.resume', lastSeqSeen: 'high' };
    const result = parseHqFrame(JSON.stringify(frame));
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects client.resume with float lastSeqSeen (Number.isSafeInteger arm)', () => {
    // Pins the integer-fraction check: a regression that drops just
    // `typeof === 'number'` but keeps `Number.isSafeInteger` would let
    // this through. `'high'` (string) covers the typeof arm; `1.5`
    // covers the integer-arm.
    const frame = { type: 'client.resume', lastSeqSeen: 1.5 };
    const result = parseHqFrame(JSON.stringify(frame));
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects client.resume with missing lastSeqSeen', () => {
    const result = parseHqFrame('{"type": "client.resume"}');
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('parseHqEventPayload', () => {
  const validMailboxSnapshot = {
    mailboxId: 'p_1:mailbox',
    scope: 'project' as const,
    messages: [
      {
        mailId: 'm_1',
        messageId: 'm_1',
        from: 'agent-a',
        to: 'agent-b',
        subject: 'Need review',
        priority: 'normal',
        timestamp: '2026-06-21T00:00:00.000Z',
        completed: false,
        hasBody: true,
      },
    ],
    agents: [
      {
        agentId: 'agent-a',
        name: 'Agent A',
        sessionId: 's_1',
        status: 'online',
        iterations: 1,
        toolCalls: 0,
        lastActivityAt: '2026-06-21T00:00:00.000Z',
        lastSeenAt: '2026-06-21T00:00:00.000Z',
        online: true,
      },
    ],
    totals: { messages: 1, unread: 1, incomplete: 0, highPriority: 0, onlineAgents: 1 },
  };

  it('accepts a well-formed mailbox.snapshot payload', () => {
    const result = parseHqEventPayload('mailbox.snapshot', validMailboxSnapshot);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual(validMailboxSnapshot);
    }
  });

  it('rejects a mailbox.snapshot payload missing mailboxId', () => {
    const { mailboxId: _unused, ...rest } = validMailboxSnapshot;
    void _unused;
    const result = parseHqEventPayload('mailbox.snapshot', rest);
    expect(result).toEqual({ ok: false, reason: 'malformed-payload' });
  });

  it('rejects a mailbox.snapshot payload with a wrong scope literal', () => {
    const result = parseHqEventPayload('mailbox.snapshot', {
      ...validMailboxSnapshot,
      scope: 'regional',
    });
    expect(result).toEqual({ ok: false, reason: 'malformed-payload' });
  });

  it('rejects a mailbox.snapshot payload whose totals is missing a field', () => {
    const result = parseHqEventPayload('mailbox.snapshot', {
      ...validMailboxSnapshot,
      totals: { messages: 1, unread: 1, incomplete: 0, highPriority: 0 }, // no onlineAgents
    });
    expect(result).toEqual({ ok: false, reason: 'malformed-payload' });
  });

  it('rejects a mailbox.snapshot payload whose message summary is missing hasBody', () => {
    const { hasBody: _dropped, ...messageWithoutHasBody } = validMailboxSnapshot.messages[0];
    void _dropped;
    const result = parseHqEventPayload('mailbox.snapshot', {
      ...validMailboxSnapshot,
      messages: [messageWithoutHasBody],
    });
    expect(result).toEqual({ ok: false, reason: 'malformed-payload' });
  });

  it('accepts a mailbox.event payload with a known action', () => {
    const result = parseHqEventPayload('mailbox.event', {
      mailboxId: 'p_1:mailbox',
      action: 'message.sent',
      summary: 'agent-a → agent-b: review',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a mailbox.event payload with an unknown action', () => {
    const result = parseHqEventPayload('mailbox.event', {
      mailboxId: 'p_1:mailbox',
      action: 'message.exploded',
      summary: 'oops',
    });
    expect(result).toEqual({ ok: false, reason: 'malformed-payload' });
  });

  it('rejects a mailbox.event payload whose optional message is malformed', () => {
    const result = parseHqEventPayload('mailbox.event', {
      mailboxId: 'p_1:mailbox',
      action: 'message.sent',
      message: { from: 'agent-a' }, // missing required fields
    });
    expect(result).toEqual({ ok: false, reason: 'malformed-payload' });
  });

  it('passes through unvalidated event types as unknown', () => {
    const result = parseHqEventPayload('session.started', { sessionId: 's_1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual({ sessionId: 's_1' });
    }
  });

  it('validates credential-free governance snapshots and rejects control dispositions', () => {
    const valid = {
      schemaVersion: 1,
      projectId: 'p_1',
      observedAt: '2026-08-02T12:00:00.000Z',
      available: true,
      signal: {
        level: 'warning',
        code: 'attachment_broker_degraded',
        operatorAction: 'investigate',
        executionDisposition: 'continue',
      },
      daemon: { pid: 123, startedAt: '2026-08-02T11:00:00.000Z' },
      attachmentBroker: {
        state: 'retry_wait',
        health: 'degraded',
        consecutiveFailures: 3,
        pendingRevocations: 1,
        auditHealthy: true,
      },
    };

    expect(parseHqEventPayload('governance.snapshot', valid)).toEqual({
      ok: true,
      payload: valid,
    });
    expect(
      parseHqEventPayload('governance.snapshot', {
        ...valid,
        signal: { ...valid.signal, executionDisposition: 'stop' },
      }),
    ).toEqual({ ok: false, reason: 'malformed-payload' });
    expect(
      parseHqEventPayload('governance.snapshot', {
        ...valid,
        attachmentBroker: { ...valid.attachmentBroker, pendingRevocations: -1 },
      }),
    ).toEqual({ ok: false, reason: 'malformed-payload' });
    expect(
      parseHqEventPayload('governance.snapshot', {
        ...valid,
        credential: 'must-never-cross-hq-boundary',
      }),
    ).toEqual({ ok: false, reason: 'malformed-payload' });
  });

  // ── Phase 1 telemetry event payloads ────────────────────────────────────

  it('validates fleet.snapshot payloads', () => {
    const valid = {
      runId: 'run-1',
      activeSubagents: 2,
      queuedTasks: 1,
      completedTasks: 3,
      failedTasks: 0,
      subagents: [{ subagentId: 's1', status: 'running' }],
    };
    expect(parseHqEventPayload('fleet.snapshot', valid).ok).toBe(true);
    expect(
      parseHqEventPayload('fleet.snapshot', {
        ...valid,
        maxSpawns: 256,
        usedSpawns: 103,
        remainingSpawns: 153,
        ceilingMismatch: true,
        effectiveSource: 'maxSpawns=profile',
      }).ok,
    ).toBe(true);
    expect(parseHqEventPayload('fleet.snapshot', { ...valid, runId: 123 }).ok).toBe(false);
    expect(
      parseHqEventPayload('fleet.snapshot', { ...valid, subagents: [{ subagentId: 'x' }] }).ok,
    ).toBe(false);
    expect(parseHqEventPayload('fleet.snapshot', { ...valid, activeSubagents: 'x' }).ok).toBe(
      false,
    );
    expect(parseHqEventPayload('fleet.snapshot', { ...valid, maxSpawns: 'x' }).ok).toBe(false);
  });

  it('validates fleet.event payloads', () => {
    expect(parseHqEventPayload('fleet.event', { runId: 'r1', event: 'spawned' }).ok).toBe(true);
    expect(parseHqEventPayload('fleet.event', { event: 'spawned' }).ok).toBe(false);
  });

  it('validates brain.event payloads', () => {
    expect(parseHqEventPayload('brain.event', { kind: 'decision_requested', at: 1000 }).ok).toBe(
      true,
    );
    expect(parseHqEventPayload('brain.event', { kind: 'bogus', at: 1000 }).ok).toBe(false);
    expect(parseHqEventPayload('brain.event', { kind: 'intervention', at: 'x' }).ok).toBe(false);
    expect(parseHqEventPayload('brain.event', { kind: 'intervention' }).ok).toBe(false);
  });

  it('validates worktree.event payloads', () => {
    expect(
      parseHqEventPayload('worktree.event', { kind: 'allocated', handleId: 'h1', ownerId: 'p1' })
        .ok,
    ).toBe(true);
    expect(parseHqEventPayload('worktree.event', { kind: 'allocated', handleId: 'h1' }).ok).toBe(
      false,
    );
    expect(
      parseHqEventPayload('worktree.event', { kind: 'bogus', handleId: 'h1', ownerId: 'p1' }).ok,
    ).toBe(false);
  });

  it('validates tool.started payloads', () => {
    expect(parseHqEventPayload('tool.started', { toolName: 'bash' }).ok).toBe(true);
    expect(parseHqEventPayload('tool.started', { name: 'bash' }).ok).toBe(false);
  });

  it('validates tool.completed payloads', () => {
    expect(
      parseHqEventPayload('tool.completed', {
        toolName: 'bash',
        status: 'success',
        durationMs: 100,
      }).ok,
    ).toBe(true);
    expect(
      parseHqEventPayload('tool.completed', {
        toolName: 'bash',
        status: 'success',
        durationMs: 'x',
      }).ok,
    ).toBe(false);
  });

  it('validates session.usage payloads (accepts partial numeric object)', () => {
    expect(parseHqEventPayload('session.usage', { inputTokens: 100, costUsd: 0.01 }).ok).toBe(true);
    expect(parseHqEventPayload('session.usage', {}).ok).toBe(true);
    expect(parseHqEventPayload('session.usage', [1, 2, 3]).ok).toBe(false);
    expect(parseHqEventPayload('session.usage', null).ok).toBe(false);
  });

  // ── peer.rehydrate (workstream A1) ──────────────────────────────────────

  it('validates a well-formed peer.rehydrate payload', () => {
    const payload = {
      projectId: 'p1',
      machineId: 'm1',
      leaderClientId: 'c1',
      previousLeaderHandle: 'leader-1',
      reason: 'graceful',
      detectedAt: '2026-01-01T00:00:00Z',
    };
    expect(parseHqEventPayload('peer.rehydrate', payload).ok).toBe(true);
  });

  // Locks enum closure: every value in HQ_PEER_REHYDRATE_REASONS must be
  // accepted by the guard. A future regression that drops a reason from
  // the enum would otherwise go undetected.
  it('accepts every HqPeerRehydrateReason enum value for peer.rehydrate', () => {
    const reasons = ['graceful', 'crash', 'heartbeat-timeout', 'auth-revoked'] as const;
    for (const reason of reasons) {
      const payload = {
        projectId: 'p1',
        machineId: 'm1',
        leaderClientId: 'c1',
        previousLeaderHandle: 'leader-1',
        reason,
        detectedAt: '2026-01-01T00:00:00Z',
      };
      expect(parseHqEventPayload('peer.rehydrate', payload).ok).toBe(true);
    }
  });

  it('accepts peer.rehydrate with optional rehydrateHint and rehydrateCommandId', () => {
    const payload = {
      projectId: 'p1',
      machineId: 'm1',
      leaderClientId: 'c1',
      previousLeaderHandle: 'leader-1',
      reason: 'graceful',
      detectedAt: '2026-01-01T00:00:00Z',
      rehydrateHint: 'open the last-active SDD spec',
      rehydrateCommandId: 'cmd-42',
    };
    expect(parseHqEventPayload('peer.rehydrate', payload).ok).toBe(true);
  });

  it('rejects peer.rehydrate with rehydrateHint exceeding 280 chars', () => {
    const payload = {
      projectId: 'p1',
      machineId: 'm1',
      leaderClientId: 'c1',
      previousLeaderHandle: 'leader-1',
      reason: 'graceful',
      detectedAt: '2026-01-01T00:00:00Z',
      rehydrateHint: 'x'.repeat(281),
    };
    expect(parseHqEventPayload('peer.rehydrate', payload).ok).toBe(false);
  });

  it('accepts peer.rehydrate with rehydrateHint at the exact 280-char boundary', () => {
    // Pins the boundary: 280 must be accepted (the limit is inclusive),
    // 281 must be rejected. A regression that changed the comparison to
    // `>=` would break 280-character hints.
    const payload = {
      projectId: 'p1',
      machineId: 'm1',
      leaderClientId: 'c1',
      previousLeaderHandle: 'leader-1',
      reason: 'graceful',
      detectedAt: '2026-01-01T00:00:00Z',
      rehydrateHint: 'x'.repeat(280),
    };
    expect(parseHqEventPayload('peer.rehydrate', payload).ok).toBe(true);
  });

  it('rejects peer.rehydrate with invalid reason', () => {
    const payload = {
      projectId: 'p1',
      machineId: 'm1',
      leaderClientId: 'c1',
      previousLeaderHandle: 'leader-1',
      reason: 'not-a-valid-reason',
      detectedAt: '2026-01-01T00:00:00Z',
    };
    expect(parseHqEventPayload('peer.rehydrate', payload).ok).toBe(false);
  });

  it('rejects peer.rehydrate with missing required fields', () => {
    const base = {
      projectId: 'p1',
      machineId: 'm1',
      leaderClientId: 'c1',
      previousLeaderHandle: 'leader-1',
      reason: 'graceful',
      detectedAt: '2026-01-01T00:00:00Z',
    };
    for (const field of [
      'projectId',
      'machineId',
      'leaderClientId',
      'previousLeaderHandle',
      'reason',
      'detectedAt',
    ]) {
      const dropped = { ...base };
      delete (dropped as Record<string, unknown>)[field];
      expect(parseHqEventPayload('peer.rehydrate', dropped).ok).toBe(false);
    }
  });

  it('rejects peer.rehydrate with malformed detectedAt', () => {
    const payload = {
      projectId: 'p1',
      machineId: 'm1',
      leaderClientId: 'c1',
      previousLeaderHandle: 'leader-1',
      reason: 'graceful',
      detectedAt: 'not-a-date',
    };
    expect(parseHqEventPayload('peer.rehydrate', payload).ok).toBe(false);
  });

  it('rejects peer.rehydrate with non-object payload', () => {
    expect(parseHqEventPayload('peer.rehydrate', 'string').ok).toBe(false);
    expect(parseHqEventPayload('peer.rehydrate', 42).ok).toBe(false);
    expect(parseHqEventPayload('peer.rehydrate', null).ok).toBe(false);
    expect(parseHqEventPayload('peer.rehydrate', [1, 2, 3]).ok).toBe(false);
  });

  it('explicitly asserts peer.rehydrate guard is permissive about extra fields (genuinely unknown key)', () => {
    // This test pins the deliberate behavior: the guard ignores unknown
    // fields. The `unknownExtraField` key is NOT in the typed
    // HqPeerRehydratePayload interface, so it is a genuinely unknown
    // field that the guard does not validate. If a future author
    // hardens the guard to reject unknown fields, this test will fail —
    // that is the intent. The test body asserts `.ok === true` because
    // the guard is permissive about extra fields.
    const payload = {
      projectId: 'p1',
      machineId: 'm1',
      leaderClientId: 'c1',
      previousLeaderHandle: 'leader-1',
      reason: 'graceful',
      detectedAt: '2026-01-01T00:00:00Z',
      unknownExtraField: 'genuinely unknown to the guard',
    };
    expect(parseHqEventPayload('peer.rehydrate', payload).ok).toBe(true);
  });

  it('rejects peer.rehydrate with wrong rehydrateHint type', () => {
    const payload = {
      projectId: 'p1',
      machineId: 'm1',
      leaderClientId: 'c1',
      previousLeaderHandle: 'leader-1',
      reason: 'graceful',
      detectedAt: '2026-01-01T00:00:00Z',
      rehydrateHint: 42, // wrong type
    };
    expect(parseHqEventPayload('peer.rehydrate', payload).ok).toBe(false);
  });

  it('rejects peer.rehydrate with wrong rehydrateCommandId type', () => {
    const payload = {
      projectId: 'p1',
      machineId: 'm1',
      leaderClientId: 'c1',
      previousLeaderHandle: 'leader-1',
      reason: 'graceful',
      detectedAt: '2026-01-01T00:00:00Z',
      rehydrateCommandId: true, // wrong type
    };
    expect(parseHqEventPayload('peer.rehydrate', payload).ok).toBe(false);
  });

  // ── peer.lost (workstream A1) ──────────────────────────────────────────

  it('validates a well-formed peer.lost payload', () => {
    const payload = {
      projectId: 'p1',
      machineId: 'm1',
      leaderClientId: 'c1',
      previousLeaderHandle: 'leader-1',
      reason: 'heartbeat-timeout',
      detectedAt: '2026-01-01T00:00:00Z',
    };
    expect(parseHqEventPayload('peer.lost', payload).ok).toBe(true);
  });

  it('rejects peer.lost with missing required fields', () => {
    const base = {
      projectId: 'p1',
      machineId: 'm1',
      leaderClientId: 'c1',
      previousLeaderHandle: 'leader-1',
      reason: 'graceful',
      detectedAt: '2026-01-01T00:00:00Z',
    };
    for (const field of [
      'projectId',
      'machineId',
      'leaderClientId',
      'previousLeaderHandle',
      'reason',
      'detectedAt',
    ]) {
      const dropped = { ...base };
      delete (dropped as Record<string, unknown>)[field];
      expect(parseHqEventPayload('peer.lost', dropped).ok).toBe(false);
    }
  });

  it('rejects peer.lost with invalid reason', () => {
    const payload = {
      projectId: 'p1',
      machineId: 'm1',
      leaderClientId: 'c1',
      previousLeaderHandle: 'leader-1',
      reason: 'mystery',
      detectedAt: '2026-01-01T00:00:00Z',
    };
    expect(parseHqEventPayload('peer.lost', payload).ok).toBe(false);
  });

  it('rejects peer.lost with non-object payload', () => {
    expect(parseHqEventPayload('peer.lost', 'string').ok).toBe(false);
    expect(parseHqEventPayload('peer.lost', 42).ok).toBe(false);
    expect(parseHqEventPayload('peer.lost', null).ok).toBe(false);
    expect(parseHqEventPayload('peer.lost', [1, 2, 3]).ok).toBe(false);
  });
});
