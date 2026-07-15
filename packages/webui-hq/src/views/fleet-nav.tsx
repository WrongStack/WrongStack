/**
 * FleetNav — the machine → project → client → agent selector tree for the
 * Console. Replaces the flat session dropdown: the same hierarchy the Fleet
 * Topology shows, but as a collapsible sidebar you pick sessions and agents
 * from. Built from the shared buildFleetTopology output so it always agrees
 * with the map.
 */
import type { HqSnapshot } from '@wrongstack/core';
import { Bot, ChevronRight, FolderGit2, MonitorSmartphone, SquareTerminal } from 'lucide-react';
import type React from 'react';
import { useMemo, useState } from 'react';
import { useHqStore } from '../store.js';
import { buildFleetTopology, type FleetTopologyNode } from './fleet-topology.js';

interface NavAgent {
  id: string;
  label: string;
  status?: string | undefined;
}
interface NavClient {
  sessionId: string;
  label: string;
  clientKind?: string | undefined;
  status?: string | undefined;
  synthetic: boolean;
  agents: NavAgent[];
}
interface NavProject {
  id: string;
  label: string;
  clients: NavClient[];
}
interface NavMachine {
  id: string;
  label: string;
  sub?: string | undefined;
  projects: NavProject[];
}

/** Fold the flat topology nodes into the machine→project→client→agent tree.
 *  Exported for tests. */
export function buildNav(snapshot: HqSnapshot | null): NavMachine[] {
  const topo = buildFleetTopology(snapshot);
  const machines: NavMachine[] = [];
  const machineById = new Map<string, NavMachine>();
  const projectById = new Map<string, NavProject>();
  const clientBySession = new Map<string, NavClient>();

  const machineKey = (n: FleetTopologyNode) => `machine:${n.machineId}`;
  const projectKey = (n: FleetTopologyNode) => `project:${n.machineId}:${n.projectId}`;

  for (const n of topo.nodes) {
    if (n.kind !== 'machine') continue;
    const m: NavMachine = { id: n.id, label: n.label, sub: n.sub, projects: [] };
    machineById.set(n.id, m);
    machines.push(m);
  }
  for (const n of topo.nodes) {
    if (n.kind !== 'project') continue;
    const machine = machineById.get(machineKey(n));
    if (machine === undefined) continue;
    const p: NavProject = { id: n.id, label: n.label, clients: [] };
    projectById.set(n.id, p);
    machine.projects.push(p);
  }
  for (const n of topo.nodes) {
    if (n.kind !== 'terminal' || n.sessionId === undefined) continue;
    const project = projectById.get(projectKey(n));
    if (project === undefined) continue;
    const c: NavClient = {
      sessionId: n.sessionId,
      label: n.label,
      clientKind: n.clientKind,
      status: n.status,
      synthetic: n.isSyntheticSession === true,
      agents: [],
    };
    clientBySession.set(n.sessionId, c);
    project.clients.push(c);
  }
  for (const n of topo.nodes) {
    if (n.kind !== 'agent' || n.sessionId === undefined || n.agentId === undefined) continue;
    const client = clientBySession.get(n.sessionId);
    if (client === undefined) continue;
    client.agents.push({ id: n.agentId, label: n.label, status: n.status });
  }
  // Drop empty machines/projects that ended up with no clients (e.g. a
  // machine whose only session just closed).
  return machines
    .map((m) => ({ ...m, projects: m.projects.filter((p) => p.clients.length > 0) }))
    .filter((m) => m.projects.length > 0);
}

function dotClass(status: string | undefined): string {
  if (status === 'active' || status === 'running' || status === 'streaming') return 'active';
  if (status === 'waiting_user') return 'warn';
  if (status === 'error' || status === 'stale' || status === 'closing') return 'error';
  return 'idle';
}

