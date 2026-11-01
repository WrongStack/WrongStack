'use client';

/**
 * Machines — every box that reports to HQ, one card each, with the open one
 * in detail: its clients and their releases against the hub, the projects it
 * runs, its sessions, spend, MCP health and what it needs from a person. The
 * open machine lives in `?machine=`.
 */
import { useHqStore } from '@hq/data/store/index';
import { formatUsd } from '@hq/lib/format';
import { ArrowRight, Crosshair, Monitor } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { AddMachineButton } from '@/components/connect-machine';
import { overviewTarget, relativeTime } from '@/features/attention/model';
import { useAttentionQueue } from '@/features/attention/use-attention-queue';
import { cn } from '@/lib/cn';
import { setFleetScope, useFleetScope } from '@/lib/use-scope';
import { HealthBlock } from './health-block';
import { MachineTokensPanel } from './machine-tokens-panel';
import {
  type MachineClient,
  type MachineSummary,
  machineSentence,
  machineSummaries,
} from './model';
import { RememberedMachineDetail } from './remembered-machine';

const DRIFT: Record<MachineClient['drift'], { label: string; className: string } | null> = {
  behind: { label: 'behind HQ', className: 'text-warning' },
  ahead: { label: 'ahead of HQ', className: 'text-warning' },
  same: null,
  unknown: null,
};

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function MachinesView(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const snapshot = useHqStore((state) => state.snapshot);
  // Every item, not the scoped ones: a machine card must show its own needs
  // even while HQ is scoped to another machine.
  const { items, outside } = useAttentionQueue();
  const all = useMemo(() => [...items, ...outside], [items, outside]);
  const machines = useMemo(() => machineSummaries(snapshot, all), [snapshot, all]);
  const now = useNow();

  const open = machines.find((machine) => machine.key === params.get('machine')) ?? machines[0];

  if (snapshot === null) {
    return <p className="p-6 text-sm text-muted-foreground">Waiting for fleet data…</p>;
  }
  if (machines.length === 0) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-start gap-3 px-6 py-16">
        <Monitor className="size-6 text-muted-foreground" />
        <h2 className="font-display text-2xl font-semibold">No machine has reported yet</h2>
        <AddMachineButton />
      </div>
    );
  }

  const online = machines.filter((machine) => machine.online).length;
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-6">
      <header className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-2xl font-semibold" data-testid="machines-headline">
            {online} of {machines.length} machine{machines.length === 1 ? '' : 's'} online
          </h2>
          <p className="text-base text-muted-foreground">
            {machines.reduce((sum, machine) => sum + machine.sessions, 0)} sessions ·{' '}
            {machines.reduce((sum, machine) => sum + machine.working, 0)} agents working ·{' '}
            {formatUsd(machines.reduce((sum, machine) => sum + machine.costUsd, 0))} spent
          </p>
        </div>
        <div className="ml-auto">
          <AddMachineButton />
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <ul className="flex flex-col gap-2" aria-label="Machines">
          {machines.map((machine) => (
            <li key={machine.key}>
              <button
                type="button"
                data-machine={machine.key}
                aria-current={machine.key === open?.key ? 'true' : undefined}
                onClick={() => {
                  const next = new URLSearchParams(params.toString());
                  next.set('machine', machine.key);
                  router.replace(`${pathname}?${next.toString()}`, { scroll: false });
                }}
                className={cn(
                  'flex w-full flex-col gap-1 border px-4 py-3 text-left hover:bg-muted/50',
                  machine.key === open?.key ? 'border-primary/60 bg-muted' : 'border-border',
                )}
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      'size-2 shrink-0',
                      machine.online ? 'bg-success' : 'bg-muted-foreground/50',
                    )}
                  />
                  <span className="truncate font-medium">{machine.hostname}</span>
                  {machine.attention.length > 0 && (
                    <span className="ml-auto shrink-0 bg-warning px-1.5 text-xs font-semibold text-background">
                      {machine.attention.length}
                    </span>
                  )}
                </span>
                <span className="text-sm text-muted-foreground">
                  {machineSentence(machine)}
                  {!machine.online &&
                    machine.lastSeenAt !== '' &&
                    ` · seen ${relativeTime(machine.lastSeenAt, now)}`}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {machine.projects.map((project) => project.projectName).join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {open !== undefined &&
          (open.remembered ? (
            <RememberedMachineDetail key={open.key} machine={open} now={now} />
          ) : (
            <MachineDetail machine={open} now={now} />
          ))}
      </div>
      <MachineTokensPanel now={now} />
    </div>
  );
}

