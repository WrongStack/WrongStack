'use client';

/**
 * Projects — every project that reports to HQ, across every machine it runs
 * on, one card each, with the open one in detail: where it runs, the live
 * sessions and what they are doing, its spend, mail, the sessions that
 * recently ended and what it needs from a person. The open project lives in
 * `?project=`.
 */
import { fetchSessionHistory } from '@hq/data/api';
import { useHqStore } from '@hq/data/store/index';
import { formatUsd } from '@hq/lib/format';
import type { HqSessionHistoryEntry } from '@wrongstack/hq';
import { ArrowRight, Crosshair, FolderGit2, MessageSquareText } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { AddMachineButton } from '@/components/connect-machine';
import { overviewTarget, relativeTime } from '@/features/attention/model';
import { useAttentionQueue } from '@/features/attention/use-attention-queue';
import { sessionDuration } from '@/features/telemetry/session-history-model';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/error-text';
import { useFleetScope, useSetFleetScope } from '@/lib/use-scope';
import { type ProjectSummary, projectSentence, projectSummaries, projectWhere } from './model';

const RECENT_LIMIT = 8;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function ProjectsView(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const snapshot = useHqStore((state) => state.snapshot);
  // Every item, not the scoped ones: a project card shows its own needs even
  // while HQ is scoped elsewhere.
  const { items, outside } = useAttentionQueue();
  const all = useMemo(() => [...items, ...outside], [items, outside]);
  const projects = useMemo(() => projectSummaries(snapshot, all), [snapshot, all]);
  const now = useNow();

  const open =
    projects.find((project) => project.projectId === params.get('project')) ?? projects[0];

  if (snapshot === null) {
    return <p className="p-6 text-sm text-muted-foreground">Waiting for fleet data…</p>;
  }
  if (projects.length === 0) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-start gap-3 px-6 py-16">
        <FolderGit2 className="size-6 text-muted-foreground" />
        <h2 className="font-display text-2xl font-semibold">No project has reported yet</h2>
        <p className="text-base text-muted-foreground">
          A project shows up here as soon as a WrongStack client opened in it connects to HQ.
        </p>
        <AddMachineButton />
      </div>
    );
  }

  const running = projects.filter((project) => project.sessions.length > 0).length;
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-display text-2xl font-semibold" data-testid="projects-headline">
          {running} of {projects.length} project{projects.length === 1 ? '' : 's'} with a session
          open
        </h2>
        <p className="text-base text-muted-foreground">
          {projects.reduce((sum, project) => sum + project.working, 0)} agents working ·{' '}
          {formatUsd(projects.reduce((sum, project) => sum + project.costUsd, 0))} spent ·{' '}
          {projects.reduce((sum, project) => sum + project.attention.length, 0)} waiting on you
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <ul className="flex flex-col gap-2" aria-label="Projects">
          {projects.map((project) => (
            <li key={project.projectId}>
              <button
                type="button"
                data-project={project.projectId}
                aria-current={project.projectId === open?.projectId ? 'true' : undefined}
                onClick={() => {
                  const next = new URLSearchParams(params.toString());
                  next.set('project', project.projectId);
                  router.replace(`${pathname}?${next.toString()}`, { scroll: false });
                }}
                className={cn(
                  'flex w-full flex-col gap-1 border px-4 py-3 text-left hover:bg-muted/50',
                  project.projectId === open?.projectId
                    ? 'border-primary/60 bg-muted'
                    : 'border-border',
                )}
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      'size-2 shrink-0',
                      project.working > 0
                        ? 'bg-success'
                        : project.sessions.length > 0
                          ? 'bg-info'
                          : 'bg-muted-foreground/50',
                    )}
                  />
                  <span className="truncate font-medium">{project.projectName}</span>
                  {project.attention.length > 0 && (
                    <span className="ml-auto shrink-0 bg-warning px-1.5 text-xs font-semibold text-background">
                      {project.attention.length}
                    </span>
                  )}
                </span>
                <span className="text-sm text-muted-foreground">{projectSentence(project)}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {projectWhere(project)}
                  {project.lastActivityAt !== '' &&
                    ` · active ${relativeTime(project.lastActivityAt, now)}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {open !== undefined && <ProjectDetail key={open.projectId} project={open} now={now} />}
      </div>
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

const STATUS_WORDS: Record<ProjectSummary['status'], string> = {
  active: 'Active',
  idle: 'Idle',
  stale: 'Quiet for a while',
  error: 'Reporting an error',
  remembered: 'Not running anywhere now',
};

function ProjectDetail({ project, now }: { project: ProjectSummary; now: number }): ReactNode {
  const scope = useFleetScope();
  const setScope = useSetFleetScope();
  const scoped = scope.kind === 'project' && scope.id === project.projectId;
  const remembered = project.status === 'remembered';
  const encoded = encodeURIComponent(project.projectId);

  return (
    <section
      aria-label={`${project.projectName} details`}
      data-testid="project-detail"
      data-remembered={remembered ? 'true' : undefined}
      className="flex h-fit flex-col gap-6 border border-border p-5"
    >
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-xl font-semibold">{project.projectName}</h3>
          <p className="text-sm text-muted-foreground">
            <span className={cn(project.status === 'error' && 'text-destructive')}>
              {STATUS_WORDS[project.status]}
            </span>
            {project.gitBranch && <span className="font-mono"> · {project.gitBranch}</span>}
            {project.root !== '' && <span className="break-all font-mono"> · {project.root}</span>}
          </p>
        </div>
        {!remembered && (
          <button
            type="button"
            disabled={scoped}
            onClick={() => setScope({ kind: 'project', id: project.projectId })}
            className="inline-flex h-9 items-center gap-2 border border-border px-3 text-sm hover:bg-muted disabled:opacity-60"
          >
            <Crosshair className="size-4" />
            {scoped ? 'HQ is scoped here' : 'Scope HQ to this project'}
          </button>
        )}
      </header>

      {remembered ? (
        <p className="text-sm">
          No client of this project is connected. HQ knows it from the machines it last ran on and
          lists it for as long as it remembers them (30 days after they were last seen).
        </p>
      ) : (
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Figure label="Sessions open" value={String(project.sessions.length)} />
          <Figure label="Agents working" value={`${project.working} / ${project.agents}`} />
          <Figure label="Spend" value={formatUsd(project.costUsd)} />
          <Figure
            label="Mail"
            value={
              project.unreadMail + project.openMail === 0
                ? '—'
                : `${project.unreadMail} unread · ${project.openMail} open`
            }
            warn={project.unreadMail > 0}
          />
        </dl>
      )}

      {project.attention.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">Needs you</h4>
          <ul className="flex flex-col border border-warning/50">
            {project.attention.map((item) => (
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
        <h4 className="text-sm font-semibold">Machines</h4>
        <ul className="flex flex-wrap gap-2">
          {project.machines.map((machine) => (
            <li key={machine.key}>
              <Link
                href={`/fleet/machines/?machine=${encodeURIComponent(machine.key)}`}
                className="inline-flex items-center gap-2 border border-border px-2.5 py-1 text-sm hover:bg-muted"
              >
                <span
                  aria-hidden
                  className={cn(
                    'size-2 shrink-0',
                    machine.online ? 'bg-success' : 'bg-muted-foreground/50',
                  )}
                />
                {machine.hostname}
                <span className="sr-only">{machine.online ? ', online' : ', offline'}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>

      {project.sessions.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">Open sessions</h4>
          <ul className="flex flex-col border border-border">
            {project.sessions.map((session) => (
              <li
                key={session.sessionId}
                data-project-session={session.sessionId}
                className="border-b border-border last:border-b-0"
              >
                <Link
                  href={`/fleet/console/?session=${encodeURIComponent(session.sessionId)}`}
                  className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50"
                >
                  <MessageSquareText className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">
                    {session.hostname}
                    <span className="text-muted-foreground">
                      {' '}
                      · {session.clientKind.toUpperCase()}
                      {session.gitBranch && ` · ${session.gitBranch}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {session.working > 0
                      ? `${session.working} of ${session.agents} working`
                      : `idle ${relativeTime(session.lastActivityAt, now)}`}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <RecentSessions projectId={project.projectId} />

      {/* A board and worktrees come from a connected client of the project. */}
      {!remembered && (
        <nav aria-label={`${project.projectName} elsewhere in HQ`} className="flex flex-wrap gap-2">
          <Link
            href={`/work/?project=${encoded}`}
            className="inline-flex h-9 items-center border border-border px-3 text-sm hover:bg-muted"
          >
            Kanban board
          </Link>
          <Link
            href={`/system/worktrees/?project=${encoded}`}
            className="inline-flex h-9 items-center border border-border px-3 text-sm hover:bg-muted"
          >
            Worktrees
          </Link>
        </nav>
      )}
    </section>
  );
}

