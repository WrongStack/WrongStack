'use client';

/**
 * Event log — the archive of every envelope the clients sent.
 *
 * Filters are pickers over what HQ knows (event types, connected clients,
 * machines) rather than free-text ids, and they live in the URL. Rows are
 * grouped by day, read in words, and open to the full JSON. Rows of one
 * activity (a shared correlation id in a row) are drawn as one chain.
 */
import { CopyButton } from '@hq/components/hq/primitives';
import { type EventsResponse, fetchEvents } from '@hq/data/api';
import { useHqStore } from '@hq/data/store/index';
import type { HqClientRecord, HqMachineRecord, HqProjectRecord } from '@wrongstack/hq';
import { ChevronRight, RefreshCw, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { plural } from '@/features/overview/model';
import { cn } from '@/lib/cn';
import { inScope, machineKeyOf } from '@/lib/scope';
import { useFleetScope } from '@/lib/use-scope';
import {
  chainRows,
  EVENT_TYPE_LABEL,
  type EventRow,
  eventLabel,
  groupByDay,
  PAGE_SIZES,
  payloadFacts,
  prettyPayload,
  SINCE_PRESETS,
} from './model';

const EMPTY_CLIENTS: readonly HqClientRecord[] = [];
const EMPTY_MACHINES: readonly HqMachineRecord[] = [];
const EMPTY_PROJECTS: readonly HqProjectRecord[] = [];
const DEFAULT_SINCE = '24h';

function dayHeading(key: string): string {
  if (key === 'unknown') return 'Unknown date';
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

function clock(timestamp: string | undefined): string {
  if (timestamp === undefined) return '—';
  const at = new Date(timestamp);
  return Number.isNaN(at.getTime())
    ? timestamp
    : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function EventsView(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const clients = useHqStore((state) => state.snapshot?.clients ?? EMPTY_CLIENTS);
  const machines = useHqStore((state) => state.snapshot?.machines ?? EMPTY_MACHINES);
  const projects = useHqStore((state) => state.snapshot?.projects ?? EMPTY_PROJECTS);

  const type = params.get('type') ?? '';
  const clientId = params.get('client') ?? '';
  // An explicit machine in the URL wins; otherwise the operator's scope applies.
  const scope = useFleetScope();
  // `machine` is a machine key (hostname-first), the way the server groups machines.
  const machineKey = params.get('machine') ?? (scope.kind === 'machine' ? scope.id : '');
  const machineOptions = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const machine of machines) {
      const key = machineKeyOf(machine.hostname, machine.machineId);
      if (!byKey.has(key) || machine.hostname)
        byKey.set(key, machine.hostname || machine.machineId);
    }
    return [...byKey].sort((a, b) => a[1].localeCompare(b[1]));
  }, [machines]);
  const scopeProjectId = scope.kind === 'project' ? scope.id : undefined;
  const since =
    SINCE_PRESETS.find((preset) => preset.id === (params.get('since') ?? DEFAULT_SINCE)) ??
    SINCE_PRESETS[2];
  const limit = PAGE_SIZES.find((size) => String(size) === params.get('limit')) ?? PAGE_SIZES[0];

  const [data, setData] = useState<EventsResponse['events']>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const sequence = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const request = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchEvents({
        type: type || undefined,
        clientId: clientId || undefined,
        machineKey: machineKey || undefined,
        projectId: scopeProjectId,
        sinceMs: since?.ms != null ? Date.now() - since.ms : undefined,
        limit,
      });
      if (request !== sequence.current) return;
      setData(next.events);
      setOpen(new Set());
      setFetchedAt(Date.now());
    } catch (cause) {
      if (request !== sequence.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [type, clientId, machineKey, scopeProjectId, since, limit]);

  useEffect(() => {
    void load();
  }, [load]);

  const set = (patch: Record<string, string | null>): void => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false });
  };

  const projectName = useMemo(() => {
    const names = new Map(projects.map((project) => [project.projectId, project.projectName]));
    return (id: string) => names.get(id) ?? id;
  }, [projects]);
  const clientLabel = useMemo(() => {
    const byId = new Map(clients.map((client) => [client.clientId, client]));
    return (id: string | undefined): string | undefined => {
      if (id === undefined) return undefined;
      const client = byId.get(id);
      if (client === undefined) return id;
      return `${client.kind} on ${client.hostname ?? client.machineId} · ${projectName(client.projectId)}`;
    };
  }, [clients, projectName]);

  // A label scope covers several machines; the server filters by one, so the
  // page is narrowed here (records HQ cannot place stay visible).
  const snapshot = useHqStore((state) => state.snapshot);
  const visible = useMemo(
    () =>
      scope.kind !== 'label' || params.get('machine') !== null
        ? data
        : data.filter((event) =>
            inScope({ clientId: event.clientId, machineId: event.machineId }, scope, snapshot),
          ),
    [data, scope, snapshot, params],
  );
  const days = useMemo(() => groupByDay(chainRows(visible)), [visible]);
  const filtered = type !== '' || clientId !== '' || params.get('machine') !== null;
  const select = 'h-9 max-w-[16rem] border border-border bg-background px-2 text-sm';
  const nextSize = PAGE_SIZES.find((size) => size > limit);

  let rowIndex = 0;
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-6 py-6">
      <div className="flex flex-wrap items-center gap-3">
        <select
          aria-label="Event type"
          value={type}
          onChange={(event) => set({ type: event.target.value })}
          className={select}
        >
          <option value="">Every type</option>
          {Object.entries(EVENT_TYPE_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="Client"
          value={clientId}
          onChange={(event) => set({ client: event.target.value })}
          className={select}
        >
          <option value="">Every client</option>
          {clientId !== '' && !clients.some((client) => client.clientId === clientId) && (
            <option value={clientId}>{clientId}</option>
          )}
          {clients.map((client) => (
            <option key={client.clientId} value={client.clientId}>
              {clientLabel(client.clientId)}
              {client.connected ? '' : ' (gone)'}
            </option>
          ))}
        </select>
        <select
          aria-label="Machine"
          value={machineKey}
          onChange={(event) => set({ machine: event.target.value })}
          className={select}
        >
          <option value="">Every machine</option>
          {machineKey !== '' && !machineOptions.some(([key]) => key === machineKey) && (
            <option value={machineKey}>{machineKey.replace(/^(host|mid):/, '')}</option>
          )}
          {machineOptions.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="Time"
          value={since?.id}
          onChange={(event) =>
            set({ since: event.target.value === DEFAULT_SINCE ? null : event.target.value })
          }
          className={select}
        >
          {SINCE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
        {filtered && (
          <button
            type="button"
            onClick={() => set({ type: null, client: null, machine: null })}
            className="inline-flex h-9 items-center gap-1 px-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" /> Clear
          </button>
        )}
        <span className="ml-auto text-sm text-muted-foreground" aria-live="polite">
          {loading
            ? 'Loading…'
            : `${plural(visible.length, 'event')}${data.length >= limit ? ` — the newest ${limit}` : ''}`}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Refresh events"
          title={
            fetchedAt !== null ? `Fetched ${new Date(fetchedAt).toLocaleTimeString()}` : undefined
          }
          className="grid size-9 place-items-center border border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
        </button>
      </div>

      {error !== null && (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          The event log could not be read: {error}
        </p>
      )}

      {!loading && error === null && visible.length === 0 && (
        <p className="py-10 text-base text-muted-foreground">
          {filtered || since?.ms !== null
            ? `No event matches in ${since?.label.toLowerCase() ?? 'this window'}. Widen the time or clear the filters.`
            : 'HQ has not stored any event yet.'}
        </p>
      )}

      {days.map((day) => (
        <section key={day.key} className="flex flex-col">
          <h2 className="sticky top-0 z-10 border-b border-border bg-background py-2 text-sm font-semibold">
            {dayHeading(day.key)}
          </h2>
          <ol className="flex flex-col">
            {day.rows.map((row) => {
              const index = rowIndex++;
              return (
                <EventLine
                  key={`${row.event.timestamp ?? ''}-${index}`}
                  row={row}
                  source={clientLabel(row.event.clientId)}
                  open={open.has(index)}
                  onToggle={() =>
                    setOpen((current) => {
                      const next = new Set(current);
                      if (next.has(index)) next.delete(index);
                      else next.add(index);
                      return next;
                    })
                  }
                />
              );
            })}
          </ol>
        </section>
      ))}

      {!loading && data.length >= limit && nextSize !== undefined && (
        <button
          type="button"
          onClick={() => set({ limit: String(nextSize) })}
          className="h-10 self-start border border-border px-4 text-sm hover:bg-muted"
        >
          Show older — up to {nextSize}
        </button>
      )}
    </div>
  );
}

function EventLine({
  row,
  source,
  open,
  onToggle,
}: {
  row: EventRow;
  source: string | undefined;
  open: boolean;
  onToggle: () => void;
}): ReactNode {
  const event = row.event;
  const facts = payloadFacts(event.payload);
  const json = prettyPayload(event.payload);
  const continuation = row.chainId !== undefined && !row.chainHead;
  return (
    <li
      className={cn(
        'border-b border-border',
        continuation && 'ml-4 border-l-2 border-l-primary/40 pl-3',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        disabled={json === ''}
        className="grid w-full grid-cols-[5.5rem_minmax(0,1fr)_auto] items-start gap-x-3 py-2.5 text-left hover:bg-muted/40 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span className="tabular pt-px text-sm text-muted-foreground">
          {clock(event.timestamp)}
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium">{eventLabel(event.type)}</span>
            <span className="font-mono text-xs text-muted-foreground">{event.type}</span>
            {row.chainHead && (
              <span className="text-xs text-primary">{row.chainSize} events of one activity</span>
            )}
          </span>
          {facts.length > 0 && (
            <span className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-muted-foreground">
              {facts.map((fact) => (
                <span key={fact.key} className="min-w-0 break-words">
                  {fact.label} <span className="text-foreground/90">{fact.value}</span>
                </span>
              ))}
            </span>
          )}
          {source !== undefined && (
            <span className="truncate text-xs text-muted-foreground">{source}</span>
          )}
        </span>
        {json !== '' && (
          <ChevronRight
            className={cn(
              'mt-0.5 size-4 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
          />
        )}
      </button>
      {open && json !== '' && (
        <div className="relative mb-3 sm:ml-[6.25rem]">
          <CopyButton value={json} label="Copy JSON" className="absolute right-2 top-2" />
          <pre className="max-h-96 overflow-auto border border-border bg-muted/30 p-3 pr-24 font-mono text-[0.8125rem] leading-relaxed">
            {json}
          </pre>
        </div>
      )}
    </li>
  );
}
