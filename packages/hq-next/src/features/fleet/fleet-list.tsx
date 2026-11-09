'use client';

import type { FleetTopology, FleetTopologyNode } from '@hq/domain/fleet-topology-types';
/**
 * The fleet as readable cards: one per machine, projects inside, each
 * terminal a row with its agents beneath. Anything with a transcript opens
 * the peek panel; what needs a human sorts to the top of its project.
 */
import { activityTone, type HqTone } from '@hq/domain/status-tone';
import { FolderGit2, MonitorSmartphone } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import { buildFleetTree, consoleHref, isLiveStatus } from './model';
import { RuntimeBadge } from './runtime-badge';

export const TONE_DOT: Record<HqTone, string> = {
  active: 'bg-success',
  running: 'bg-success',
  info: 'bg-info',
  warn: 'bg-warning',
  error: 'bg-destructive',
  idle: 'bg-muted-foreground/50',
};

const AGENT_STATUS: Record<string, string> = {
  running: 'Working',
  streaming: 'Writing',
  waiting_user: 'Waiting for you',
  error: 'Error',
  idle: 'Idle',
};

function Dot({ status }: { status: string | undefined }): ReactNode {
  return (
    <span
      aria-hidden
      className={cn(
        'size-2 shrink-0',
        TONE_DOT[activityTone(status)],
        isLiveStatus(status) && 'animate-pulse',
      )}
    />
  );
}

export function FleetList({
  topology,
  selectedId,
  onSelect,
}: {
  topology: FleetTopology;
  selectedId: string | null;
  onSelect: (node: FleetTopologyNode) => void;
}): ReactNode {
  const machines = useMemo(() => buildFleetTree(topology), [topology]);

  const row = (node: FleetTopologyNode, children: ReactNode, className?: string): ReactNode => {
    const openable = consoleHref(node) !== null;
    return openable ? (
      <button
        type="button"
        aria-current={selectedId === node.id ? 'true' : undefined}
        onClick={() => onSelect(node)}
        className={cn(
          'flex w-full items-center gap-3 text-left hover:bg-muted/60',
          selectedId === node.id && 'bg-accent/60',
          node.retained === true && 'opacity-60',
          className,
        )}
      >
        {children}
      </button>
    ) : (
      <div
        title={node.isSyntheticSession === true ? 'Waiting for session telemetry' : undefined}
        className={cn('flex items-center gap-3', node.retained === true && 'opacity-60', className)}
      >
        {children}
      </div>
    );
  };

  return (
    <div className="grid gap-5 p-6 xl:grid-cols-2">
      {machines.map((machine) => (
        <section key={machine.node.id} className="flex flex-col border border-border bg-card">
          <header className="flex items-center gap-3 border-b border-border px-5 py-3.5">
            <MonitorSmartphone className="size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <h3 className="truncate font-display text-base font-semibold">
                {machine.node.label}
              </h3>
              {machine.node.sub !== undefined && machine.node.sub !== machine.node.label && (
                <p className="truncate text-xs text-muted-foreground">{machine.node.sub}</p>
              )}
            </div>
            {machine.node.retained === true && (
              <span className="text-xs text-warning">Not reporting</span>
            )}
          </header>
          <div className="flex flex-col divide-y divide-border">
            {machine.projects.map((project) => (
              <div key={project.node.id} className="px-5 py-3">
                <div className="flex items-center gap-2 pb-2">
                  <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-semibold">{project.node.label}</span>
                  {project.node.sub !== undefined && (
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {project.node.sub}
                    </span>
                  )}
                </div>
                <ul className="flex flex-col gap-1">
                  {project.terminals.map((terminal) => (
                    <li key={terminal.node.id}>
                      {row(
                        terminal.node,
                        <>
                          <Dot status={terminal.node.status} />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {terminal.node.label}
                          </span>
                          {terminal.node.serviceMode === 'mailbox-serve' && (
                            <span className="text-xs text-muted-foreground">mailbox serve</span>
                          )}
                          {terminal.node.version !== undefined && (
                            <span className="font-mono text-xs text-muted-foreground">
                              v{terminal.node.version.replace(/^v/, '')}
                            </span>
                          )}
                        </>,
                        'px-2 py-1.5',
                      )}
                      {terminal.agents.length > 0 && (
                        <ul className="ml-3 border-l border-border">
                          {terminal.agents.map((agent) => {
                            const tool = agent.agent?.currentTool;
                            const state = AGENT_STATUS[agent.status ?? 'idle'] ?? agent.status;
                            return (
                              <li key={agent.id}>
                                {row(
                                  agent,
                                  <>
                                    <Dot status={agent.status} />
                                    <span className="min-w-0 flex-1 truncate text-sm">
                                      <span className="font-medium">{agent.label}</span>
                                      <RuntimeBadge
                                        provider={agent.agent?.provider}
                                        model={agent.agent?.model}
                                      />
                                      <span className="text-muted-foreground">
                                        {' · '}
                                        {tool !== undefined && isLiveStatus(agent.status)
                                          ? tool
                                          : state}
                                      </span>
                                    </span>
                                  </>,
                                  'px-3 py-1.5',
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