/** The last sessions of this project that ended, from the server's history. */
function RecentSessions({ projectId }: { projectId: string }): ReactNode {
  const [entries, setEntries] = useState<HqSessionHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSessionHistory({ projectId, limit: RECENT_LIMIT }).then(
      (result) => {
        if (!cancelled) setEntries(result.sessions);
      },
      (cause: unknown) => {
        if (!cancelled) setError(errorText(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold">Recently ended</h4>
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          The session history could not be read: {error}
        </p>
      ) : entries === null ? (
        <p className="text-sm text-muted-foreground">Reading the session history…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No session of this project has ended yet.</p>
      ) : (
        <ul className="flex flex-col border border-border" data-testid="project-recent-sessions">
          {entries.map((entry) => (
            <li
              key={`${entry.sessionId}:${entry.endedAt}`}
              className="flex flex-wrap items-center gap-x-3 border-b border-border px-3 py-2 text-sm last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate">
                {entry.hostname ?? entry.machineKey.replace(/^(host|mid):/, '')}
                {entry.outcome === 'lost' && (
                  <span
                    className="ml-2 text-xs text-warning"
                    title="The client stopped reporting without ending the session"
                  >
                    lost
                  </span>
                )}
              </span>
              <span className="tabular text-muted-foreground">
                {new Date(entry.endedAt).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              <span className="tabular w-16 text-right">{sessionDuration(entry)}</span>
              <span className="tabular w-20 text-right">{formatUsd(entry.costUsd)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
