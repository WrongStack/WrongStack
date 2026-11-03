'use client';

/**
 * The header's scope picker: whole fleet, one machine, the machines carrying
 * a label, or one project. Every
 * screen of a surface reads the same choice; the phone keeps its own. When the scope hides something that
 * needs a person, the trigger says how many, so narrowing never means missing
 * an approval on another machine.
 */
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@hq/components/ui/dropdown-menu';
import { useHqStore } from '@hq/data/store/index';
import { Check, ChevronDown, Crosshair } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import { type FleetScope, machineKeyOf, scopeLabel } from '@/lib/scope';
import { useFleetScope, useSetFleetScope } from '@/lib/use-scope';

const same = (a: FleetScope, b: FleetScope): boolean => a.kind === b.kind && a.id === b.id;

export function ScopePicker({
  outside,
  compact = false,
}: {
  outside: number;
  /** The phone header: a narrower trigger. */
  compact?: boolean;
}): ReactNode {
  const scope = useFleetScope();
  const setFleetScope = useSetFleetScope();
  const snapshot = useHqStore((state) => state.snapshot);

  const machines = useMemo(() => {
    // Grouped by machine key, the way the server groups machines.
    const byKey = new Map<string, { id: string; label: string; online: boolean }>();
    for (const client of snapshot?.clients ?? []) {
      const key = machineKeyOf(client.hostname, client.machineId);
      const entry = byKey.get(key);
      byKey.set(key, {
        id: key,
        label: client.hostname || entry?.label || client.machineId,
        online: (entry?.online ?? false) || client.connected,
      });
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [snapshot?.clients]);
  const labels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const keys of Object.values(snapshot?.machineLabels ?? {})) {
      for (const label of keys) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
  }, [snapshot?.machineLabels]);
  const projects = useMemo(
    () =>
      [...(snapshot?.projects ?? [])]
        .map((project) => ({ id: project.projectId, label: project.projectName }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [snapshot?.projects],
  );

  const option = (target: FleetScope, label: string, hint?: string): ReactNode => (
    <DropdownMenuItem
      key={`${target.kind}:${target.id}`}
      onSelect={() => setFleetScope(target)}
      className="gap-2"
    >
      <Check className={cn('size-4', !same(scope, target) && 'invisible')} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint !== undefined && <span className="text-xs text-muted-foreground">{hint}</span>}
    </DropdownMenuItem>
  );

  const narrowed = scope.kind !== 'all';
  return (
    // Not modal: a menu button does not trap focus, and a modal menu hides the
    // page (aria-hidden) while its skip link stays focusable.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        data-testid="scope-picker"
        aria-label={`Scope: ${scopeLabel(scope, snapshot)}${
          outside > 0 ? `, ${outside} need you outside it` : ''
        }`}
        className={cn(
          'inline-flex h-9 items-center gap-2 border px-2.5 text-sm hover:bg-muted',
          compact ? 'max-w-40' : 'max-w-56',
          narrowed ? 'border-primary/60 text-foreground' : 'border-border text-muted-foreground',
        )}
      >
        <Crosshair className="size-4 shrink-0" />
        <span className="truncate">{scopeLabel(scope, snapshot)}</span>
        {outside > 0 && (
          <span className="shrink-0 bg-warning px-1.5 text-xs font-semibold text-background">
            +{outside}
          </span>
        )}
        <ChevronDown className="size-3.5 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[70vh] w-64 overflow-y-auto">
        {option({ kind: 'all', id: '' }, 'Whole fleet')}
        {machines.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Machines
            </DropdownMenuLabel>
            {machines.map((machine) =>
              option(
                { kind: 'machine', id: machine.id },
                machine.label,
                machine.online ? undefined : 'offline',
              ),
            )}
          </>
        )}
        {labels.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">Labels</DropdownMenuLabel>
            {labels.map(([label, machinesWith]) =>
              option({ kind: 'label', id: label }, `${label} machines`, `${machinesWith}`),
            )}
          </>
        )}
        {projects.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Projects
            </DropdownMenuLabel>
            {projects.map((project) => option({ kind: 'project', id: project.id }, project.label))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "3 more need you outside alpha · Show the whole fleet". Nothing when 0. */
export function OutsideScopeNote({ count }: { count: number }): ReactNode {
  const scope = useFleetScope();
  const setFleetScope = useSetFleetScope();
  const snapshot = useHqStore((state) => state.snapshot);
  if (count === 0 || scope.kind === 'all') return null;
  return (
    <p
      data-testid="outside-scope"
      className="flex flex-wrap items-center gap-x-2 border border-warning/50 bg-warning/5 px-3 py-2 text-sm text-warning"
    >
      {count} more {count === 1 ? 'needs' : 'need'} you outside {scopeLabel(scope, snapshot)}.
      <button
        type="button"
        onClick={() => setFleetScope({ kind: 'all', id: '' })}
        className="underline underline-offset-2 hover:no-underline"
      >
        Show the whole fleet
      </button>
    </p>
  );
}
