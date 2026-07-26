/**
 * GM-P0.2 — Tests for the shared mailbox boundary codecs.
 *
 * These tests verify that every codec entry point (send, query, ack,
 * registration, heartbeat) correctly validates, normalizes, and rejects
 * inputs from untrusted boundaries.
 */
import { describe, expect, it } from 'vitest';
import {
  MailboxValidationError,
  parseMailboxSendInput,
  parseMailboxQueryInput,
  parseMailboxAckInput,
  parseMailboxRegistrationInput,
  parseMailboxHeartbeatInput,
} from '../../src/coordination/mailbox-codecs.js';
import type { MailboxActorContext } from '../../src/coordination/mailbox-types.js';

// ── Fixtures ──────────────────────────────────────────────────────────

function actor(overrides: Partial<MailboxActorContext> = {}): MailboxActorContext {
  return {
    actorId: 'leader@a1b2c3d4',
    projectId: 'test-project',
    kind: 'agent',
    capabilities: new Set([
      'mail.send.informational',
      'mail.send.actionable',
      'mail.read.self',
      'mail.ack.self',
      'mail.events.self',
      'mail.presence.register.self',
      'mail.presence.heartbeat.self',
      'mail.presence.read',
    ]),
    authMode: 'identity-token',
    recipientAliases: new Set(['leader']),
    sessionId: 'sess-1',
    ...overrides,
  };
}

const allCapsActor = actor({
  capabilities: new Set([
    'mail.send.directive',
    'mail.send.actionable',
    'mail.send.informational',
    'mail.read.all',
    'mail.read.self',
    'mail.ack.self',
    'mail.events.all',
    'mail.events.self',
    'mail.presence.register.self',
    'mail.presence.heartbeat.self',
    'mail.presence.deregister.self',
    'mail.presence.read',
    'mail.retention.purge',
    'mail.retention.clear',
    'mail.admin.receipts',
  ]),
});

// ── Send codec ───────────────────────────────────────────────────────

describe('parseMailboxSendInput', () => {
  it('parses a valid note send', () => {
    const result = parseMailboxSendInput(
      { to: 'worker', subject: 'hello', body: 'do thing' },
      actor(),
    );
    expect(result.type).toBe('note');
    expect(result.to).toBe('worker');
    expect(result.priority).toBe('normal');
    expect(result.audience).toBe('all');
  });

  it('normalizes "all" to "*"', () => {
    const result = parseMailboxSendInput(
      { to: 'all', subject: 'hi', body: 'b' },
      actor(),
    );
    expect(result.to).toBe('*');
    expect(result.type).toBe('broadcast');
  });

  it('normalizes @session using actor sessionId', () => {
    const result = parseMailboxSendInput(
      { to: '@session', subject: 'hi', body: 'b' },
      actor({ sessionId: 'sess-99' }),
    );
    expect(result.to).toBe('@session:sess-99');
    expect(result.type).toBe('broadcast');
  });

  it('accepts explicit type and validates assign requires specific recipient', () => {
    expect(() =>
      parseMailboxSendInput(
        { to: '*', type: 'assign', subject: 's', body: 'b' },
        actor(),
      ),
    ).toThrow(MailboxValidationError);

    const result = parseMailboxSendInput(
      { to: 'worker', type: 'assign', subject: 's', body: 'b' },
      actor(),
    );
    expect(result.type).toBe('assign');
  });

  it('requires mail.send.directive capability for steer', () => {
    expect(() =>
      parseMailboxSendInput(
        { to: 'worker', type: 'steer', subject: 's', body: 'b' },
        actor(),
      ),
    ).toThrow(MailboxValidationError);

    const result = parseMailboxSendInput(
      { to: 'worker', type: 'steer', subject: 's', body: 'b' },
      allCapsActor,
    );
    expect(result.type).toBe('steer');
  });

  it('rejects control type', () => {
    expect(() =>
      parseMailboxSendInput(
        { to: 'worker', type: 'control', subject: 's', body: 'b' },
        allCapsActor,
      ),
    ).toThrow(MailboxValidationError);
  });

  it('rejects unknown fields', () => {
    expect(() =>
      parseMailboxSendInput(
        { to: 'w', subject: 's', body: 'b', from: 'attacker' },
        actor(),
      ),
    ).toThrow(MailboxValidationError);
  });

  it('rejects missing required fields', () => {
    expect(() => parseMailboxSendInput({ subject: 's', body: 'b' }, actor())).toThrow(MailboxValidationError);
    expect(() => parseMailboxSendInput({ to: 'w', body: 'b' }, actor())).toThrow(MailboxValidationError);
    expect(() => parseMailboxSendInput({ to: 'w', subject: 's' }, actor())).toThrow(MailboxValidationError);
  });

  it('rejects invalid priority', () => {
    expect(() =>
      parseMailboxSendInput(
        { to: 'w', subject: 's', body: 'b', priority: 'urgent' },
        actor(),
      ),
    ).toThrow(MailboxValidationError);
  });

  it('rejects invalid audience', () => {
    expect(() =>
      parseMailboxSendInput(
        { to: 'w', subject: 's', body: 'b', audience: 'everyone' },
        actor(),
      ),
    ).toThrow(MailboxValidationError);
  });

  it('accepts valid replyTo', () => {
    const result = parseMailboxSendInput(
      { to: 'w', subject: 's', body: 'b', replyTo: 'msg-001' },
      actor(),
    );
    expect(result.replyTo).toBe('msg-001');
  });

  it('rejects informational-only actor sending actionable', () => {
    const infoActor = actor({
      capabilities: new Set(['mail.send.informational']),
    });
    expect(() =>
      parseMailboxSendInput(
        { to: 'w', type: 'ask', subject: 's', body: 'b' },
        infoActor,
      ),
    ).toThrow(MailboxValidationError);
  });
});

