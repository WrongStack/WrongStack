/**
 * Mailbox view — detailed cross-project mailbox event feed.
 *
 * Two data planes feed this view:
 *   1. `snapshot.mailboxes[]` — per-project aggregate counters
 *      (messages, unread, incomplete, high-priority, online agents).
 *   2. `storeEvents` — every `mailbox.event` envelope from connected
 *      clients. Each envelope carries a full `HqMailboxMessageSummary`
 *      (subject, bodyPreview, from, to, type, priority, timestamp, …)
 *      plus the projectId it came from. We group those events by project
 *      so the operator can read the full content of every message
 *      instead of just the per-project counters.
 *
 * The actual grouping/dedup/sort lives in `./mailbox-grouping.ts` as a
 * pure helper so it can be unit-tested without jsdom or React.
 */

import type {
  HqEventEnvelope,
  HqMailboxEventPayload,
  HqMailboxMessageSummary,
} from '@wrongstack/core/hq';
import { Inbox, Layers3, ListFilter, Radio, TriangleAlert, UsersRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useBackfilledEvents } from '../lib/use-backfilled-events.js';
import { useHqStore } from '../store.js';
import { MailboxComposer } from './mailbox-composer.js';
import { type FlatMessage, groupMailboxEvents, type ProjectGroup } from './mailbox-grouping.js';
import { LiveMailboxView } from './mailbox-live-view.js';
import { MessageRow } from './mailbox-row.js';

const ACTION_LABEL: Record<HqMailboxEventPayload['action'], string> = {
  'message.sent': 'sent',
  'message.read': 'read',
  'message.completed': 'completed',
  'message.updated': 'updated',
  'agent.registered': 'agent registered',
  'agent.heartbeat': 'agent heartbeat',
  'agent.offline': 'agent offline',
  'agent.deregistered': 'agent deregistered',
};

export function MailboxView(): React.ReactElement {
  const snapshot = useHqStore((s) => s.snapshot);
  const [mode, setMode] = useState<'grouped' | 'live'>('live');

  // Seed mailbox activity from the persisted event log so a freshly-connected
  // browser sees message content immediately (the in-memory ring only carries
  // envelopes received AFTER this browser connected), then fold in live ones.
  const { events: mailboxEvents } = useBackfilledEvents('mailbox.event', 300);
  const events = mailboxEvents;

  const { projects, hasAnyActivity } = useMemo(
    () => groupMailboxEvents(snapshot, events),
    [snapshot, events],
  );

  const totalUnread = snapshot?.totals.unreadMailboxMessages ?? 0;
  const totalIncomplete = snapshot?.totals.incompleteMailboxMessages ?? 0;
  const totalMessages = (snapshot?.mailboxes ?? []).reduce(
    (sum, mailbox) => sum + mailbox.messageCount,
    0,
  );
  const highPriority = (snapshot?.mailboxes ?? []).reduce(
    (sum, mailbox) => sum + mailbox.highPriorityCount,
    0,
  );
  const onlineAgents = (snapshot?.mailboxes ?? []).reduce(
    (sum, mailbox) => sum + mailbox.onlineAgentCount,
    0,
  );

  // Compose targets: every project HQ knows about — mailbox groups plus the
  // snapshot's project records (a project can be a valid target before any
  // mailbox activity streamed). Labels prefer the snapshot's human name.
  const composerProjects = useMemo(() => {
    const byId = new Map<string, { projectId: string; label?: string | undefined }>();
    for (const p of snapshot?.projects ?? []) {
      byId.set(p.projectId, { projectId: p.projectId, label: p.projectName });
    }
    for (const g of projects) {
      if (!byId.has(g.projectId)) byId.set(g.projectId, { projectId: g.projectId });
    }
    return Array.from(byId.values());
  }, [snapshot, projects]);

  if (projects.length === 0 && composerProjects.length === 0) {
    return (
      <div className="hq-mailbox-zero">
        <span className="hq-mailbox-zero-icon" aria-hidden="true">
          <Inbox size={26} />
        </span>
        <span className="hq-section-kicker">Coordination inbox</span>
        <h2>Waiting for mailbox traffic</h2>
        <p>
          Connected projects, inter-agent messages and durable prompts will appear here as soon as a
          client reports mailbox activity.
        </p>
      </div>
    );
  }

  return (
    <div className="hq-screen hq-mailbox-screen">
      <section className="hq-screen-hero hq-mailbox-hero" aria-label="Mailbox command summary">
        <div>
          <span className="hq-section-kicker">Coordination inbox</span>
          <h2>
            {totalUnread > 0
              ? `${totalUnread} message${totalUnread === 1 ? '' : 's'} ${totalUnread === 1 ? 'needs' : 'need'} review`
              : 'Coordination is clear'}
          </h2>
          <p>
            Live cross-project traffic, durable prompts and unresolved coordination work share one
            operator inbox.
          </p>
          <div className="hq-mailbox-hero-state">
            <span className="hq-pill active">
              <Radio size={11} /> live sync
            </span>
            <span className="hq-mono hq-text-dim">
              Mailbox Activity — {projects.length} project{projects.length === 1 ? '' : 's'} ·{' '}
              {totalUnread} unread · {totalIncomplete} incomplete
              {hasAnyActivity ? ' · detailed messages available' : ''}
            </span>
          </div>
        </div>
        <div className="hq-hero-metrics">
          <MailboxMetric label="messages" value={totalMessages} />
          <MailboxMetric
            label="unread"
            value={totalUnread}
            tone={totalUnread > 0 ? 'warn' : 'ok'}
          />
          <MailboxMetric
            label="high priority"
            value={highPriority}
            tone={highPriority > 0 ? 'error' : 'ok'}
          />
          <MailboxMetric
            label="online agents"
            value={onlineAgents}
            tone={onlineAgents > 0 ? 'ok' : undefined}
          />
        </div>
      </section>

      <div className="hq-mailbox-command-strip">
        <div>
          <strong>Durable delivery</strong>
          <span>
            Write directly to a project mailbox, even when no agent is currently connected.
          </span>
        </div>
        <MailboxComposer projects={composerProjects} />
      </div>

      <div className="hq-mailbox-workspace-head">
        <div>
          <span className="hq-section-kicker">Message workspace</span>
          <strong>{mode === 'live' ? 'Unified timeline' : 'Project channels'}</strong>
        </div>
        <div className="hq-mailbox-modebar" role="tablist" aria-label="Mailbox view mode">
          <button
            type="button"
            role="tab"
            className={'hq-btn secondary' + (mode === 'live' ? ' hq-btn-selected' : '')}
            aria-selected={mode === 'live'}
            onClick={() => setMode('live')}
          >
            <ListFilter size={13} /> Live feed
          </button>
          <button
            type="button"
            role="tab"
            className={'hq-btn secondary' + (mode === 'grouped' ? ' hq-btn-selected' : '')}
            aria-selected={mode === 'grouped'}
            onClick={() => setMode('grouped')}
          >
            <Layers3 size={13} /> Grouped by project
          </button>
        </div>
      </div>

      <div className="hq-mailbox-workspace">
        {mode === 'live' ? (
          <LiveMailboxView snapshot={snapshot} events={events} />
        ) : (
          projects.map((g) => <ProjectSection key={g.projectId} group={g} />)
        )}
      </div>
    </div>
  );
}

function MailboxMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'ok' | 'warn' | 'error';
}): React.ReactElement {
  const Icon = tone === 'error' ? TriangleAlert : label === 'online agents' ? UsersRound : Inbox;
  return (
    <div className="hq-hero-metric hq-mailbox-metric" data-tone={tone}>
      <Icon size={13} />
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

interface ProjectSectionProps {
  group: ProjectGroup;
}

function ProjectSection({ group }: ProjectSectionProps): React.ReactElement {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="hq-card hq-mailbox-project-card">
      <div className="hq-row hq-row-baseline">
        <button
          type="button"
          className="hq-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? 'Collapse project messages' : 'Expand project messages'}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span className="hq-text-bright">{group.projectId}</span>
        {group.scope !== undefined && <span className="hq-pill info">{group.scope}</span>}
        {group.mailboxId !== undefined && (
          <span className="hq-mono hq-text-dim">{group.mailboxId}</span>
        )}
        <span className="hq-mono hq-text-dim hq-ml-auto">
          {group.messages.length} message{group.messages.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="hq-grid hq-mt-8" style={{ gridTemplateColumns: 'repeat(5,1fr)' }}>
        <Count label="messages" value={group.messages.length} />
        <Count
          label="unread"
          value={group.unreadCount}
          accent={group.unreadCount > 0 ? 'amber' : undefined}
        />
        <Count
          label="incomplete"
          value={group.incompleteCount}
          accent={group.incompleteCount > 0 ? 'red' : undefined}
        />
        <Count
          label="high-priority"
          value={group.highPriorityCount}
          accent={group.highPriorityCount > 0 ? 'red' : undefined}
        />
        <Count
          label="online agents"
          value={group.onlineAgentCount}
          accent={group.onlineAgentCount > 0 ? 'green' : undefined}
        />
      </div>
      {expanded && group.messages.length > 0 && (
        <div className="hq-msg-list hq-mt-12">
          {group.messages.map((m) => (
            <MessageRow key={m.key} flat={m} />
          ))}
        </div>
      )}
      {expanded && group.messages.length === 0 && (
        <div className="hq-empty hq-cockpit-empty">
          Snapshot counters reported for this project, but no detailed mailbox events have streamed
          yet.
        </div>
      )}
    </div>
  );
}

function Count({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: 'amber' | 'red' | 'green';
}): React.ReactElement {
  const color =
    accent === 'amber'
      ? 'var(--amber)'
      : accent === 'red'
        ? 'var(--red)'
        : accent === 'green'
          ? 'var(--green)'
          : 'var(--text)';
  return (
    <div className="hq-text-center">
      <div className="hq-stat-num" style={{ color }}>
        {value}
      </div>
      <div className="hq-stat-label">{label}</div>
    </div>
  );
}

// Re-export the latest mailbox events for callers that want to surface
// them in tooltips (e.g. the nav badge). Keeps the view self-contained.
export function useLatestMailboxEvent(): HqEventEnvelope<HqMailboxEventPayload> | null {
  const storeEvents = useHqStore((s) => s.events);
  for (let i = storeEvents.length - 1; i >= 0; i--) {
    const evt = storeEvents[i];
    if (
      evt !== undefined &&
      evt.type === 'mailbox.event' &&
      typeof evt.payload === 'object' &&
      evt.payload !== null
    ) {
      return evt as HqEventEnvelope<HqMailboxEventPayload>;
    }
  }
  return null;
}

// Silence unused-import warnings for ACTION_LABEL — exposed for callers
// (e.g. an "Activity" tab) that want to render the same action verbs.
export const MAILBOX_ACTION_LABELS = ACTION_LABEL;

// Re-export the FlatMessage + ProjectGroup types so consumers wiring
// custom message rows can stay typed without reaching into the helper.
export type { FlatMessage, HqMailboxMessageSummary, ProjectGroup };