export function FleetNav({
  snapshot,
  selectedSessionId,
  selectedAgentId,
}: {
  snapshot: HqSnapshot | null;
  selectedSessionId: string | null;
  selectedAgentId: string | null;
}): React.ReactElement {
  const machines = useMemo(() => buildNav(snapshot), [snapshot]);
  // Collapsed nodes (default: everything expanded). Tracking the collapsed
  // set rather than the expanded set means new machines/projects show up
  // open without extra bookkeeping.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (machines.length === 0) {
    return (
      <div className="hq-fleetnav">
        <div className="hq-empty hq-pad-md">
          No live sessions. Open a WrongStack CLI/TUI/WebUI connected to HQ.
        </div>
      </div>
    );
  }

  return (
    <div className="hq-fleetnav" role="tree" aria-label="Fleet navigator">
      {machines.map((machine) => {
        const mOpen = !collapsed.has(machine.id);
        return (
          <div key={machine.id} className="hq-nav-machine">
            <button
              type="button"
              className="hq-nav-row machine"
              onClick={() => toggle(machine.id)}
              aria-expanded={mOpen}
            >
              <ChevronRight size={12} className={'hq-nav-caret' + (mOpen ? ' open' : '')} />
              <MonitorSmartphone size={13} />
              <span className="hq-nav-label" title={machine.sub ?? machine.label}>
                {machine.label}
              </span>
            </button>
            {mOpen &&
              machine.projects.map((project) => {
                const pOpen = !collapsed.has(project.id);
                return (
                  <div key={project.id} className="hq-nav-project">
                    <button
                      type="button"
                      className="hq-nav-row project"
                      onClick={() => toggle(project.id)}
                      aria-expanded={pOpen}
                    >
                      <ChevronRight size={12} className={'hq-nav-caret' + (pOpen ? ' open' : '')} />
                      <FolderGit2 size={13} />
                      <span className="hq-nav-label" title={project.label}>
                        {project.label}
                      </span>
                    </button>
                    {pOpen &&
                      project.clients.map((client) => {
                        const cOpen = !collapsed.has(client.sessionId);
                        const clientSelected =
                          selectedSessionId === client.sessionId && selectedAgentId === null;
                        return (
                          <div key={client.sessionId} className="hq-nav-client">
                            <div className="hq-nav-clientrow">
                              {client.agents.length > 0 ? (
                                <button
                                  type="button"
                                  className="hq-nav-caretbtn"
                                  onClick={() => toggle(client.sessionId)}
                                  aria-label={cOpen ? 'Collapse' : 'Expand'}
                                >
                                  <ChevronRight
                                    size={12}
                                    className={'hq-nav-caret' + (cOpen ? ' open' : '')}
                                  />
                                </button>
                              ) : (
                                <span className="hq-nav-caretbtn" />
                              )}
                              <button
                                type="button"
                                className={'hq-nav-row client' + (clientSelected ? ' selected' : '')}
                                onClick={() => useHqStore.getState().selectSession(client.sessionId)}
                                title={client.synthetic ? 'waiting for session telemetry' : client.label}
                              >
                                <span className={'hq-nav-dot ' + dotClass(client.status)} />
                                <SquareTerminal size={12} />
                                <span className="hq-nav-label">{client.label}</span>
                                {client.agents.length > 0 && (
                                  <span className="hq-nav-count">{client.agents.length}</span>
                                )}
                              </button>
                            </div>
                            {cOpen &&
                              client.agents.map((agent) => {
                                // Scope the highlight to THIS session — every
                                // leader shares id 'leader', so an agentId-only
                                // check would light up every leader at once.
                                const agentSelected =
                                  selectedSessionId === client.sessionId &&
                                  selectedAgentId === agent.id;
                                return (
                                  <button
                                    key={agent.id}
                                    type="button"
                                    className={
                                      'hq-nav-row agent' + (agentSelected ? ' selected' : '')
                                    }
                                    onClick={() => useHqStore.getState().selectAgent(client.sessionId, agent.id)}
                                    title={agent.label}
                                  >
                                    <span className={'hq-nav-dot ' + dotClass(agent.status)} />
                                    <Bot size={12} />
                                    <span className="hq-nav-label">{agent.label}</span>
                                  </button>
                                );
                              })}
                          </div>
                        );
                      })}
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
