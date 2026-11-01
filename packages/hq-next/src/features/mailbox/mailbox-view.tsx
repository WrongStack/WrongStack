'use client';

import { useHqStore } from '@hq/data/store/index';

import { type FlatMessage, groupMailboxEvents } from '@hq/domain/mailbox-grouping';
import { useBackfilledEvents } from '@hq/domain/use-backfilled-events';
import type { HqMailboxSummary, HqProjectRecord } from '@wrongstack/hq';
import { ArrowLeft, Inbox, MailPlus, Search, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { KeyboardEvent, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { relativeTime } from '@/features/attention/model';
import { plural } from '@/features/overview/model';
import { cn } from '@/lib/cn';
import { useFleetScope, useScopedSnapshot } from '@/lib/use-scope';
import { Composer } from './composer';
import { MessageDetail } from './message-detail';
import {
  DEFAULT_FILTERS,
  emptyDraft,
  filterMail,
  isUnread,
  MAIL_TYPE_LABEL,
  type MailFilters,
  mailFigures,
  mailTypeLabel,
  replyDraft,
} from './model';

const BACKFILL_LIMIT = 300;
const EMPTY_MAILBOXES: readonly HqMailboxSummary[] = [];
const EMPTY_PROJECTS: readonly HqProjectRecord[] = [];

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function MailboxView(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const snapshot = useScopedSnapshot();
  const fullSnapshot = useHqStore((state) => state.snapshot);
  const scope = useFleetScope();
  const mailboxes = snapshot?.mailboxes ?? EMPTY_MAILBOXES;
  const projects = snapshot?.projects ?? EMPTY_PROJECTS;
  const { events, loading } = useBackfilledEvents('mailbox.event', BACKFILL_LIMIT);
  const [filters, setFilters] = useState<MailFilters>(DEFAULT_FILTERS);
  // Soft-deleted in this tab: the HQ feed has no deletion event, so the tab
  // remembers what it removed and offers the restore.
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set());
  const listRef = useRef<HTMLUListElement>(null);
  const now = useNow();

  // Every message HQ knows, then the scoped list. A `?mail=` link to a message
  // outside the scope still opens it; only the list follows the scope.
  const everything = useMemo(
    () =>
      groupMailboxEvents(fullSnapshot, events)
        .projects.flatMap((group) => group.messages)
        .sort((left, right) => right.message.timestamp.localeCompare(left.message.timestamp)),
    [fullSnapshot, events],
  );
  const all = useMemo(
    () =>
      scope.kind === 'all'
        ? everything
        : everything.filter((flat) =>
            (snapshot?.projects ?? []).some((project) => project.projectId === flat.projectId),
          ),
    [everything, snapshot, scope],
  );

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of projects) names.set(project.projectId, project.projectName);
    return names;
  }, [projects]);
  const projectIds = useMemo(() => {
    const ids = new Set<string>(projects.map((project) => project.projectId));
    for (const flat of all) if (flat.projectId !== undefined) ids.add(flat.projectId);
    return [...ids];
  }, [projects, all]);
  const nameOf = (projectId: string | undefined): string =>
    projectId === undefined ? 'Unknown project' : (projectNames.get(projectId) ?? projectId);

  const visible = useMemo(() => filterMail(all, filters), [all, filters]);
  const figures = mailFigures(mailboxes);
  const composing = params.get('compose') === '1';
  // On a narrow screen the list and the open message take turns.
  const reading = composing || params.has('mail');
  const requested = params.get('mail');
  const selected = composing
    ? null
    : (everything.find((flat) => flat.message.mailId === requested) ?? visible[0] ?? null);
  const replyTo = composing
    ? everything.find((flat) => flat.message.mailId === params.get('reply'))
    : undefined;
  const defaultProject = filters.projectId !== 'all' ? filters.projectId : (projectIds[0] ?? '');

  const go = (query: Record<string, string>): void => {
    const search = new URLSearchParams(query).toString();
    router.replace(search === '' ? pathname : `${pathname}?${search}`, { scroll: false });
  };
  const open = (flat: FlatMessage): void => go({ mail: flat.message.mailId });

  const onListKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = selected === null ? -1 : visible.indexOf(selected);
    const next =
      visible[
        Math.min(visible.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))
      ];
    if (next === undefined) return;
    open(next);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-mail="${CSS.escape(next.message.mailId)}"]`)
      ?.focus();
  };

  if (projectIds.length === 0) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-start gap-3 px-6 py-16">
        <Inbox className="size-6 text-muted-foreground" />
        <h2 className="font-display text-2xl font-semibold">No project has reported a mailbox</h2>
        <p className="text-base text-muted-foreground">
          Messages between agents, and the ones you send them, appear here once a connected client
          reports its project.
        </p>
      </div>
    );
  }

  const filtered =
    filters.query !== '' ||
    filters.projectId !== 'all' ||
    filters.type !== 'all' ||
    filters.priority !== 'all';
  const set = (patch: Partial<MailFilters>): void =>
    setFilters((current) => ({ ...current, ...patch }));
  const select = 'h-9 border border-border bg-background px-2 text-sm';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-baseline gap-x-5 gap-y-1 px-6 pb-3 pt-5">
        <h2 className="font-display text-xl font-semibold">
          {figures.unread > 0 ? `${plural(figures.unread, 'message')} unread` : 'Nothing unread'}
        </h2>
        <span className="text-sm text-muted-foreground">
          <span className="tabular font-semibold text-foreground">{figures.open}</span> open
        </span>
        <span
          className={cn('text-sm text-muted-foreground', figures.high > 0 && 'text-destructive')}
        >
          <span className="tabular font-semibold">{figures.high}</span> high priority
        </span>
        <span className="text-sm text-muted-foreground">
          <span className="tabular font-semibold text-foreground">{figures.messages}</span> in{' '}
          {plural(mailboxes.length, 'mailbox', 'mailboxes')}
        </span>
        <span className="text-sm text-muted-foreground">
          {plural(figures.onlineAgents, 'agent')} online
        </span>
        <button
          type="button"
          onClick={() => go({ compose: '1' })}
          className="ml-auto inline-flex h-9 items-center gap-2 bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <MailPlus className="size-4" />
          Write a message
        </button>
      </div>

      <div
        className={cn(
          'flex shrink-0 flex-wrap items-center gap-3 border-y border-border px-6 py-3',
          reading && 'max-lg:hidden',
        )}
      >
        <label className="flex h-9 w-full items-center gap-2 border sm:w-64 border-border bg-background px-2.5 text-sm focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            type="search"
            value={filters.query}
            onChange={(event) => set({ query: event.target.value })}
            placeholder="Subject, sender, recipient, text"
            aria-label="Search messages"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </label>
        <select
          aria-label="Project"
          value={filters.projectId}
          onChange={(event) => set({ projectId: event.target.value })}
          className={select}
        >
          <option value="all">Every project</option>
          {projectIds.map((id) => (
            <option key={id} value={id}>
              {nameOf(id)}
            </option>
          ))}
        </select>
        <select
          aria-label="Type"
          value={filters.type}
          onChange={(event) => set({ type: event.target.value })}
          className={select}
        >
          <option value="all">Every type</option>
          {Object.entries(MAIL_TYPE_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="Priority"
          value={filters.priority}
          onChange={(event) => set({ priority: event.target.value })}
          className={select}
        >
          <option value="all">Any priority</option>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={filters.showDone}
            onChange={(event) => set({ showDone: event.target.checked })}
            className="size-4 accent-primary"
          />
          Show done
        </label>
        {filtered && (
          <button
            type="button"
            onClick={() =>
              setFilters((current) => ({ ...DEFAULT_FILTERS, showDone: current.showDone }))
            }
            className="inline-flex h-9 items-center gap-1 px-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" /> Clear
          </button>
        )}
        <span className="ml-auto text-sm text-muted-foreground">
          {visible.length === all.length
            ? plural(all.length, 'message')
            : `${visible.length} of ${all.length}`}
        </span>
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[420px_minmax(0,1fr)]">
        <div
          className={cn(
            'min-h-0 overflow-y-auto border-border bg-card lg:block lg:border-r',
            reading && 'hidden',
          )}
        >
          {visible.length === 0 ? (
            <p className="px-6 py-8 text-sm text-muted-foreground">
              {loading
                ? 'Loading messages…'
                : all.length === 0
                  ? 'No message has been streamed yet. The counts above come from the projects themselves.'
                  : filters.showDone
                    ? 'No message matches.'
                    : 'No open message matches. Done messages are hidden — tick “Show done”.'}
            </p>
          ) : (
            <ul ref={listRef} className="flex flex-col">
              {visible.map((flat) => (
                <li key={flat.message.mailId}>
                  <MailRow
                    flat={flat}
                    projectName={projectIds.length > 1 ? nameOf(flat.projectId) : undefined}
                    selected={selected?.message.mailId === flat.message.mailId}
                    deleted={deleted.has(flat.message.mailId)}
                    now={now}
                    onOpen={() => open(flat)}
                    onKeyDown={onListKey}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div
          className={cn(
            'min-h-0 min-w-0 overflow-y-auto px-6 py-6 lg:block lg:px-10',
            !reading && 'hidden',
          )}
        >
          <button
            type="button"
            onClick={() => go({})}
            className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground lg:hidden"
          >
            <ArrowLeft className="size-4" />
            All messages
          </button>
          {composing ? (
            <Composer
              key={replyTo?.message.mailId ?? 'new'}
              projects={projectIds.map((id) => ({ id, name: nameOf(id) }))}
              initial={
                replyTo !== undefined
                  ? replyDraft(replyTo, defaultProject)
                  : emptyDraft(defaultProject)
              }
              replyingTo={replyTo}
              onClose={() => go(replyTo !== undefined ? { mail: replyTo.message.mailId } : {})}
            />
          ) : selected !== null ? (
            <MessageDetail
              key={selected.message.mailId}
              flat={selected}
              projectName={nameOf(selected.projectId)}
              deleted={deleted.has(selected.message.mailId)}
              onDeletedChange={(isDeleted) =>
                setDeleted((current) => {
                  const next = new Set(current);
                  if (isDeleted) next.add(selected.message.mailId);
                  else next.delete(selected.message.mailId);
                  return next;
                })
              }
              onReply={() => go({ compose: '1', reply: selected.message.mailId })}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Select a message to read it.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function MailRow({
  flat,
  projectName,
  selected,
  deleted,
  now,
  onOpen,
  onKeyDown,
}: {
  flat: FlatMessage;
  projectName: string | undefined;
  selected: boolean;
  deleted: boolean;
  now: number;
  onOpen: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}): ReactNode {
  const message = flat.message;
  const unread = isUnread(message) && !deleted;
  return (
    <button
      type="button"
      data-mail={message.mailId}
      aria-current={selected ? 'true' : undefined}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      className={cn(
        'flex w-full flex-col gap-1 border-b border-border px-5 py-3 text-left hover:bg-muted/60',
        selected && 'bg-muted shadow-[inset_3px_0_0_var(--color-primary)]',
        (message.completed || deleted) && 'text-muted-foreground',
      )}
    >
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        {unread && (
          <span className="size-2 shrink-0 rounded-full bg-primary">
            <span className="sr-only">Unread</span>
          </span>
        )}
        <span className="font-medium text-foreground/80">{mailTypeLabel(message.type)}</span>
        {message.priority === 'high' && <span className="font-medium text-destructive">high</span>}
        {deleted ? (
          <span>deleted</span>
        ) : (
          message.completed && <span className="text-success">done</span>
        )}
        <span className="ml-auto shrink-0 tabular" title={message.timestamp}>
          {relativeTime(message.timestamp, now)}
        </span>
      </span>
      <span
        className={cn(
          'truncate text-sm',
          unread ? 'font-semibold' : 'font-medium',
          deleted && 'line-through',
        )}
      >
        {message.subject.trim() || '(no subject)'}
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {message.from} → {message.to}
        {projectName !== undefined && ` · ${projectName}`}
      </span>
    </button>
  );
}
