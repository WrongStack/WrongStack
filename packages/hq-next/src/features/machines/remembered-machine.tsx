'use client';

/**
 * A machine HQ remembers but that has no connected client: when it was last
 * seen, the release it last ran, the projects it ran, and a way to forget it
 * once it has been retired. Forgetting is two-step and refused by the server
 * while any client on the machine is connected.
 */
import { forgetMachine } from '@hq/data/api';
import { ArrowRight, Trash2 } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { overviewTarget, relativeTime } from '@/features/attention/model';
import { errorText } from '@/lib/error-text';
import { setFleetScope } from '@/lib/use-scope';
import { MachineLabelsEditor } from './machine-labels';
import type { MachineSummary } from './model';

export function RememberedMachineDetail({
  machine,
  now,
}: {
  machine: MachineSummary;
  now: number;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forget = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await forgetMachine(machine.key);
      // The snapshot broadcast drops the card; nothing else to do here.
    } catch (cause) {
      setError(errorText(cause));
      setPending(false);
    }
  };

  return (
    <section
      aria-label={`${machine.hostname} details`}
      data-testid="machine-detail"
      data-remembered="true"
      className="flex h-fit flex-col gap-6 border border-border p-5"
    >
      <header className="flex flex-col gap-1">
        <h3 className="font-display text-xl font-semibold">{machine.hostname}</h3>
        <p className="text-sm text-muted-foreground">
          Offline
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
      </header>

      <p className="text-sm">
        No WrongStack client on this machine is connected. HQ keeps it listed for 30 days after it
        was last seen, so a machine that drops out of the fleet does not just disappear. It comes
        back online as soon as a client there reconnects.
      </p>

      <MachineLabelsEditor key={machine.key} machineKey={machine.key} labels={machine.labels} />

      <dl className="grid grid-cols-2 gap-4">
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">Last release</dt>
          <dd className="font-mono text-lg">{machine.lastVersion ?? '—'}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">Projects</dt>
          <dd className="tabular font-display text-lg font-semibold">{machine.projects.length}</dd>
        </div>
      </dl>

      {machine.attention.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">Still waiting on you</h4>
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

      {machine.projects.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">Projects that ran here</h4>
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
      )}

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        {confirming ? (
          <div className="flex flex-col gap-2" data-testid="forget-machine-confirm">
            <p className="text-sm">
              Forget <span className="font-semibold">{machine.hostname}</span>? HQ stops listing it
              until a client there connects again. Its events and spend history stay.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => void forget()}
                data-testid="forget-machine-confirm-button"
                className="inline-flex h-9 items-center gap-2 bg-destructive px-3 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-60"
              >
                <Trash2 className="size-4" />
                {pending ? 'Forgetting…' : 'Forget machine'}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setConfirming(false);
                  setError(null);
                }}
                className="inline-flex h-9 items-center border border-border px-3 text-sm hover:bg-muted disabled:opacity-60"
              >
                Keep it
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            data-testid="forget-machine"
            className="inline-flex h-9 w-fit items-center gap-2 border border-border px-3 text-sm hover:bg-muted"
          >
            <Trash2 className="size-4" />
            Forget this machine
          </button>
        )}
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
