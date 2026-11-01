/**
 * Console rules that decide what the operator sees and what they can send.
 */

import type { ConsoleControlTarget } from '@hq/domain/console-target';
import type { NavMachine } from '@hq/domain/fleet-nav-tree';
import type { HqTranscriptEntry } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import {
  type CommandReceipt,
  channelState,
  groupByProject,
  pendingReceipts,
} from '../src/features/console/model';

const T = '2026-10-31T12:00:00.000Z';
const later = (seconds: number): string => new Date(Date.parse(T) + seconds * 1000).toISOString();

describe('pendingReceipts', () => {
  const steer: CommandReceipt = {
    commandId: 'c1',
    type: 'steer',
    target: 'leader',
    preview: 'run the tests first',
    createdAt: T,
  };
  const abort: CommandReceipt = {
    ...steer,
    commandId: 'c2',
    type: 'abort',
    preview: 'Interrupt leader',
  };
  const user = (text: string, ts: string): HqTranscriptEntry => ({ ts, role: 'user', text });

  it('keeps the optimistic copy until the same message echoes back', () => {
    expect(pendingReceipts([steer], [])).toEqual([steer]);
    expect(pendingReceipts([steer], [user('  run the tests first  ', later(5))])).toEqual([]);
  });

  it('does not treat an older identical message as the echo', () => {
    expect(pendingReceipts([steer], [user('run the tests first', later(-600))])).toEqual([steer]);
  });

  it('ignores assistant text and always keeps interrupt receipts', () => {
    const assistant: HqTranscriptEntry = {
      ts: later(1),
      role: 'assistant',
      text: 'run the tests first',
    };
    expect(pendingReceipts([steer, abort], [assistant])).toEqual([steer, abort]);
  });
});

describe('channelState', () => {
  const target = (controllable: boolean, mailboxServeActive: boolean) =>
    ({ controllable, mailboxServeActive }) as ConsoleControlTarget;

  it('prefers the live control channel, then the mailbox, else read-only', () => {
    expect(channelState(null)).toBe('none');
    expect(channelState(target(true, true))).toBe('live');
    expect(channelState(target(false, true))).toBe('mailbox');
    expect(channelState(target(false, false))).toBe('read-only');
  });
});

describe('groupByProject', () => {
  const client = (sessionId: string, label: string, agents: string[] = []) => ({
    sessionId,
    label,
    clientKind: 'tui',
    synthetic: false,
    agents: agents.map((id) => ({ id, label: id })),
  });
  const machines: NavMachine[] = [
    {
      id: 'm-atlas',
      label: 'atlas',
      projects: [
        {
          id: 'p-ws',
          label: 'WrongStack',
          clients: [client('s1', 'TUI 4120', ['leader', 'reviewer'])],
        },
        { id: 'p-bill', label: 'billing-api', clients: [client('s2', 'CLI 881')] },
      ],
    },
    {
      id: 'm-kestrel',
      label: 'kestrel',
      projects: [{ id: 'p-ws-2', label: 'WrongStack', clients: [client('s3', 'WebUI tab')] }],
    },
  ];

  it('puts the same project from two machines in one group, sorted by name', () => {
    const groups = groupByProject(machines, '');
    expect(
      groups.map((group) => [group.label, group.machines, group.sessions.map((s) => s.sessionId)]),
    ).toEqual([
      ['billing-api', ['atlas'], ['s2']],
      ['WrongStack', ['atlas', 'kestrel'], ['s1', 's3']],
    ]);
  });

  it('filters on machine, session and agent names, case-insensitively', () => {
    expect(
      groupByProject(machines, 'KESTREL').flatMap((g) => g.sessions.map((s) => s.sessionId)),
    ).toEqual(['s3']);
    expect(
      groupByProject(machines, 'review').flatMap((g) => g.sessions.map((s) => s.sessionId)),
    ).toEqual(['s1']);
    expect(groupByProject(machines, 'nothing-like-this')).toEqual([]);
  });
});
