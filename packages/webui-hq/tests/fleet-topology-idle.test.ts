/**
 * filterFleetTopologyByIdle — the pure model behind the HQ "Hide idle"
 * toggle shared by the Fleet Map and the Cockpit.
 *
 * Semantics under test:
 *   - hideIdle=false returns the input untouched (same reference)
 *   - idle agents vanish; running/waiting_user/errored agents stay
 *   - a terminal whose every agent was hidden folds away with them
 *   - terminals that never had agents (synthetic placeholders) stay
 *   - the machine/project spine stays; no edge points at a hidden node
 */
import type { HqSessionAgentSummary, HqSnapshot } from '@wrongstack/core/hq';
import { describe, expect, it } from 'vitest';
import {
  buildFleetTopology,
  filterFleetTopologyByIdle,
  isIdleAgentStatus,
} from '../src/domain/fleet-topology.js';

const T = '2026-10-07T09:00:00.000Z';

function agent(id: string, status: HqSessionAgentSummary['status']): HqSessionAgentSummary {
  return { id, name: id, status, iterations: 1, toolCalls: 2, lastActivityAt: T };
}

function session(
  sessionId: string,
  agents: HqSessionAgentSummary[],
): NonNullable<HqSnapshot['liveSessions']>[number] {
  return {
    sessionId,
    clientKind: 'cli',
    machineId: 'machine-1',
    hostname: 'devbox',
    projectId: 'proj-1',
    projectName: 'Project 1',
    projectRoot: 'D:/proj',
    status: 'active',
    startedAt: T,
    lastActivityAt: T,
    agentCount: agents.length,
    agents,
  };
}

const SNAPSHOT: HqSnapshot = {
  generatedAt: T,
  clients: [],
  projects: [],
  sessions: [],
  fleets: [],
  mailboxes: [],
  totals: {
    activeProjects: 1,
    activeClients: 0,
    activeSessions: 3,
    activeSubagents: 6,
    unreadMailboxMessages: 0,
    incompleteMailboxMessages: 0,
    totalCostUsd: 1.25,
  },
  machines: [
    {
      machineId: 'machine-1',
      hostname: 'devbox',
      clientCount: 1,
      sessionCount: 3,
      agentCount: 6,
      projectIds: ['proj-1'],
      lastActivityAt: T,
    },
  ],
  liveSessions: [
    session('sess-mixed', [
      agent('runner', 'running'),
      agent('asker', 'waiting_user'),
      agent('lounger', 'idle'),
    ]),
    session('sess-all-idle', [agent('dozer', 'idle'), agent('sleeper', 'idle')]),
    session('sess-synthetic', []),
  ],
};

function terminalSessionIds(topology: { nodes: { kind: string; sessionId?: string }[] }): string[] {
  return topology.nodes
    .filter((node) => node.kind === 'terminal')
    .map((node) => node.sessionId)
    .filter((id): id is string => id !== undefined);
}

describe('isIdleAgentStatus', () => {
  it('reads working, waiting and errored agents as attended', () => {
    for (const status of ['active', 'running', 'streaming', 'waiting_user', 'error']) {
      expect(isIdleAgentStatus(status)).toBe(false);
    }
  });

  it('reads dormant and unknown statuses as idle', () => {
    expect(isIdleAgentStatus('idle')).toBe(true);
    expect(isIdleAgentStatus('offline')).toBe(true);
    expect(isIdleAgentStatus(undefined)).toBe(true);
  });
});

describe('filterFleetTopologyByIdle', () => {
  const full = buildFleetTopology(SNAPSHOT);

  it('returns the topology untouched when hideIdle is off', () => {
    expect(filterFleetTopologyByIdle(full, false)).toBe(full);
  });

  it('hides idle agents and keeps working, waiting and errored ones', () => {
    const filtered = filterFleetTopologyByIdle(full, true);
    const agentIds = filtered.nodes
      .filter((node) => node.kind === 'agent')
      .map((node) => node.agentId);
    expect(agentIds).toContain('runner');
    expect(agentIds).toContain('asker');
    expect(agentIds).not.toContain('lounger');
    expect(agentIds).not.toContain('dozer');
    expect(agentIds).not.toContain('sleeper');
    expect(agentIds).toHaveLength(2);
  });

  it('folds a terminal whose every agent was hidden but keeps synthetic terminals', () => {
    const filtered = filterFleetTopologyByIdle(full, true);
    const terminals = terminalSessionIds(filtered);
    expect(terminals).toContain('sess-mixed');
    expect(terminals).not.toContain('sess-all-idle');
    expect(terminals).toContain('sess-synthetic');
  });

  it('keeps the machine/project spine and leaves no dangling edges', () => {
    const filtered = filterFleetTopologyByIdle(full, true);
    expect(filtered.nodes.some((node) => node.kind === 'machine')).toBe(true);
    expect(filtered.nodes.some((node) => node.kind === 'project')).toBe(true);
    const nodeIds = new Set(filtered.nodes.map((node) => node.id));
    for (const edge of filtered.edges) {
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
    }
  });
});
