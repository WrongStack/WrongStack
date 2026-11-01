import type { FleetTopology, FleetTopologyNode } from '@hq/domain/fleet-topology-types';
import { describe, expect, it } from 'vitest';
import { buildFleetTree, consoleHref, fleetFigures } from '../src/features/fleet/model';

const node = (
  id: string,
  kind: FleetTopologyNode['kind'],
  extra: Partial<FleetTopologyNode> = {},
): FleetTopologyNode => ({
  id,
  kind,
  label: id,
  chips: [],
  ...extra,
});

const topology: FleetTopology = {
  nodes: [
    node('m:zeta', 'machine'),
    node('m:atlas', 'machine'),
    node('p:ws', 'project'),
    node('t:quiet', 'terminal', { sessionId: 's-quiet', status: 'active' }),
    node('t:busy', 'terminal', { sessionId: 's-busy', status: 'active' }),
    node('a:idle', 'agent', { sessionId: 's-busy', agentId: 'idle', status: 'idle' }),
    node('a:work', 'agent', { sessionId: 's-busy', agentId: 'work', status: 'running' }),
    node('a:wait', 'agent', { sessionId: 's-busy', agentId: 'wait', status: 'waiting_user' }),
  ],
  edges: [
    { id: 'e1', source: 'm:atlas', target: 'p:ws' },
    { id: 'e2', source: 'p:ws', target: 't:quiet' },
    { id: 'e3', source: 'p:ws', target: 't:busy' },
    { id: 'e4', source: 't:busy', target: 'a:idle' },
    { id: 'e5', source: 't:busy', target: 'a:work' },
    { id: 'e6', source: 't:busy', target: 'a:wait' },
    { id: 'dangling', source: 'p:ws', target: 'gone' },
  ],
};

describe('buildFleetTree', () => {
  it('nests machine → project → terminal → agent and ignores dangling edges', () => {
    const tree = buildFleetTree(topology);
    expect(tree.map((machine) => machine.node.id)).toEqual(['m:atlas', 'm:zeta']);
    expect(tree[0]?.projects[0]?.terminals.map((terminal) => terminal.node.id)).toEqual([
      't:busy',
      't:quiet',
    ]);
  });

  it('lists agents that need a human before working ones, and working before idle', () => {
    const agents = buildFleetTree(topology)[0]?.projects[0]?.terminals[0]?.agents.map(
      (agent) => agent.id,
    );
    expect(agents).toEqual(['a:wait', 'a:work', 'a:idle']);
  });
});

describe('fleetFigures', () => {
  it('counts machines, terminals, working agents and agents waiting on a human', () => {
    expect(fleetFigures(topology)).toEqual({
      machines: 2,
      terminals: 2,
      agents: 3,
      working: 1,
      needsYou: 1,
    });
  });
});

describe('consoleHref', () => {
  it('links sessions and agents to the console and refuses nodes without a transcript', () => {
    expect(consoleHref(node('t', 'terminal', { sessionId: 's 1' }))).toBe(
      '/fleet/console/?session=s+1',
    );
    expect(consoleHref(node('a', 'agent', { sessionId: 's1', agentId: 'leader' }))).toBe(
      '/fleet/console/?session=s1&agent=leader',
    );
    expect(consoleHref(node('m', 'machine'))).toBeNull();
    expect(
      consoleHref(node('t', 'terminal', { sessionId: 's', isSyntheticSession: true })),
    ).toBeNull();
    expect(
      consoleHref(node('t', 'terminal', { sessionId: 's', serviceMode: 'mailbox-serve' })),
    ).toBeNull();
  });
});