// ── Query codec ──────────────────────────────────────────────────────

describe('parseMailboxQueryInput', () => {
  it('parses an empty query', () => {
    const result = parseMailboxQueryInput({}, actor());
    expect(result.readerRole).toBe('leader');
    expect(result.to).toBeUndefined();
  });

  it('parses query fields', () => {
    const result = parseMailboxQueryInput(
      { to: 'worker', from: 'leader', type: 'note', limit: 10, includeDeleted: true },
      actor(),
    );
    expect(result.to).toBe('worker');
    expect(result.from).toBe('leader');
    expect(result.type).toBe('note');
    expect(result.limit).toBe(10);
    expect(result.includeDeleted).toBe(true);
  });

  it('derives readerRole from actor, not body', () => {
    const result = parseMailboxQueryInput(
      { readerRole: 'admin' },
      actor({ role: 'leader' }),
    );
    expect(result.readerRole).toBe('leader');
  });

  it('tolerates unknown fields (forward compatibility)', () => {
    expect(() =>
      parseMailboxQueryInput({ futureField: 'ok' }, actor()),
    ).not.toThrow();
  });

  it('rejects invalid type', () => {
    expect(() =>
      parseMailboxQueryInput({ type: 'mystery' }, actor()),
    ).toThrow(MailboxValidationError);
  });

  it('rejects negative limit', () => {
    expect(() =>
      parseMailboxQueryInput({ limit: -1 }, actor()),
    ).toThrow(MailboxValidationError);
  });

  it('requires mail.read.self capability', () => {
    const noReadActor = actor({
      capabilities: new Set(['mail.send.informational']),
    });
    expect(() => parseMailboxQueryInput({}, noReadActor)).toThrow(MailboxValidationError);
  });

  it('accepts mail.read.all as implying mail.read.self', () => {
    const adminActor = actor({ capabilities: new Set(['mail.read.all']) });
    expect(() => parseMailboxQueryInput({}, adminActor)).not.toThrow();
  });
});

// ── Ack codec ────────────────────────────────────────────────────────

