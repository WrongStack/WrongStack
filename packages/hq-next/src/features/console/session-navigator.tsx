'use client';

/**
 * Conversation picker for the Console: every live session grouped by project,
 * with its agents underneath, and a filter that matches project, machine,
 * session and agent names.
 *
 * The tree comes from the same retained fleet topology the Fleet Map draws, so
 * a terminal that is briefly reconnecting stays visible (dimmed) instead of
 * vanishing — and taking the operator's selection with it.
 */
import { useHqStore } from '@hq/data/store/index';
import { buildNavFromTopology, type NavClient } from '@hq/domain/fleet-nav-tree';
import { buildFleetTopology } from '@hq/domain/fleet-topology';
import { activityTone, type HqTone } from '@hq/domain/status-tone';
import { useRetainedFleetTopology } from '@hq/domain/use-fleet-retention';
import type { HqSnapshot } from '@wrongstack/hq';
import { Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { groupByProject } from './model';

const TONE_DOT: Record<HqTone, string> = {
  active: 'bg-success',
  running: 'bg-success',
  info: 'bg-info',
  warn: 'bg-warning',
  error: 'bg-destructive',
  idle: 'bg-muted-foreground/50',
};

export function SessionNavigator({
  snapshot,
  selectedSessionId,
  selectedAgentId,
}: {
  snapshot: HqSnapshot | null;
  selectedSessionId: string | null;
  selectedAgentId: string | null;
}): ReactNode {
  const live = useMemo(() => buildFleetTopology(snapshot), [snapshot]);
  const topology = useRetainedFleetTopology(live);
  const machines = useMemo(() => buildNavFromTopology(topology), [topology]);
  const [query, setQuery] = useState('');
  const groups = useMemo(() => groupByProject(machines, query), [machines, query]);

  const choose = (client: NavClient, agentId: string | null): void => {
    if (client.synthetic) return;
    const store = useHqStore.getState();
    if (agentId === null) store.selectSession(client.sessionId);
    else store.selectAgent(client.sessionId, agentId);
    if (client.clientId !== undefined) store.selectClient(client.clientId);
  };

  return (
    <nav aria-label="Conversations" className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border p-3">
        <label className="flex h-9 items-center gap-2 border border-border bg-background px-2.5 text-sm focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter projects, machines, agents"
            aria-label="Filter conversations"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {groups.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">
            {machines.length === 0
              ? 'No session is open on any connected machine.'
              : 'Nothing matches this filter.'}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.key} className="mb-4 last:mb-0">
              <header className="px-2 pb-1.5">
                <h3 className="truncate text-sm font-semibold">{group.label}</h3>
                <p className="truncate text-xs text-muted-foreground">
                  {group.machines.join(' · ')}
                </p>
              </header>
              <ul className="flex flex-col gap-0.5">
                {group.sessions.map((client) => {
                  const sessionActive =
                    selectedSessionId === client.sessionId && selectedAgentId === null;
                  return (
                    <li key={client.sessionId}>
                      <button
                        type="button"
                        disabled={client.synthetic}
                        aria-current={sessionActive ? 'true' : undefined}
                        title={
                          client.synthetic
                            ? 'Waiting for session telemetry'
                            : client.retained === true
                              ? 'Not reporting — reconnecting'
                              : undefined
                        }
                        onClick={() => choose(client, null)}
                        className={cn(
                          'flex w-full items-center gap-2.5 border-l-2 px-2.5 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50',
                          sessionActive
                            ? 'border-primary bg-accent/60 font-medium'
                            : 'border-transparent hover:bg-muted/60',
                          client.retained === true && 'opacity-60',
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn('size-2 shrink-0', TONE_DOT[activityTone(client.status)])}
                        />
                        <span className="min-w-0 flex-1 truncate">{client.label}</span>
                        {/* The label already names the client kind; the machine is
                            only worth repeating when the project spans several. */}
                        {group.machines.length > 1 && (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {client.machine}
                          </span>
                        )}
                      </button>
                      {client.agents.length > 0 && (
                        <ul className="ml-4 border-l border-border">
                          {client.agents.map((agent) => {
                            // Every leader shares the id `leader`, so the highlight
                            // must be scoped to this session as well.
                            const agentActive =
                              selectedSessionId === client.sessionId &&
                              selectedAgentId === agent.id;
                            return (
                              <li key={agent.id}>
                                <button
                                  type="button"
                                  aria-current={agentActive ? 'true' : undefined}
                                  onClick={() => choose(client, agent.id)}
                                  className={cn(
                                    'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm',
                                    agentActive
                                      ? 'bg-accent/60 font-medium'
                                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                                    agent.retained === true && 'opacity-60',
                                  )}
                                >
                                  <span
                                    aria-hidden
                                    className={cn(
                                      'size-1.5 shrink-0',
                                      TONE_DOT[activityTone(agent.status)],
                                    )}
                                  />
                                  <span className="truncate">{agent.label}</span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </nav>
  );
}
