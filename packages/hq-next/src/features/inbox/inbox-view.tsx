'use client';

/**
 * Inbox — one queue for everything waiting on a human.
 *
 * Decisions (permission prompts, model questions) are answered here. Issues
 * (blocked agents, failed commands, lost clients, governance, alerts) are
 * explained here and handed to the surface that resolves them. The selected
 * card lives in the URL (`?item=`), so the Overview can link straight to it and
 * a reload keeps the operator where they were.
 */
import { useHqStore } from '@hq/data/store/index';
import { useAnswerUserInput } from '@hq/domain/use-pending-user-inputs';
import { UserInputCard } from '@hq/views/user-input-card';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { KeyboardEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { OutsideScopeNote } from '@/components/scope-picker';
import { cn } from '@/lib/cn';
import { useSurfaceHref } from '@/lib/surface';
import { governanceDetail } from '../attention/governance';
import {
  type AttentionItem,
  DECISION_KINDS,
  inboxItemHref,
  relativeTime,
} from '../attention/model';
import { useAttentionQueue } from '../attention/use-attention-queue';
import { ApprovalDetail } from './approval-detail';

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function InboxView(): ReactNode {
  const router = useRouter();
  const toSurface = useSurfaceHref();
  const params = useSearchParams();
  const { items, outside, approvals, questions, approvalsLoading } = useAttentionQueue();
  const now = useNow();
  const listRef = useRef<HTMLDivElement>(null);

  const requested = params.get('item');
  // A resolved item disappears; fall through to the next one instead of an empty pane.
  // A link to an item outside the scope still opens it; the list stays scoped.
  const selected =
    items.find((item) => item.id === requested) ??
    outside.find((item) => item.id === requested) ??
    items[0] ??
    null;
  // Below `lg` the queue and the card take turns: a tap opens the card, Back
  // returns to the queue. Stacking both left the card off-screen after a tap.
  const reading = requested !== null;
  const decisions = items.filter((item) => DECISION_KINDS.has(item.kind));
  const issues = items.filter((item) => !DECISION_KINDS.has(item.kind));

  const select = (item: AttentionItem): void => {
    router.replace(toSurface(inboxItemHref(item.id)), { scroll: false });
  };

  const onListKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = selected === null ? -1 : items.findIndex((item) => item.id === selected.id);
    const next =
      items[Math.min(items.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next === undefined) return;
    select(next);
    listRef.current?.querySelector<HTMLElement>(`[data-item="${CSS.escape(next.id)}"]`)?.focus();
  };

  if (items.length === 0 && selected === null) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-3 px-6 py-16">
        <OutsideScopeNote count={outside.length} />
        <span className="grid size-10 place-items-center bg-success/15 text-success">
          <Check className="size-5" />
        </span>
        <h2 className="font-display text-3xl font-semibold tracking-tight">
          {approvalsLoading ? 'Checking for pending decisions…' : 'Nothing is waiting on you'}
        </h2>
        <p className="max-w-xl text-base text-muted-foreground">
          Permission prompts and model questions from every machine arrive here first, with the time
          left before the run decides without you. Failures and alerts follow.
        </p>
        <Link
          href={toSurface('/inbox/alerts/')}
          className="mt-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          Alert history <ArrowRight className="size-3.5" />
        </Link>
      </div>
    );
  }

  return (
    <div className="grid min-h-full content-start lg:grid-cols-[380px_minmax(0,1fr)] lg:content-stretch">
      <div
        ref={listRef}
        className={cn(
          'flex-col gap-6 border-border bg-card px-3 py-5 lg:flex lg:border-r',
          reading ? 'hidden' : 'flex',
        )}
      >
        <OutsideScopeNote count={outside.length} />
        <QueueGroup
          title="Decisions"
          hint="Answer here"
          items={decisions}
          selectedId={selected?.id ?? null}
          now={now}
          onSelect={select}
          onKeyDown={onListKey}
        />
        <QueueGroup
          title="Issues"
          hint="Resolve elsewhere"
          items={issues}
          selectedId={selected?.id ?? null}
          now={now}
          onSelect={select}
          onKeyDown={onListKey}
        />
      </div>

      <div className={cn('min-w-0 px-6 py-6 lg:block lg:px-10', reading ? 'block' : 'hidden')}>
        <button
          type="button"
          onClick={() => router.replace(toSurface('/inbox/'), { scroll: false })}
          className="mb-5 inline-flex h-9 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground lg:hidden"
        >
          <ArrowLeft className="size-4" /> All items
        </button>
        {selected !== null && (
          <Detail
            key={selected.id}
            item={selected}
            approval={approvals.find((entry) => entry.toolUseId === selected.sourceId)}
            question={questions.find((entry) => entry.request.id === selected.sourceId)}
            now={now}
          />
        )}
      </div>
    </div>
  );
}