describe('parseMailboxAckInput', () => {
  it('parses a valid mark-read', () => {
    const result = parseMailboxAckInput(
      { messageId: 'msg-1', read: true },
      actor(),
    );
    expect(result.messageId).toBe('msg-1');
    expect(result.read).toBe(true);
    expect(result.completed).toBeUndefined();
    expect(result.readerId).toBe('leader@a1b2c3d4');
  });

  it('derives readerId from actor, not body', () => {
    const result = parseMailboxAckInput(
      { messageId: 'msg-1', read: true, readerId: 'attacker' },
      actor(),
    );
    expect(result.readerId).toBe('leader@a1b2c3d4');
  });

  it('legacy mode accepts body-supplied readerId', () => {
    const legacyActor = actor({ authMode: 'legacy-operator' });
    const result = parseMailboxAckInput(
      { messageId: 'msg-1', read: true, readerId: 'operator-1' },
      legacyActor,
    );
    expect(result.readerId).toBe('operator-1');
  });

  it('rejects unknown fields', () => {
    expect(() =>
      parseMailboxAckInput({ messageId: 'm', read: true, from: 'x' }, actor()),
    ).toThrow(MailboxValidationError);
  });

  it('rejects missing messageId', () => {
    expect(() => parseMailboxAckInput({ read: true }, actor())).toThrow(MailboxValidationError);
  });

  it('requires mail.ack.self capability', () => {
    const noAckActor = actor({
      capabilities: new Set(['mail.send.informational', 'mail.read.self']),
    });
    expect(() =>
      parseMailboxAckInput({ messageId: 'm', read: true }, noAckActor),
    ).toThrow(MailboxValidationError);
  });
});

// ── Registration codec ───────────────────────────────────────────────

describe('parseMailboxRegistrationInput', () => {
  it('parses a valid registration', () => {
    const result = parseMailboxRegistrationInput(
      { name: 'Leader', role: 'leader' },
      actor(),
    );
    expect(result.agentId).toBe('leader@a1b2c3d4');
    expect(result.sessionId).toBe('sess-1');
    expect(result.name).toBe('Leader');
    expect(result.role).toBe('leader');
    expect(result.status).toBe('idle');
    expect(result.iterations).toBe(0);
  });

  it('derives agentId from actor', () => {
    const result = parseMailboxRegistrationInput(
      { name: 'X', agentId: 'attacker' },
      actor(),
    );
    expect(result.agentId).toBe('leader@a1b2c3d4');
  });

  it('legacy mode accepts body-supplied agentId', () => {
    const legacyActor = actor({ authMode: 'legacy-operator' });
    const result = parseMailboxRegistrationInput(
      { name: 'X', agentId: 'external-1', sessionId: 'ext-sess' },
      legacyActor,
    );
    expect(result.agentId).toBe('external-1');
    expect(result.sessionId).toBe('ext-sess');
  });

  it('rejects unknown fields', () => {
    expect(() =>
      parseMailboxRegistrationInput({ name: 'X', secret: 'y' }, actor()),
    ).toThrow(MailboxValidationError);
  });

  it('rejects missing name', () => {
    expect(() => parseMailboxRegistrationInput({}, actor())).toThrow(MailboxValidationError);
  });
});

// ── Heartbeat codec ──────────────────────────────────────────────────

describe('parseMailboxHeartbeatInput', () => {
  it('parses a valid heartbeat', () => {
    const result = parseMailboxHeartbeatInput(
      { status: 'running', currentTool: 'read', iterations: 5, toolCalls: 12 },
      actor(),
    );
    expect(result.agentId).toBe('leader@a1b2c3d4');
    expect(result.sessionId).toBe('sess-1');
    expect(result.status).toBe('running');
    expect(result.currentTool).toBe('read');
    expect(result.iterations).toBe(5);
  });

  it('derives agentId from actor', () => {
    const result = parseMailboxHeartbeatInput(
      { agentId: 'attacker' },
      actor(),
    );
    expect(result.agentId).toBe('leader@a1b2c3d4');
  });

  it('rejects unknown fields', () => {
    expect(() =>
      parseMailboxHeartbeatInput({ projectId: 'x' }, actor()),
    ).toThrow(MailboxValidationError);
  });
});

// ── Error shape consistency ──────────────────────────────────────────

describe('MailboxValidationError shape', () => {
  it('has stable code, field, and message', () => {
    try {
      parseMailboxSendInput({ subject: 's', body: 'b' }, actor());
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as MailboxValidationError;
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.field).toBe('to');
      expect(err.message).toContain('to');
      expect(err.name).toBe('MailboxValidationError');
    }
  });

  it('FORBIDDEN code for capability violations', () => {
    try {
      parseMailboxSendInput(
        { to: 'w', type: 'steer', subject: 's', body: 'b' },
        actor(),
      );
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as MailboxValidationError;
      expect(err.code).toBe('FORBIDDEN');
      expect(err.field).toBe('capabilities');
    }
  });
});
