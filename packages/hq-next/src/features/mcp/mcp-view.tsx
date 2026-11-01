'use client';

import type { HqClientRecord, HqMcpServerHealth, HqProjectRecord } from '@wrongstack/hq';
import { Plug } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { relativeTime } from '@/features/attention/model';
import { plural } from '@/features/overview/model';
import { cn } from '@/lib/cn';
import { useScopedSnapshot } from '@/lib/use-scope';
import {
  checkLabel,
  checkValue,
  HEALTH,
  latencyLine,
  type McpRow,
  type McpTone,
  mcpFigures,
  mcpGroups,
  serverSentence,
} from './model';

const EMPTY_SERVERS: readonly HqMcpServerHealth[] = [];
const EMPTY_PROJECTS: readonly HqProjectRecord[] = [];
const EMPTY_CLIENTS: readonly HqClientRecord[] = [];

const TEXT: Record<McpTone, string> = {
  bad: 'text-destructive',
  warn: 'text-warning',
  ok: 'text-success',
  busy: 'text-info',
  quiet: 'text-muted-foreground',
};

const DOT: Record<McpTone, string> = {
  bad: 'bg-destructive',
  warn: 'bg-warning',
  ok: 'bg-success',
  busy: 'bg-info',
  quiet: 'bg-muted-foreground/50',
};

const CONNECTION: Record<HqMcpServerHealth['connectionState'], string> = {
  idle: 'Not started',
  dormant: 'Asleep',
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
  failed: 'Failed',
};

