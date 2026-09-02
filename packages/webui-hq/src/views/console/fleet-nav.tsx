/**
 * Fleet navigator — machine → project → client → agent, as a tree.
 *
 * Built from `buildNav`, which folds the same topology the Fleet Map draws, so
 * the two surfaces can never disagree about what exists.
 *
 * Collapse state tracks the COLLAPSED set, not the expanded one: a machine or
 * project that appears while the console is open shows up already open, with
 * no extra bookkeeping.
 */
import type { HqSnapshot } from '@wrongstack/core/hq';
import { Bot, ChevronRight, FolderGit2, MonitorSmartphone, SquareTerminal } from 'lucide-react';
import type * as React from 'react';
import { useMemo, useState } from 'react';
import { EmptyState, StatusDot } from '../../components/hq/primitives.js';
import { useHqStore } from '../../data/store/index.js';
import { buildNav } from '../../domain/fleet-nav-tree.js';
import { activityTone } from '../../domain/status-tone.js';
import { cn } from '../../lib/utils.js';

const ROW =
  'flex w-full items-center gap-1.5 px-1.5 py-1 text-left text-[11px] transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50';

function Caret({ open }: { open: boolean }): React.ReactElement {
  return (
    <ChevronRight
      className={cn(
        'size-3 shrink-0 text-muted-foreground transition-transform',
        open && 'rotate-90',
      )}
    />
  );
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
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = (id: string): void =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (machines.length === 0) {
    return (
      <EmptyState
        icon={MonitorSmartphone}
        title="No live sessions"
        hint="Open a WrongStack CLI, TUI or WebUI connected to this HQ."
        className="m-2"
      />
    );
  }

  return (
    <div role="tree" aria-label="Fleet navigator" data-testid="fleet-nav" className="py-1">
      {machines.map((machine) => {
        const machineOpen = !collapsed.has(machine.id);
        return (
          <div key={machine.id}>
            <button
              type="button"
              className={cn(ROW, 'font-medium')}
              onClick={() => toggle(machine.id)}
              aria-expanded={machineOpen}
            >
              <Caret open={machineOpen} />
              <MonitorSmartphone className="size-3 shrink-0" />
              <span className="truncate" title={machine.sub ?? machine.label}>
                {machine.label}
              </span>
            </button>

            {machineOpen &&
              machine.projects.map((project) => {
                const projectOpen = !collapsed.has(project.id);
                return (
                  <div key={project.id} className="pl-3">
                    <button
                      type="button"
                      className={ROW}
                      onClick={() => toggle(project.id)}
                      aria-expanded={projectOpen}
                    >
                      <Caret open={projectOpen} />
                      <FolderGit2 className="size-3 shrink-0" />
                      <span className="truncate" title={project.label}>
                        {project.label}
                      </span>
                    </button>

                    {projectOpen &&
                      project.clients.map((client) => {
                        const clientOpen = !collapsed.has(client.sessionId);
                        const clientSelected =
                          selectedSessionId === client.sessionId && selectedAgentId === null;
                        return (
                          <div key={client.sessionId} className="pl-3">
                            <div className="flex items-center">
                              {client.agents.length > 0 ? (
                                <button
                                  type="button"
                                  className="px-0.5 py-1"
                                  onClick={() => toggle(client.sessionId)}
                                  aria-label={clientOpen ? 'Collapse' : 'Expand'}
                                >
                                  <Caret open={clientOpen} />
                                </button>
                              ) : (
                                <span className="inline-block w-4" />
                              )}
                              <button
                                type="button"
                                data-testid="nav-client"
                                data-selected={clientSelected}
                                className={cn(
                                  ROW,
                                  clientSelected && 'bg-accent/60 font-medium text-foreground',
                                )}
                                disabled={client.synthetic}
                                title={
                                  client.synthetic ? 'waiting for session telemetry' : client.label
                                }
                                onClick={() => {
                                  if (client.synthetic) return;
                                  useHqStore.getState().selectSession(client.sessionId);
                                  if (client.clientId !== undefined) {
                                    useHqStore.getState().selectClient(client.clientId);
                                  }
                                }}
                              >
                                <StatusDot tone={activityTone(client.status)} />
                                <SquareTerminal className="size-3 shrink-0" />
                                <span className="truncate">{client.label}</span>
                                {client.agents.length > 0 && (
                                  <span className="tabular ml-auto text-[10px] text-muted-foreground">
                                    {client.agents.length}
                                  </span>
                                )}
                              </button>
                            </div>

                            {clientOpen &&
                              client.agents.map((agent) => {
                                // Scope the highlight to THIS session: every
                                // leader shares the id 'leader', so an
                                // agentId-only check lights up every leader.
                                const agentSelected =
                                  selectedSessionId === client.sessionId &&
                                  selectedAgentId === agent.id;
                                return (
                                  <button
                                    key={agent.id}
                                    type="button"
                                    data-testid="nav-agent"
                                    data-selected={agentSelected}
                                    title={agent.label}
                                    className={cn(
                                      ROW,
                                      'pl-6',
                                      agentSelected && 'bg-accent/60 font-medium text-foreground',
                                    )}
                                    onClick={() => {
                                      useHqStore.getState().selectAgent(client.sessionId, agent.id);
                                      if (client.clientId !== undefined) {
                                        useHqStore.getState().selectClient(client.clientId);
                                      }
                                    }}
                                  >
                                    <StatusDot tone={activityTone(agent.status)} />
                                    <Bot className="size-3 shrink-0" />
                                    <span className="truncate">{agent.label}</span>
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
