'use client';

/**
 * Projects on the phone: is anything working on each project, where does it
 * run and does it need me? One row per project that opens in place
 * (`?project=`), with its figures, what it needs, its machines and its open
 * sessions, each leading to the phone screen that handles it. Read-only:
 * starting a session launches a process and stays on the desktop dashboard.
 */
import { useHqStore } from '@hq/data/store/index';
import { formatUsd } from '@hq/lib/format';
import { ArrowRight, ChevronDown, FolderGit2, MessageSquareText } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { MobileFleetSwitch } from '@/components/mobile-fleet-switch';
import { overviewTarget, relativeTime } from '@/features/attention/model';
import { useAttentionQueue } from '@/features/attention/use-attention-queue';
import { cn } from '@/lib/cn';
import { useSurfaceHref } from '@/lib/surface';
import { type ProjectSummary, projectSentence, projectSummaries, projectWhere } from './model';

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function MobileProjectsView(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const snapshot = useHqStore((state) => state.snapshot);
  // Every item, not the scoped ones: a project shows its own needs even while
  // HQ is scoped elsewhere.
  const { items, outside } = useAttentionQueue();
  const all = useMemo(() => [...items, ...outside], [items, outside]);
  const projects = useMemo(() => projectSummaries(snapshot, all), [snapshot, all]);
  const now = useNow();
  const openId = params.get('project');

  const toggle = (projectId: string): void => {
    const next = new URLSearchParams(params.toString());
    if (openId === projectId) next.delete('project');
    else next.set('project', projectId);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  if (snapshot === null) {
    return <p className="p-4 text-sm text-muted-foreground">Waiting for fleet data…</p>;
  }
  if (projects.length === 0) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <MobileFleetSwitch current="projects" />
        <FolderGit2 className="size-6 text-muted-foreground" />
        <h2 className="font-display text-xl font-semibold">No project has reported yet</h2>
        <p className="text-sm text-muted-foreground">
          A project shows up here as soon as a WrongStack client opened in it connects to HQ.
        </p>
      </div>
    );
  }

  const running = projects.filter((project) => project.sessions.length > 0).length;
  const working = projects.reduce((sum, project) => sum + project.working, 0);
  const waiting = projects.reduce((sum, project) => sum + project.attention.length, 0);
  return (
    <div className="flex flex-col gap-3 p-4">
      <MobileFleetSwitch current="projects" />
      <header className="flex flex-col gap-0.5">
        <h2 className="font-display text-xl font-semibold" data-testid="mobile-projects-headline">
          {running} of {projects.length} project{projects.length === 1 ? '' : 's'} with a session
          open
        </h2>
        <p className="text-sm text-muted-foreground">
          {working} agent{working === 1 ? '' : 's'} working · {waiting} waiting on you
        </p>
      </header>
      <ul className="flex flex-col gap-2" aria-label="Projects">
        {projects.map((project) => (
          <ProjectRow
            key={project.projectId}
            project={project}
            open={openId === project.projectId}
            onToggle={() => toggle(project.projectId)}
            now={now}
          />
        ))}
      </ul>
    </div>
  );
}

function ProjectRow({
  project,
  open,
  onToggle,
  now,
}: {
  project: ProjectSummary;
  open: boolean;
  onToggle: () => void;
  now: number;
}): ReactNode {
  const href = useSurfaceHref();
  const remembered = project.status === 'remembered';
  const detailId = `project-${project.projectId.replace(/[^a-z0-9-]/gi, '-')}`;
  return (
    <li className={cn('border', open ? 'border-primary/60' : 'border-border')}>
      <button
        type="button"
        data-mobile-project={project.projectId}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-3 py-3 text-left"
      >
        <span
          aria-hidden
          className={cn(
            'mt-1.5 size-2 shrink-0',
            project.working > 0
              ? 'bg-success'
              : project.sessions.length > 0
                ? 'bg-info'
                : 'bg-muted-foreground/50',
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium">{project.projectName}</span>
            {project.attention.length > 0 && (
              <span className="shrink-0 bg-warning px-1.5 text-xs font-semibold text-background">
                {project.attention.length}
              </span>
            )}
          </span>
          <span className="text-sm text-muted-foreground">{projectSentence(project)}</span>
          <span className="text-xs text-muted-foreground">
            {projectWhere(project)}
            {project.lastActivityAt !== '' &&
              ` · active ${relativeTime(project.lastActivityAt, now)}`}
          </span>
        </span>
        <ChevronDown
          aria-hidden
          className={cn('mt-1 size-4 shrink-0 text-muted-foreground', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div
          id={detailId}
          data-testid="mobile-project-detail"
          className="flex flex-col gap-4 border-t border-border px-3 py-3"
        >
          {project.attention.length > 0 && (
            <ul className="flex flex-col border border-warning/50">
              {project.attention.map((item) => (
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
          {remembered ? (
            <p className="text-sm">
              No client of this project is connected. HQ knows it from the machines it last ran on.
            </p>
          ) : (
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Agents working</dt>
                <dd className="tabular font-semibold">
                  {project.working} / {project.agents}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Spend</dt>
                <dd className="tabular font-semibold">{formatUsd(project.costUsd)}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs text-muted-foreground">Mail</dt>
                <dd
                  className={cn('tabular font-semibold', project.unreadMail > 0 && 'text-warning')}
                >
                  {project.unreadMail + project.openMail === 0
                    ? '—'
                    : `${project.unreadMail} unread · ${project.openMail} open`}
                </dd>
              </div>
            </dl>
          )}
          <div className="flex flex-col gap-1">
            <h4 className="text-sm font-semibold">Machines</h4>
            <ul className="flex flex-wrap gap-2">
              {project.machines.map((machine) => (
                <li key={machine.key}>
                  <Link
                    href={href(`/fleet/machines/?machine=${encodeURIComponent(machine.key)}`)}
                    className="inline-flex h-9 items-center gap-2 border border-border px-2.5 text-sm"
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
            <div className="flex flex-col gap-1">
              <h4 className="text-sm font-semibold">Open sessions</h4>
              <ul className="flex flex-col border border-border">
                {project.sessions.map((session) => (
                  <li
                    key={session.sessionId}
                    data-mobile-project-session={session.sessionId}
                    className="border-b border-border last:border-b-0"
                  >
                    <Link
                      href={href(
                        `/fleet/console/?session=${encodeURIComponent(session.sessionId)}`,
                      )}
                      className="flex items-center gap-3 px-3 py-2.5 text-sm"
                    >
                      <MessageSquareText className="size-4 shrink-0 text-muted-foreground" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">
                          {session.hostname}
                          <span className="text-muted-foreground">
                            {' '}
                            · {session.clientKind.toUpperCase()}
                            {session.gitBranch && ` · ${session.gitBranch}`}
                          </span>
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {session.working > 0
                            ? `${session.working} of ${session.agents} working`
                            : `idle ${relativeTime(session.lastActivityAt, now)}`}
                        </span>
                      </span>
                      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!remembered && (
            <Link
              href={href(`/work/?project=${encodeURIComponent(project.projectId)}`)}
              className="inline-flex h-10 items-center justify-center border border-border px-3 text-sm"
            >
              Open its board
            </Link>
          )}
        </div>
      )}
    </li>
  );
}