export function McpView(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const snapshot = useScopedSnapshot();
  const servers = snapshot?.mcpServers ?? EMPTY_SERVERS;
  const projects = snapshot?.projects ?? EMPTY_PROJECTS;
  const clients = snapshot?.clients ?? EMPTY_CLIENTS;
  const hasSnapshot = snapshot !== null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const groups = useMemo(() => mcpGroups(servers, projects, clients), [servers, projects, clients]);
  const figures = useMemo(() => mcpFigures(servers), [servers]);
  const rows = groups.flatMap((group) => group.rows);
  const open = rows.find((row) => row.key === params.get('server')) ?? rows[0];

  const select = (key: string): void => {
    const next = new URLSearchParams(params.toString());
    next.set('server', key);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  if (rows.length === 0) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-start gap-3 px-6 py-16">
        <Plug className="size-6 text-muted-foreground" />
        <h2 className="font-display text-2xl font-semibold">
          {hasSnapshot ? 'No MCP server reported' : 'Waiting for the fleet…'}
        </h2>
        {hasSnapshot && (
          <p className="text-base text-muted-foreground">
            A terminal reports its MCP servers here once it connects to HQ with at least one server
            configured.
          </p>
        )}
      </div>
    );
  }

  const trouble = figures.failed + figures.degraded;
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-display text-2xl font-semibold" data-testid="mcp-headline">
          {figures.failed > 0
            ? `${plural(figures.failed, 'MCP server')} failing`
            : figures.degraded > 0
              ? `${plural(figures.degraded, 'MCP server')} degraded`
              : 'All MCP servers answering'}
        </h2>
        <p className="text-base text-muted-foreground">
          {plural(figures.total, 'connection')} across {plural(groups.length, 'project')}
          {' · '}
          {figures.healthy} healthy
          {trouble > 0 && ` · ${trouble} need a look`}
          {figures.idle > 0 && ` · ${figures.idle} asleep or off`}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <section
              key={group.projectId}
              className="flex flex-col gap-2"
              aria-labelledby={`mcp-${group.projectId}`}
            >
              <h3 id={`mcp-${group.projectId}`} className="text-sm font-semibold">
                {group.projectName}
                {group.attention > 0 && (
                  <span className="ml-2 font-normal text-destructive">
                    {group.attention} need a look
                  </span>
                )}
              </h3>
              <ul className="flex flex-col border border-border">
                {group.rows.map((row) => (
                  <li key={row.key} className="border-b border-border last:border-b-0">
                    <ServerButton
                      row={row}
                      active={row.key === open?.key}
                      onSelect={() => select(row.key)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        {open !== undefined && <ServerDetail row={open} now={now} />}
      </div>
    </div>
  );
}

function ServerButton({
  row,
  active,
  onSelect,
}: {
  row: McpRow;
  active: boolean;
  onSelect: () => void;
}): ReactNode {
  const health = HEALTH[row.server.healthState];
  return (
    <button
      type="button"
      data-mcp-server={row.server.name}
      aria-current={active ? 'true' : undefined}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/50',
        active && 'bg-muted',
      )}
    >
      <span
        className={cn('mt-1.5 size-2.5 shrink-0 rounded-full', DOT[health.tone])}
        aria-hidden="true"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-3">
          <span className="font-mono text-sm font-medium">{row.server.name}</span>
          <span className={cn('text-sm', TEXT[health.tone])}>{health.label}</span>
        </span>
        <span className="truncate text-sm text-muted-foreground">{serverSentence(row.server)}</span>
        <span className="truncate text-xs text-muted-foreground">{row.where}</span>
      </span>
    </button>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function ServerDetail({ row, now }: { row: McpRow; now: number }): ReactNode {
  const { server } = row;
  const health = HEALTH[server.healthState];
  const latencies = [
    ['Connecting', server.connectionLatency],
    ['Listing tools', server.discoveryLatency],
    ['Tool calls', server.callLatency],
  ] as const;
  const failures = server.failures.transport + server.failures.protocol + server.failures.tool;
  return (
    <section
      aria-label={`${server.name} details`}
      data-testid="mcp-detail"
      className="flex h-fit flex-col gap-5 border border-border p-5 lg:sticky lg:top-4"
    >
      <header className="flex flex-col gap-1">
        <h3 className="flex flex-wrap items-baseline gap-x-3">
          <span className="font-mono text-lg font-semibold">{server.name}</span>
          <span className={cn('text-sm', TEXT[health.tone])}>{health.label}</span>
        </h3>
        <p className="text-sm">{serverSentence(server)}</p>
        <p className="text-xs text-muted-foreground">{row.where}</p>
      </header>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        <Fact label="Connection">{CONNECTION[server.connectionState]}</Fact>
        <Fact label="Last success">
          {server.lastSuccessAt ? relativeTime(server.lastSuccessAt, now) : 'Never'}
        </Fact>
        <Fact label="Last failure">
          {server.lastFailureAt ? relativeTime(server.lastFailureAt, now) : 'Never'}
        </Fact>
        <Fact label="Calls running">
          {server.inFlightCalls}
          <span className="text-muted-foreground"> · peak {server.peakInFlightCalls}</span>
        </Fact>
        <Fact label="Reconnects">{server.reconnectCount}</Fact>
        <Fact label="Restarts">{server.restartCount}</Fact>
      </dl>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">Latency</h4>
        <dl className="flex flex-col gap-1.5">
          {latencies.map(([label, summary]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 text-sm">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-mono tabular-nums">
                {latencyLine(summary) ?? 'Not measured yet'}
                {summary.count > 0 && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {plural(summary.count, 'sample')}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">Failures</h4>
        {failures === 0 ? (
          <p className="text-sm text-muted-foreground">None recorded.</p>
        ) : (
          <dl className="grid grid-cols-3 gap-4">
            <Fact label="Connection">{server.failures.transport}</Fact>
            <Fact label="Protocol">{server.failures.protocol}</Fact>
            <Fact label="Tool calls">{server.failures.tool}</Fact>
          </dl>
        )}
      </div>

      {server.healthChecks.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">Limits</h4>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 font-normal">Check</th>
                <th className="py-1 text-right font-normal">Measured</th>
                <th className="py-1 text-right font-normal">Limit</th>
              </tr>
            </thead>
            <tbody>
              {server.healthChecks.map((check) => (
                <tr key={check.name} className="border-t border-border">
                  <td className="py-1.5">
                    <span className={check.passed ? 'text-success' : 'text-destructive'}>
                      {check.passed ? 'Within' : 'Over'}
                    </span>{' '}
                    {checkLabel(check.name)}
                  </td>
                  <td className="py-1.5 text-right font-mono tabular-nums">
                    {checkValue(check, check.value)}
                  </td>
                  <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                    {checkValue(check, check.threshold)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {server.healthState !== 'healthy' && server.healthState !== 'dormant' && (
        <p className="border-t border-border pt-4 text-sm text-muted-foreground">
          HQ cannot restart MCP servers. Fix it in the terminal on{' '}
          <span className="text-foreground">{row.where}</span> with{' '}
          <code className="font-mono">/mcp</code>, or edit the project’s MCP config.
        </p>
      )}
    </section>
  );
}