function QueueGroup({
  title,
  hint,
  items,
  selectedId,
  now,
  onSelect,
  onKeyDown,
}: {
  title: string;
  hint: string;
  items: readonly AttentionItem[];
  selectedId: string | null;
  now: number;
  onSelect: (item: AttentionItem) => void;
  /** Arrow keys move the selection through the whole queue. */
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}): ReactNode {
  return (
    <section aria-label={title}>
      <header className="flex items-baseline gap-2 px-2 pb-2">
        <h2 className="font-display text-base font-semibold">{title}</h2>
        <span className="tabular text-sm text-muted-foreground">{items.length}</span>
        <span className="ml-auto text-xs text-muted-foreground">{hint}</span>
      </header>
      {items.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">None.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {items.map((item) => {
            const active = item.id === selectedId;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  data-item={item.id}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => onSelect(item)}
                  onKeyDown={onKeyDown}
                  className={cn(
                    'flex w-full items-start gap-3 border-l-2 px-3 py-2.5 text-left',
                    active ? 'border-primary bg-accent/60' : 'border-transparent hover:bg-muted/60',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'mt-1.5 size-2 shrink-0',
                      item.tone === 'critical' ? 'bg-destructive' : 'bg-warning',
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{item.title}</span>
                    <span className="block truncate text-sm text-muted-foreground">
                      {item.context}
                    </span>
                  </span>
                  <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">
                    {relativeTime(item.at, now)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const ISSUE_EXPLANATION: Record<Exclude<AttentionItem['kind'], 'approval' | 'question'>, string> = {
  agent:
    'The agent cannot continue on its own. Open its conversation to see what it is asking for or why it failed, and steer it from there.',
  command:
    'A remote command did not apply on the target machine. The command audit shows what was sent and the reason the client gave.',
  client:
    'HQ stopped hearing from this client. It may have exited, slept or lost its network; its last known state is still on the fleet map.',
  host: 'A WrongStack client on this machine reported it is low on disk space or memory. Sessions there can fail to write files, build or install packages until space is freed. The Machines page shows the latest reading.',
  machine:
    'Every WrongStack client on this machine disconnected. It may be shut down, asleep or off the network. HQ keeps it in the Machines list for 30 days; forget it there once it has been retired.',
  governance:
    'The project’s governance broker is degraded or unreadable, so policy decisions on that machine may not be enforced as configured.',
  run: 'This subagent run used its whole spawn budget while tasks are still queued, so they will never start. Raise maxSpawns in the project’s config, or steer the session’s leader to stop queueing work.',
  mcp: 'A terminal’s MCP server is failing or over its limits, so tools from it fail or slow the agents down. The MCP page shows the cause; fix it in that terminal with /mcp.',
  version:
    'A client on a different release than HQ can miss commands the dashboard offers or report fields HQ does not know. Run wstack update on each machine listed, then restart its WrongStack sessions.',
  alert:
    'An alert rule fired. Its full history, including when it first fired and how often, is in the alert history.',
};

function Detail({
  item,
  approval,
  question,
  now,
}: {
  item: AttentionItem;
  approval: Parameters<typeof ApprovalDetail>[0]['approval'] | undefined;
  question: Parameters<typeof UserInputCard>[0]['input'] | undefined;
  now: number;
}): ReactNode {
  const router = useRouter();
  const toSurface = useSurfaceHref();
  const userInput = useAnswerUserInput();
  const projects = useHqStore((state) => state.snapshot?.projects);

  if (item.kind === 'approval' && approval !== undefined) {
    return (
      <ApprovalDetail
        approval={approval}
        projectName={
          projects?.find((project) => project.projectId === approval.projectId)?.projectName
        }
      />
    );
  }
  if (item.kind === 'question' && question !== undefined) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">Question from a model</p>
        <UserInputCard
          input={question}
          sending={userInput.pendingFor(question.request.id)}
          onSubmit={userInput.answer}
        />
      </div>
    );
  }

  const explanation =
    item.kind === 'approval' || item.kind === 'question'
      ? 'This request was answered or expired a moment ago.'
      : ISSUE_EXPLANATION[item.kind];
  const governancePayload =
    item.kind === 'governance'
      ? projects?.find((project) => project.projectId === item.sourceId)?.governance
      : undefined;
  const governance = governancePayload !== undefined ? governanceDetail(governancePayload) : null;
  const act = (): void => {
    if (item.focus !== undefined) {
      useHqStore.getState().selectAgent(item.focus.sessionId, item.focus.agentId);
    }
    router.push(toSurface(item.href));
  };

  return (
    <article className="flex max-w-2xl flex-col gap-5">
      <header>
        <p className="text-sm text-muted-foreground">
          {item.tone === 'critical' ? 'Urgent' : 'Needs a look'}
          {item.at !== undefined && ` · ${relativeTime(item.at, now)}`}
        </p>
        <h2 className="mt-1 font-display text-2xl font-semibold tracking-tight">{item.title}</h2>
        <p className="mt-1 text-base text-muted-foreground">{item.context}</p>
      </header>
      <p className="text-base leading-relaxed">{explanation}</p>
      {governance !== null && (
        <div className="flex flex-col gap-3 border border-border p-4">
          <p className="text-base">{governance.sentence}</p>
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {governance.facts.map((fact) => (
              <div key={fact.label} className="flex flex-col">
                <dt className="text-xs text-muted-foreground">{fact.label}</dt>
                <dd className={fact.warn ? 'text-sm text-warning' : 'text-sm'}>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <div>
        <button
          type="button"
          onClick={act}
          className="inline-flex h-10 items-center gap-2 bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {item.action}
          <ArrowRight className="size-4" />
        </button>
      </div>
    </article>
  );
}
