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
} from '@wrongstack/core';
import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
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
  const { snapshot, events: storeEvents } = useHqStore(
    useShallow((s) => ({ snapshot: s.snapshot, events: s.events })),
  );
  const [mode, setMode] = useState<'grouped' | 'live'>('live');

  // Seed mailbox activity from the persisted event log so a freshly-connected
  // browser sees message content immediately (the in-memory ring only carries
  // envelopes received AFTER this browser connected), then fold in live ones.
  const { events: mailboxEvents } = useBackfilledEvents('mailbox.event', 300);
  const events = useMemo(
    () => [...mailboxEvents, ...storeEvents.filter((e) => e.type !== 'mailbox.event')],
    [mailboxEvents, storeEvents],
  );

  const { projects, hasAnyActivity } = useMemo(
    () => groupMailboxEvents(snapshot, events),
    [snapshot, events],
  );

  const totalUnread = snapshot?.totals.unreadMailboxMessages ?? 0;
  const totalIncomplete = snapshot?.totals.incompleteMailboxMessages ?? 0;

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
    return <div className="hq-empty">No mailbox activity reported by connected clients.</div>;
  }

  return (
    <div>
      <div className="hq-card-title">
        Mailbox Activity — {projects.length} project{projects.length === 1 ? '' : 's'} ·{' '}
        {totalUnread} unread · {totalIncomplete} incomplete
        {hasAnyActivity ? ' · showing detailed messages' : ''}
      </div>
      <MailboxComposer projects={composerProjects} />
      <div className="hq-mailbox-modebar" role="tablist" aria-label="Mailbox view mode">
        <button
          type="button"
          role="tab"
          className={'hq-btn secondary' + (mode === 'live' ? ' hq-btn-selected' : '')}
          aria-selected={mode === 'live'}
          onClick={() => setMode('live')}
        >
          Live feed
        </button>
        <button
          type="button"
          role="tab"
          className={'hq-btn secondary' + (mode === 'grouped' ? ' hq-btn-selected' : '')}
          aria-selected={mode === 'grouped'}
          onClick={() => setMode('grouped')}
        >
          Grouped by project
        </button>
      </div>
      {mode === 'live' ? (
        <LiveMailboxView snapshot={snapshot} events={events} />
      ) : (
        projects.map((g) => <ProjectSection key={g.projectId} group={g} />)
      )}
    </div>
  );
}

interface ProjectSectionProps {
  group: ProjectGroup;
}

function ProjectSection({ group }: ProjectSectionProps): React.ReactElement {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="hq-card">
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
          <span className="hq-mono hq-text-dim">
            {group.mailboxId}
          </span>
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
