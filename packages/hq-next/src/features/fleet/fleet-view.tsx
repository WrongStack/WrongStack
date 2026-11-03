'use client';

/**
 * Fleet — every machine, project, terminal and agent reporting to HQ.
 *
 * One filtered topology feeds both presentations, so the list and the graph
 * can never disagree. Scope, "hide idle" and the chosen presentation are the
 * same local preferences the previous dashboard used, so switching surfaces
 * keeps the operator's setup. Selecting anything with a transcript opens a
 * peek panel; the Console is one click further.
 */
import { setHqFleetPrefs, useHqLocalPrefs } from '@hq/data/local-prefs';
import { useHqStore } from '@hq/data/store/index';
import {
  buildFleetTopology,
  filterFleetTopology,
  filterFleetTopologyByIdle,
  filterFleetTopologyByQuery,
  isIdleAgentStatus,
} from '@hq/domain/fleet-topology';
import type { FleetTopologyNode } from '@hq/domain/fleet-topology-types';
import { useRetainedFleetTopology } from '@hq/domain/use-fleet-retention';
import { EyeOff, ListTree, Network, Search, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo, useRef, useState } from 'react';
import { AddMachineButton, ConnectMachineSteps } from '@/components/connect-machine';
import { plural } from '@/features/overview/model';
import { cn } from '@/lib/cn';
import { machineIdsForScope, scopeLabel } from '@/lib/scope';
import { useFleetScope } from '@/lib/use-scope';
import { FleetGraph } from './fleet-graph';
import { FleetList } from './fleet-list';
import { fleetFigures } from './model';
import { PeekPanel } from './peek-panel';

function Toggle({
  pressed,
  onClick,
  children,
  title,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
}): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      title={title}
      className={cn(
        'inline-flex h-9 items-center gap-2 px-3 text-sm',
        pressed
          ? 'bg-foreground text-background'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

export function FleetView(): ReactNode {
  const snapshot = useHqStore((state) => state.snapshot);
  const live = useMemo(() => buildFleetTopology(snapshot), [snapshot]);
  const full = useRetainedFleetTopology(live);
  const prefs = useHqLocalPrefs().fleet;
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const lastSelected = useRef<FleetTopologyNode | null>(null);

  const scope = useFleetScope();
  const scoped = useMemo(
    () =>
      filterFleetTopology(
        full,
        scope.kind === 'label' ? 'machine' : scope.kind,
        scope.kind === 'all'
          ? undefined
          : scope.kind === 'project'
            ? scope.id
            : machineIdsForScope(scope, snapshot),
      ),
    [full, scope, snapshot],
  );
  const idleHidden = useMemo(
    () =>
      prefs.hideIdle
        ? scoped.nodes.filter((n) => n.kind === 'agent' && isIdleAgentStatus(n.status)).length
        : 0,
    [prefs.hideIdle, scoped],
  );
  const topology = useMemo(
    () => filterFleetTopologyByQuery(filterFleetTopologyByIdle(scoped, prefs.hideIdle), query),
    [scoped, prefs.hideIdle, query],
  );
  const figures = fleetFigures(topology);

  // The peek follows live data; if its node drops out it keeps the last copy.
  const selected =
    selectedId === null
      ? null
      : (full.nodes.find((node) => node.id === selectedId) ?? lastSelected.current);
  lastSelected.current = selected;

  if (snapshot === null) {
    return <p className="p-6 text-sm text-muted-foreground">Waiting for fleet data…</p>;
  }
  if (full.nodes.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h2 className="font-display text-2xl font-semibold">No machine is reporting yet</h2>
        <p className="mt-2 text-base text-muted-foreground">
          Start a WrongStack CLI, TUI or WebUI pointed at this HQ and it appears here within
          seconds.
        </p>
        <div className="mt-6">
          <ConnectMachineSteps />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <label className="flex h-9 w-72 items-center gap-2 border border-border bg-background px-2.5 text-sm focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search machines, projects, agents"
            aria-label="Search the fleet"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
          {query.length > 0 && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery('')}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
        </label>

        <div className="border border-border">
          <Toggle
            pressed={prefs.hideIdle}
            onClick={() => setHqFleetPrefs({ hideIdle: !prefs.hideIdle })}
            title="Hide idle agents; working, waiting and failed agents stay visible"
          >
            <EyeOff className="size-4" />
            Hide idle{idleHidden > 0 ? ` (${idleHidden})` : ''}
          </Toggle>
        </div>

        <p className="text-sm text-muted-foreground">
          {plural(figures.machines, 'machine')} · {plural(figures.terminals, 'terminal')} ·{' '}
          {figures.working}/{plural(figures.agents, 'agent')} working
          {figures.needsYou > 0 && (
            <span className="text-warning"> · {figures.needsYou} need you</span>
          )}
        </p>

        <div className="ml-auto">
          <AddMachineButton />
        </div>
        <fieldset className="inline-flex border border-border">
          <legend className="sr-only">Presentation</legend>
          <Toggle
            pressed={prefs.layout === 'compact'}
            onClick={() => setHqFleetPrefs({ layout: 'compact' })}
          >
            <ListTree className="size-4" />
            List
          </Toggle>
          <Toggle
            pressed={prefs.layout === 'map'}
            onClick={() => setHqFleetPrefs({ layout: 'map' })}
          >
            <Network className="size-4" />
            Graph
          </Toggle>
        </fieldset>
      </div>

      <div className="relative min-h-0 flex-1">
        {topology.nodes.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            {scoped.nodes.length === 0
              ? `Nothing in ${scopeLabel(scope, snapshot)} is connected right now.`
              : query.length > 0
                ? 'Nothing in the fleet matches this search.'
                : 'No agent is working right now. Turn off “Hide idle” to see the rest.'}
          </p>
        ) : prefs.layout === 'map' ? (
          <FleetGraph
            topology={topology}
            selectedId={selectedId}
            onSelect={(node) => setSelectedId(node.id)}
          />
        ) : (
          <div className="h-full overflow-y-auto">
            <FleetList
              topology={topology}
              selectedId={selectedId}
              onSelect={(node) => setSelectedId(node.id)}
            />
          </div>
        )}
        {selected !== null && <PeekPanel node={selected} onClose={() => setSelectedId(null)} />}
      </div>
    </div>
  );
}