function Figure({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}): ReactNode {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('tabular font-display text-lg font-semibold', warn && 'text-warning')}>
        {value}
      </dd>
    </div>
  );
}

function MachineDetail({ machine, now }: { machine: MachineSummary; now: number }): ReactNode {
  const scope = useFleetScope();
  const scoped = scope.kind === 'machine' && scope.id === machine.key;
  return (
    <section
      aria-label={`${machine.hostname} details`}
      data-testid="machine-detail"
      className="flex h-fit flex-col gap-6 border border-border p-5"
    >
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-xl font-semibold">{machine.hostname}</h3>
          <p className="text-sm text-muted-foreground">
            {machine.online ? 'Online' : 'Offline'}
            {machine.lastSeenAt !== '' && ` · last seen ${relativeTime(machine.lastSeenAt, now)}`}
            {machine.machineIds
              .filter((id) => id !== machine.hostname)
              .map((id) => (
                <span key={id} className="font-mono">
                  {' '}
                  · {id}
                </span>
              ))}
          </p>
        </div>
        <button
          type="button"
          disabled={scoped}
          onClick={() => setFleetScope({ kind: 'machine', id: machine.key })}
          className="inline-flex h-9 items-center gap-2 border border-border px-3 text-sm hover:bg-muted disabled:opacity-60"
        >
          <Crosshair className="size-4" />
          {scoped ? 'HQ is scoped here' : 'Scope HQ to this machine'}
        </button>
      </header>

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Figure label="Sessions" value={String(machine.sessions)} />
        <Figure label="Agents working" value={`${machine.working} / ${machine.agents}`} />
        <Figure label="Spend" value={formatUsd(machine.costUsd)} />
        <Figure
          label="MCP servers"
          value={
            machine.mcpTotal === 0 ? '—' : `${machine.mcpFailing} failing of ${machine.mcpTotal}`
          }
          warn={machine.mcpFailing > 0}
        />
      </dl>

      <HealthBlock machine={machine} now={now} />

      {machine.attention.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">Needs you</h4>
          <ul className="flex flex-col border border-warning/50">
            {machine.attention.map((item) => (
              <li key={item.id} className="border-b border-border last:border-b-0">
                <Link
                  href={overviewTarget(item)}
                  className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50"
                >
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">WrongStack clients</h4>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 font-normal">Client</th>
                <th className="py-1 font-normal">Project</th>
                <th className="py-1 font-normal">Release</th>
                <th className="py-1 text-right font-normal">State</th>
              </tr>
            </thead>
            <tbody>
              {machine.clients.map((client) => {
                const drift = DRIFT[client.drift];
                return (
                  <tr
                    key={client.clientId}
                    className="border-t border-border"
                    data-client={client.clientId}
                  >
                    <td className="py-1.5">
                      {client.kind.toUpperCase()}
                      {client.pid !== undefined && (
                        <span className="text-muted-foreground"> · pid {client.pid}</span>
                      )}
                    </td>
                    <td className="py-1.5">{client.projectName}</td>
                    <td className="py-1.5 font-mono">
                      {client.version ?? '—'}
                      {drift !== null && (
                        <span className={cn('ml-2 font-sans text-xs', drift.className)}>
                          {drift.label}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-right">
                      {client.connected ? (
                        <span className="text-success">Connected</span>
                      ) : (
                        <span className="text-muted-foreground">
                          Gone {relativeTime(client.lastSeenAt, now)}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">Projects here</h4>
        <ul className="flex flex-wrap gap-2">
          {machine.projects.map((project) => (
            <li key={project.projectId}>
              <button
                type="button"
                onClick={() => setFleetScope({ kind: 'project', id: project.projectId })}
                title="Scope HQ to this project"
                className="border border-border px-2.5 py-1 text-sm hover:bg-muted"
              >
                {project.projectName}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
