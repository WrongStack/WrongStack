/**
 * Cross-surface mailbox contract fixtures.
 *
 * GM-P0.11: Every fixture is a tuple of (canonical test case, expected result,
 * applicable surfaces). The contract-matrix runner iterates over all
 * (fixture, surface) pairs and asserts equivalent behavior.
 *
 * The baseline fixtures from GM-P0.0 (fixtures/mailbox/index.ts) cover
 * the low-level message shapes. This module adds the *canonical input*
 * fixtures that every surface must handle equivalently.
 */

import type { MailboxMessageType } from '../../src/coordination/mailbox-types.js';

/** A surface through which mailbox operations can be performed. */
export type MailboxSurface = 'core' | 'tool' | 'http' | 'ws' | 'slash';

/** Category of the test case. */
export type MatrixCaseCategory = 'send-valid' | 'send-invalid' | 'query-valid' | 'ack-valid';

/**
 * A single contract-matrix row.
 */
export interface MatrixFixture {
  /** Human-readable label for test output. */
  label: string;
  /** The canonical input payload (for the surface adapter to reshape). */
  input: Record<string, unknown>;
  /** Expected result: match object pattern, or stable error object. */
  expected: Record<string, unknown>;
  /** Which surfaces this fixture applies to. */
  surfaces: MailboxSurface[];
  /** Category for grouping. */
  category: MatrixCaseCategory;
  /** Surfaces that explicitly do NOT support this case. */
  unsupported?: MailboxSurface[] | undefined;
}

/** Every valid send type with a direct recipient. */
export function allValidDirectSends(): MatrixFixture[] {
  const types: MailboxMessageType[] = [
    'note',
    'ask',
    'assign',
    'steer',
    'btw',
    'broadcast',
    'status',
    'result',
    'review',
  ];
  return types.map((type) => ({
    label: `send-${type}-direct`,
    input: { to: 'agent-b', subject: 'Test', body: 'Hello', type },
    expected: { ok: true },
    surfaces: ['core', 'tool', 'http', 'ws', 'slash'],
    category: 'send-valid',
    unsupported: ['http'],
  }));
}

/** Valid send to broadcast. */
export function allValidBroadcastSends(): MatrixFixture[] {
  const types: MailboxMessageType[] = ['note', 'btw', 'broadcast', 'status', 'result', 'review'];
  return types.map((type) => ({
    label: `send-${type}-broadcast`,
    input: { to: '*', subject: 'Broadcast', body: 'Hello all', type },
    expected: { ok: true },
    surfaces: ['core', 'tool', 'http', 'ws', 'slash'],
    category: 'send-valid',
    unsupported: ['http'],
  }));
}

/**
 * Invalid send combinations that MUST be rejected by every surface.
 */
export function allInvalidSends(): MatrixFixture[] {
  return [
    {
      label: 'send-control-rejected',
      input: { to: 'agent-b', subject: 'X', body: 'X', type: 'control' },
      expected: { error: /control/i },
      surfaces: ['core', 'tool', 'http', 'ws', 'slash'],
      category: 'send-invalid',
    },
    {
      label: 'send-assign-to-broadcast',
      input: { to: '*', subject: 'X', body: 'X', type: 'assign' },
      expected: { error: /assign/i },
      surfaces: ['core', 'tool', 'http', 'ws', 'slash'],
      category: 'send-invalid',
    },
    {
      label: 'send-steer-to-broadcast',
      input: { to: '*', subject: 'X', body: 'X', type: 'steer' },
      expected: { error: /steer/i },
      surfaces: ['core', 'tool', 'http', 'ws', 'slash'],
      category: 'send-invalid',
    },
  ];
}

/** Known valid query shapes. */
export function allValidQueries(): MatrixFixture[] {
  return [
    {
      label: 'query-direct',
      input: { to: 'agent-b' },
      expected: { ok: true },
      surfaces: ['core', 'tool', 'http', 'ws'],
      category: 'query-valid',
    },
    {
      label: 'query-reply-to',
      input: { to: 'agent-b', replyTo: 'parent-1' },
      expected: { ok: true },
      surfaces: ['core', 'tool', 'http', 'ws'],
      category: 'query-valid',
    },
  ];
}

/** Known valid ack shapes. */
export function allValidAcks(): MatrixFixture[] {
  return [
    {
      label: 'ack-read',
      input: { messageId: 'm1', read: true },
      expected: { ok: true },
      surfaces: ['core', 'tool', 'http', 'ws'],
      category: 'ack-valid',
    },
  ];
}

/**
 * Every fixture in the matrix.
 */
export function allMatrixFixtures(): MatrixFixture[] {
  return [
    ...allValidDirectSends(),
    ...allValidBroadcastSends(),
    ...allInvalidSends(),
    ...allValidQueries(),
    ...allValidAcks(),
  ];
}
