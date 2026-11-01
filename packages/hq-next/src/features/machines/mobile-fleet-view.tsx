'use client';

/**
 * Fleet on the phone: is every machine up, healthy and quiet? One row per
 * machine that opens in place (`?machine=`), with its health reading, what it
 * needs from you, its clients and projects. Read-only: forgetting machines
 * and minting tokens stay on the desktop dashboard.
 */
import { useHqStore } from '@hq/data/store/index';
import { ArrowRight, ChevronDown, Monitor } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { overviewTarget, relativeTime } from '@/features/attention/model';
import { useAttentionQueue } from '@/features/attention/use-attention-queue';
import { cn } from '@/lib/cn';
import { useSurfaceHref } from '@/lib/surface';
import { healthProblems } from './health';
import { HealthBlock } from './health-block';
import { type MachineSummary, machineSentence, machineSummaries } from './model';

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function MobileFleetView(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const snapshot = useHqStore((state) => state.snapshot);
  const { items, outside } = useAttentionQueue();
  const all = useMemo(() => [...items, ...outside], [items, outside]);
  const machines = useMemo(() => machineSummaries(snapshot, all), [snapshot, all]);
  const now = useNow();
  const openKey = params.get('machine');

  const toggle = (key: string): void => {
    const next = new URLSearchParams(params.toString());
    if (openKey === key) next.delete('machine');
    else next.set('machine', key);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  if (snapshot === null) {
    return <p className="p-4 text-sm text-muted-foreground">Waiting for fleet data…</p>;
  }
  if (machines.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2 p-4">
        <Monitor className="size-6 text-muted-foreground" />
        <h2 className="font-display text-xl font-semibold">No machine has reported yet</h2>
        <p className="text-sm text-muted-foreground">
          Connect one from the desktop dashboard: Fleet → Machines → Add a machine.
        </p>
      </div>
    );
  }

  const online = machines.filter((machine) => machine.online).length;
  const unhealthy = machines.filter(
    (machine) => healthProblems(machine.health, now).length > 0,
  ).length;
  return (
    <div className="flex flex-col gap-3 p-4">
      <header className="flex flex-col gap-0.5">
        <h2 className="font-display text-xl font-semibold" data-testid="mobile-fleet-headline">
          {online} of {machines.length} machine{machines.length === 1 ? '' : 's'} online
        </h2>
        <p className="text-sm text-muted-foreground">
          {unhealthy === 0
            ? 'No machine is low on disk or memory.'
            : `${unhealthy} low on disk or memory.`}
        </p>
      </header>
      <ul className="flex flex-col gap-2" aria-label="Machines">
        {machines.map((machine) => (
          <MachineRow
            key={machine.key}
            machine={machine}
            open={openKey === machine.key}
            onToggle={() => toggle(machine.key)}
            now={now}
          />
        ))}
      </ul>
    </div>
  );
}

function MachineRow({
  machine,
  open,
  onToggle,
  now,
}: {
  machine: MachineSummary;
  open: boolean;
  onToggle: () => void;
  now: number;
}): ReactNode {
  const href = useSurfaceHref();
  const problems = healthProblems(machine.health, now);
  const detailId = `machine-${machine.key.replace(/[^a-z0-9-]/gi, '-')}`;
  return (
    <li className={cn('border', open ? 'border-primary/60' : 'border-border')}>
      <button
        type="button"
        data-mobile-machine={machine.key}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-3 py-3 text-left"
      >
        <span
          aria-hidden
          className={cn(
            'mt-1.5 size-2 shrink-0',
            machine.online ? 'bg-success' : 'bg-muted-foreground/50',
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium">{machine.hostname}</span>
            {machine.attention.length > 0 && (
              <span className="shrink-0 bg-warning px-1.5 text-xs font-semibold text-background">
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
          {problems.map((problem) => (
            <span key={problem.kind} className="text-sm font-medium text-warning">
              {problem.kind === 'disk' ? 'Low on disk space' : 'Short of memory'}
            </span>
          ))}
        </span>
        <ChevronDown
          aria-hidden
          className={cn('mt-1 size-4 shrink-0 text-muted-foreground', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div
          id={detailId}
          data-testid="mobile-machine-detail"
          className="flex flex-col gap-4 border-t border-border px-3 py-3"
        >
          {machine.attention.length > 0 && (
            <ul className="flex flex-col border border-warning/50">
              {machine.attention.map((item) => (
                <li key={item.id} className="border-b border-border last:border-b-0">
                  <Link
                    href={href(overviewTarget(item))}
                    className="flex items-center gap-3 px-3 py-2.5 text-sm"
                  >
                    <span className="min-w-0 flex-1">{item.title}</span>
                    <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {!machine.remembered && <HealthBlock machine={machine} now={now} />}
          {machine.clients.length > 0 && (
            <div className="flex flex-col gap-1">
              <h4 className="text-sm font-semibold">WrongStack clients</h4>
              <ul className="flex flex-col gap-1 text-sm">
                {machine.clients.map((client) => (
                  <li key={client.clientId} className="flex flex-wrap gap-x-2">
                    <span>{client.kind.toUpperCase()}</span>
                    <span className="text-muted-foreground">{client.projectName}</span>
                    <span className="font-mono">{client.version ?? '—'}</span>
                    {client.drift === 'behind' && <span className="text-warning">behind HQ</span>}
                    {client.drift === 'ahead' && <span className="text-warning">ahead of HQ</span>}
                    {!client.connected && <span className="text-muted-foreground">gone</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {machine.remembered && machine.lastVersion !== undefined && (
            <p className="text-sm text-muted-foreground">
              Last release <span className="font-mono">{machine.lastVersion}</span>
            </p>
          )}
          {machine.projects.length > 0 && (
            <p className="text-sm">
              <span className="font-semibold">Projects </span>
              {machine.projects.map((project) => project.projectName).join(' · ')}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
