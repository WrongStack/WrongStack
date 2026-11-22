/**
 * F1157 — the actor-less reserved-identity guard must use the mailbox's
 * canonical identity base (`mailboxIdentityBase`: split on `@` or `#`,
 * trimmed, lower-cased). Splitting only on `@` let `leader#x` and
 * ` leader@x` through, although every other mailbox predicate
 * (`isMailboxLeader`, `isMailboxMessageVisibleTo`) treats them as `leader`.
 */
import { describe, expect, it } from 'vitest';
import {
  validateAck,
  validateAgentHeartbeat,
  validateAgentRegistration,
  validateSend,
} from '../src/mailbox-http-validation.js';
import { isMailboxLeader } from '../src/mailbox-predicates.js';

const surfaces = {
  'send.from': (id: string) =>
    validateSend({ from: id, to: 'agent-b', type: 'note', subject: 's', body: 'b' }),
  'ack.readerId': (id: string) => validateAck({ messageId: 'm1', readerId: id }),
  'register.agentId': (id: string) => validateAgentRegistration({ agentId: id, name: 'n', pid: 1 }),
  'heartbeat.agentId': (id: string) => validateAgentHeartbeat({ agentId: id }),
} as const;

describe('mailbox HTTP reserved identity guard (F1157)', () => {
  it.each(['leader#peer', ' leader@peer', 'LEADER#1', 'fleet#1', ' hq', 'tech-stack-consumer#2'])(
    'rejects the reserved-base variant %j on every actor-less surface',
    (id) => {
      for (const validate of Object.values(surfaces)) {
        expect(() => validate(id)).toThrow(/reserved internal agent id/);
      }
    },
  );

  it('treats the rejected variants as the leader elsewhere (the reason they must be refused)', () => {
    expect(isMailboxLeader('leader#peer')).toBe(true);
    expect(isMailboxLeader(' leader@peer')).toBe(true);
  });

  it('still accepts ordinary and lookalike-but-distinct identities', () => {
    for (const id of ['external-a', 'leaderboard', 'leader-2@peer', 'my-hq']) {
      for (const validate of Object.values(surfaces)) {
        expect(() => validate(id)).not.toThrow();
      }
    }
  });
});
