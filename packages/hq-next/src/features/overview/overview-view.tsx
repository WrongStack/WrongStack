'use client';

/**
 * Overview — the first screen. It leads with one sentence about the state of
 * the fleet, then lists what needs a human, then what is running. Every row is
 * a way into the surface that can act on it; nothing here is a dead end.
 */
import { useHqStore } from '@hq/data/store/index';
import { formatUsd } from '@hq/lib/format';
import { useCockpitHealth } from '@hq/views/use-cockpit-data';
import type { HqSessionAgentSummary, HqSessionSnapshotPayload, HqSnapshot } from '@wrongstack/hq';
import { ArrowRight, Check } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { ConnectMachineSteps } from '@/components/connect-machine';
import { OutsideScopeNote } from '@/components/scope-picker';
import { cn } from '@/lib/cn';
import { useScopedSnapshot } from '@/lib/use-scope';
import { type AttentionItem, overviewTarget, relativeTime } from '../attention/model';
import { useAttentionQueue } from '../attention/use-attention-queue';
import { driftLine, versionDrift } from '../attention/versions';
import {
  fleetPulse,
  type Headline,
  type HealthRow,
  mcpHealthRow,
  orderSessions,
  overviewHeadline,
  plural,
  type RunRow,
  serverHealthRows,
  subagentRuns,
  tokenHealth,
} from './model';

const MAX_ATTENTION_ROWS = 8;
const MAX_SESSIONS = 6;
const MAX_PROJECTS = 6;

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function OverviewView(): ReactNode {
  const connected = useHqStore((state) => state.connected);
  const snapshot = useScopedSnapshot();
  const { items: attention, outside } = useAttentionQueue();
  const now = useNow();

  const pulse = useMemo(() => fleetPulse(snapshot), [snapshot]);
  const everSawClient = (snapshot?.clients?.length ?? 0) > 0;
  const headline = overviewHeadline({
    connected,
    hasSnapshot: snapshot !== null,
    everSawClient,
    attention,
    pulse,
  });

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 py-8">
      <HeadlineBlock headline={headline} />

      {headline.tone === 'empty' ? (
        <ConnectFirstMachine />
      ) : (
        <>
          <PulseStrip pulse={pulse} />
          <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="flex min-w-0 flex-col gap-8">
              <OutsideScopeNote count={outside.length} />
              <NeedsYou items={attention} now={now} />
              <RunningNow sessions={snapshot?.liveSessions ?? []} now={now} />
              <SubagentRuns snapshot={snapshot} now={now} />
            </div>
            <aside className="flex flex-col gap-8">
              <Projects snapshot={snapshot} now={now} />
              <SystemPanel snapshot={snapshot} connected={connected} />
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

// ── Headline ──────────────────────────────────────────────────────────────

const HEADLINE_TONE: Record<Headline['tone'], string> = {
  offline: 'bg-warning',
  empty: 'bg-muted-foreground/60',
  attention: 'bg-primary',
  busy: 'bg-success',
  calm: 'bg-success',
};

function HeadlineBlock({ headline }: { headline: Headline }): ReactNode {
  return (
    <section aria-live="polite" className="flex items-start gap-4">
      <span
        aria-hidden
        className={cn(
          'mt-3 size-3 shrink-0',
          HEADLINE_TONE[headline.tone],
          (headline.tone === 'offline' || headline.tone === 'busy') && 'animate-pulse',
        )}
      />
      <div className="min-w-0">
        <h2 className="font-display text-3xl font-semibold tracking-tight md:text-4xl">
          {headline.title}
        </h2>
        <p className="mt-1.5 text-base text-muted-foreground">{headline.detail}</p>
      </div>
    </section>
  );
}

// ── Pulse ─────────────────────────────────────────────────────────────────

function PulseStrip({ pulse }: { pulse: ReturnType<typeof fleetPulse> }): ReactNode {
  const figures: { label: string; value: string; hint?: string }[] = [
    { label: 'Machines', value: String(pulse.machines) },
    { label: 'Sessions', value: String(pulse.sessions) },
    { label: 'Agents working', value: `${pulse.working}`, hint: `of ${pulse.agents}` },
    { label: 'Projects active', value: String(pulse.projects) },
    { label: 'Spend', value: formatUsd(pulse.costUsd) },
  ];
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden border border-border bg-border sm:grid-cols-3 lg:grid-cols-5">
      {figures.map((figure) => (
        <div key={figure.label} className="bg-card px-5 py-4">
          <dt className="text-sm text-muted-foreground">{figure.label}</dt>
          <dd className="mt-1 flex items-baseline gap-1.5">
            <span className="tabular font-display text-2xl font-semibold">{figure.value}</span>
            {figure.hint !== undefined && (
              <span className="text-sm text-muted-foreground">{figure.hint}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── Section chrome ────────────────────────────────────────────────────────

function Section({
  title,
  count,
  link,
  children,
}: {
  title: string;
  count?: number;
  link?: { href: string; label: string };
  children: ReactNode;
}): ReactNode {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-baseline gap-2">
        <h3 className="font-display text-lg font-semibold">{title}</h3>
        {count !== undefined && count > 0 && (
          <span className="tabular text-sm text-muted-foreground">{count}</span>
        )}
        {link !== undefined && (
          <Link
            href={link.href}
            className="ml-auto inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            {link.label}
            <ArrowRight className="size-3.5" />
          </Link>
        )}
      </header>
      {children}
    </section>
  );
}

// ── Needs you ─────────────────────────────────────────────────────────────

function NeedsYou({ items, now }: { items: readonly AttentionItem[]; now: number }): ReactNode {
  const router = useRouter();
  const open = (item: AttentionItem): void => {
    if (item.focus !== undefined) {
      useHqStore.getState().selectAgent(item.focus.sessionId, item.focus.agentId);
    }
    router.push(overviewTarget(item));
  };
  const visible = items.slice(0, MAX_ATTENTION_ROWS);

  return (
    <Section
      title="Needs you"
      count={items.length}
      link={
        items.length > MAX_ATTENTION_ROWS ? { href: '/inbox/', label: 'Open inbox' } : undefined
      }
    >
      {items.length === 0 ? (
        <p className="flex items-center gap-2 border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
          <Check className="size-4 text-success" />
          Nothing is waiting on you. Approvals, questions and failures show up here first.
        </p>
      ) : (
        <ul className="divide-y divide-border border border-border bg-card">
          {visible.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => open(item)}
                className="group flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/60"
              >
                <span
                  aria-hidden
                  className={cn(
                    'size-2 shrink-0',
                    item.tone === 'critical' ? 'bg-destructive' : 'bg-warning',
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{item.title}</span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {item.context}
                  </span>
                </span>
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                  {relativeTime(item.at, now)}
                </span>
                <span className="shrink-0 border border-border px-2.5 py-1 text-sm group-hover:border-foreground/40">
                  {item.action}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ── Running now ───────────────────────────────────────────────────────────

const AGENT_STATUS: Record<HqSessionAgentSummary['status'], { label: string; dot: string }> = {
  running: { label: 'Working', dot: 'bg-success animate-pulse' },
  streaming: { label: 'Writing', dot: 'bg-success animate-pulse' },
  waiting_user: { label: 'Waiting for you', dot: 'bg-warning' },
  error: { label: 'Error', dot: 'bg-destructive' },
  idle: { label: 'Idle', dot: 'bg-muted-foreground/50' },
};

function RunningNow({
  sessions,
  now,
}: {
  sessions: readonly HqSessionSnapshotPayload[];
  now: number;
}): ReactNode {
  const router = useRouter();
  const ordered = useMemo(() => orderSessions(sessions).slice(0, MAX_SESSIONS), [sessions]);
  const openAgent = (sessionId: string, agentId: string | null): void => {
    if (agentId === null) useHqStore.getState().selectSession(sessionId);
    else useHqStore.getState().selectAgent(sessionId, agentId);
    router.push('/fleet/console/');
  };

  return (
    <Section
      title="Running now"
      count={sessions.length}
      link={{ href: '/fleet/', label: 'Fleet map' }}
    >
      {ordered.length === 0 ? (
        <p className="border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
          No session is open on any connected machine.
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {ordered.map((session) => (
            <article key={session.sessionId} className="flex flex-col border border-border bg-card">
              <button
                type="button"
                onClick={() => openAgent(session.sessionId, null)}
                className="flex items-baseline gap-2 border-b border-border px-4 py-3 text-left hover:bg-muted/60"
              >
                <span className="truncate font-medium">{session.projectName}</span>
                {session.gitBranch !== undefined && (
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {session.gitBranch}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {session.clientKind.toUpperCase()} · {session.hostname ?? session.machineId}
                </span>
              </button>
              {(session.agents ?? []).length === 0 ? (
                <p className="px-4 py-3 text-sm text-muted-foreground">
                  No agent yet · active {relativeTime(session.lastActivityAt, now)}
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {(session.agents ?? []).slice(0, 5).map((agent) => {
                    const status = AGENT_STATUS[agent.status];
                    return (
                      <li key={agent.id}>
                        <button
                          type="button"
                          onClick={() => openAgent(session.sessionId, agent.id)}
                          className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-muted/60"
                        >
                          <span aria-hidden className={cn('size-2 shrink-0', status.dot)} />
                          <span className="min-w-0 flex-1 truncate">
                            <span className="font-medium">{agent.name}</span>
                            <span className="text-muted-foreground">
                              {' · '}
                              {agent.currentTool !== undefined &&
                              (agent.status === 'running' || agent.status === 'streaming')
                                ? agent.currentTool
                                : status.label}
                            </span>
                          </span>
                          {agent.costUsd !== undefined && (
                            <span className="tabular shrink-0 text-xs text-muted-foreground">
                              {formatUsd(agent.costUsd)}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </article>
          ))}
        </div>
      )}
    </Section>
  );
}

// ── Subagent runs ─────────────────────────────────────────────────────────

function BudgetBar({ budget }: { budget: NonNullable<RunRow['budget']> }): ReactNode {
  if (budget.max === undefined) {
    return (
      <p className="text-xs text-muted-foreground">
        {plural(budget.used, 'spawn')} used · no lifetime limit
      </p>
    );
  }
  const pct = budget.max === 0 ? 100 : Math.min(100, (budget.used / budget.max) * 100);
  const spent = budget.left === 0;
  return (
    <div className="flex flex-col gap-1">
      <div aria-hidden className="h-1.5 bg-muted">
        <div
          className={cn(
            'h-full',
            spent ? 'bg-destructive' : pct >= 80 ? 'bg-warning' : 'bg-primary',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="tabular text-xs text-muted-foreground">
        {budget.used} of {budget.max} spawns used
        {budget.left !== undefined && ` · ${budget.left} left`}
      </p>
    </div>
  );
}

function SubagentRuns({ snapshot, now }: { snapshot: HqSnapshot | null; now: number }): ReactNode {
  const router = useRouter();
  const runs = useMemo(() => subagentRuns(snapshot), [snapshot]);
  // A fleet that never spawned a subagent has nothing to say here.
  if (runs.length === 0) return null;
  const open = (sessionId: string): void => {
    useHqStore.getState().selectSession(sessionId);
    router.push('/fleet/console/');
  };
  return (
    <Section title="Subagent runs" count={runs.length}>
      <ul className="grid gap-3 lg:grid-cols-2">
        {runs.map((run) => {
          const body = (
            <>
              <span className="flex items-baseline gap-2">
                <span className="truncate font-medium">{run.projectName}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {run.where} · {relativeTime(run.lastActivityAt, now)}
                </span>
              </span>
              <span className="text-sm">{run.tasks}</span>
              {run.budget !== undefined && <BudgetBar budget={run.budget} />}
              {(run.concurrency !== undefined || run.costUsd !== undefined) && (
                <span className="text-xs text-muted-foreground">
                  {[run.concurrency, run.costUsd !== undefined ? formatUsd(run.costUsd) : undefined]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              )}
              {run.warnings.map((warning) => (
                <span key={warning} className="text-sm text-warning">
                  {warning}
                </span>
              ))}
            </>
          );
          const sessionId = run.sessionId;
          return (
            <li
              key={run.runId}
              data-run={run.runId}
              className={cn(
                'border bg-card',
                run.warnings.length > 0 ? 'border-warning/50' : 'border-border',
              )}
            >
              {sessionId === undefined ? (
                <div className="flex flex-col gap-2 px-4 py-3">{body}</div>
              ) : (
                <button
                  type="button"
                  onClick={() => open(sessionId)}
                  className="flex w-full flex-col gap-2 px-4 py-3 text-left hover:bg-muted/60"
                >
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// ── Side panels ───────────────────────────────────────────────────────────

const PROJECT_TONE: Record<string, string> = {
  active: 'bg-success',
  idle: 'bg-muted-foreground/50',
  stale: 'bg-warning',
  error: 'bg-destructive',
};

function Projects({ snapshot, now }: { snapshot: HqSnapshot | null; now: number }): ReactNode {
  const projects = useMemo(
    () =>
      [...(snapshot?.projects ?? [])]
        .sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt))
        .slice(0, MAX_PROJECTS),
    [snapshot],
  );
  return (
    <Section
      title="Projects"
      count={snapshot?.projects?.length ?? 0}
      link={{ href: '/fleet/projects/', label: 'All projects' }}
    >
      {projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">No project has reported yet.</p>
      ) : (
        <ul className="divide-y divide-border border border-border bg-card">
          {projects.map((project) => (
            <li key={project.projectId}>
              <Link
                href={`/fleet/projects/?project=${encodeURIComponent(project.projectId)}`}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/50"
              >
                <span
                  aria-hidden
                  className={cn('size-2 shrink-0', PROJECT_TONE[project.status] ?? 'bg-muted')}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{project.projectName}</span>
                  <span className="block text-xs text-muted-foreground">
                    {plural(project.activeSessions, 'session')} ·{' '}
                    {relativeTime(project.lastActivityAt, now)}
                  </span>
                </span>
                <span className="tabular shrink-0 text-sm">{formatUsd(project.totalCostUsd)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function SystemPanel({
  snapshot,
  connected,
}: {
  snapshot: HqSnapshot | null;
  connected: boolean;
}): ReactNode {
  const { health, healthError, gatewayHealth } = useCockpitHealth();
  const latency = snapshot?.commandLatency;
  const rows: HealthRow[] = [
    {
      label: 'Live link',
      value: connected ? 'Connected' : 'Reconnecting',
      tone: connected ? 'ok' : 'warn',
    },
    ...serverHealthRows(health, healthError, gatewayHealth),
    {
      label: 'Command round-trip',
      value:
        latency?.p50Ms !== undefined
          ? `${Math.round(latency.p50Ms)} ms · p95 ${Math.round(latency.p95Ms ?? latency.p50Ms)} ms`
          : 'No commands yet',
      tone: latency?.p50Ms !== undefined ? 'ok' : 'muted',
    },
    {
      label: 'Client versions',
      ...driftLine(versionDrift(snapshot?.clients ?? [], snapshot?.hqVersion)),
    },
    { label: 'MCP servers', ...mcpHealthRow(snapshot?.mcpServers) },
    { label: 'Access tokens', ...tokenHealth(snapshot?.totals?.tokenStats) },
  ];
  return (
    <Section title="System" link={{ href: '/system/security/', label: 'Security' }}>
      <dl className="divide-y divide-border border border-border bg-card">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
          >
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd
              className={cn(
                'tabular text-right',
                row.tone === 'ok' && 'text-foreground',
                row.tone === 'warn' && 'text-warning',
                row.tone === 'muted' && 'text-muted-foreground',
              )}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

// ── First run ─────────────────────────────────────────────────────────────

function ConnectFirstMachine(): ReactNode {
  return (
    <section className="grid gap-6 border border-border bg-card p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div>
        <h3 className="font-display text-xl font-semibold">Connect your first machine</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Each WrongStack CLI, TUI or WebUI publishes its sessions, agents and costs to HQ once it
          knows where HQ is and holds a client token. Tokens are minted on the HQ machine and never
          shown in this browser.
        </p>
      </div>
      <ConnectMachineSteps />
    </section>
  );
}
