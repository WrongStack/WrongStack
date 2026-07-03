/**
 * Mailbox view — detailed cross-project mailbox event feed.
 *
 * Two data planes feed this view:
 *   1. `snapshot.mailboxes[]` — per-project aggregate counters
 *      (messages, unread, incomplete, high-priority, online agents).
 *   2. `state.events` — every `mailbox.event` envelope from connected
 *      clients. Each envelope carries a full `HqMailboxMessageSummary`
 *      (subject, bodyPreview, from, to, type, priority, timestamp, …)
 *      plus the projectId it came from. We group those events by project
 *      so the operator can read the full content of every message
 *      instead of just the per-project counters.
 *
 * The actual grouping/dedup/sort lives in `./mailbox-grouping.ts` as a
 * pure helper so it can be unit-tested without jsdom or React.
 */
import { useMemo, useState } from 'react';
import { useHqStore } from '../store.js';
import type {
  HqEventEnvelope,
  HqMailboxEventPayload,
  HqMailboxMessageSummary,
  HqMailboxMessageType,
} from '@wrongstack/core';
import { groupMailboxEvents, type FlatMessage, type ProjectGroup } from './mailbox-grouping.js';

const TYPE_LABEL: Record<HqMailboxMessageType, { icon: string; tone: string }> = {
  note: { icon: '📝', tone: 'info' },
  ask: { icon: '❓', tone: 'warn' },
  assign: { icon: '📌', tone: 'warn' },
  steer: { icon: '🛞', tone: 'warn' },
  btw: { icon: '💬', tone: 'info' },
  broadcast: { icon: '📣', tone: 'info' },
  status: { icon: '📊', tone: 'idle' },
  result: { icon: '✅', tone: 'running' },
  review: { icon: '🔍', tone: 'info' },
  control: { icon: '⚙️', tone: 'error' },
};

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

function formatTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

function shortId(s: string): string {
  if (s.length <= 14) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

export function MailboxView(): React.ReactElement {
  const state = useHqStore();
  const snapshot = state.snapshot;

  const { projects, hasAnyActivity } = useMemo(
    () => groupMailboxEvents(snapshot, state.events),
    [snapshot, state.events],
  );

  const totalUnread = snapshot?.totals.unreadMailboxMessages ?? 0;
  const totalIncomplete = snapshot?.totals.incompleteMailboxMessages ?? 0;

  if (projects.length === 0) {
    return <div className="hq-empty">No mailbox activity reported by connected clients.</div>;
  }

  return (
    <div>
      <div className="hq-card-title">
        Mailbox Activity — {projects.length} project{projects.length === 1 ? '' : 's'} ·{' '}
        {totalUnread} unread · {totalIncomplete} incomplete
        {hasAnyActivity ? ' · showing detailed messages' : ''}
      </div>
      {projects.map((g) => (
        <ProjectSection key={g.projectId} group={g} />
      ))}
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
      <div className="hq-row" style={{ alignItems: 'baseline' }}>
        <button
          type="button"
          className="hq-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? 'Collapse project messages' : 'Expand project messages'}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span style={{ fontWeight: 700 }}>{group.projectId}</span>
        {group.scope !== undefined && <span className="hq-pill info">{group.scope}</span>}
        {group.mailboxId !== undefined && (
          <span className="hq-mono" style={{ color: 'var(--dim)' }}>
            {group.mailboxId}
          </span>
        )}
        <span className="hq-mono" style={{ color: 'var(--dim)', marginLeft: 'auto' }}>
          {group.messages.length} message{group.messages.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="hq-grid" style={{ gridTemplateColumns: 'repeat(5,1fr)', marginTop: 8 }}>
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
        <div className="hq-msg-list" style={{ marginTop: 12 }}>
          {group.messages.map((m) => (
            <MessageRow key={m.key} flat={m} />
          ))}
        </div>
      )}
      {expanded && group.messages.length === 0 && (
        <div className="hq-empty" style={{ padding: 16, fontSize: 12 }}>
          Snapshot counters reported for this project, but no detailed mailbox events have streamed
          yet.
        </div>
      )}
    </div>
  );
}

interface MessageRowProps {
  flat: FlatMessage;
}

function MessageRow({ flat }: MessageRowProps): React.ReactElement {
  const m = flat.message;
  const [open, setOpen] = useState(false);
  const hasBody = m.hasBody || (m.bodyPreview !== undefined && m.bodyPreview.length > 0);
  const typeMeta = TYPE_LABEL[m.type] ?? { icon: '✉️', tone: 'info' };
  const fromTo = `${m.from} → ${m.to}`;

  return (
    <div className={'hq-msg' + (m.completed ? ' done' : '')}>
      <div className="hq-msg-head" onClick={() => hasBody && setOpen((v) => !v)}>
        <span className="hq-msg-icon" title={m.type}>
          {typeMeta.icon}
        </span>
        <span className={'hq-pill ' + typeMeta.tone}>{m.type}</span>
        {m.priority === 'high' && <span className="hq-pill error">high</span>}
        {m.priority === 'low' && <span className="hq-pill idle">low</span>}
        <span className="hq-msg-subject" title={m.subject}>
          {m.subject || '(no subject)'}
        </span>
        <span className="hq-mono hq-msg-route">{fromTo}</span>
        <span className="hq-mono hq-msg-time" title={m.timestamp}>
          {formatTime(m.timestamp)}
        </span>
        <span className="hq-mono hq-msg-id">{shortId(m.messageId)}</span>
        <span className={'hq-msg-flag ' + (m.completed ? 'done' : 'open')}>
          {m.completed
            ? `completed${m.completedBy !== undefined ? ` by ${m.completedBy}` : ''}`
            : 'open'}
        </span>
        {hasBody && (
          <button
            type="button"
            className="hq-toggle hq-msg-toggle"
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
            aria-label={open ? 'Collapse body' : 'Expand body'}
          >
            {open ? '▾' : '▸'}
          </button>
        )}
      </div>
      {open && (
        <div className="hq-msg-body">
          {m.bodyPreview !== undefined && m.bodyPreview.length > 0 ? (
            <pre className="hq-msg-pre">{m.bodyPreview}</pre>
          ) : (
            <div className="hq-empty" style={{ padding: 8, fontSize: 12 }}>
              (empty body)
            </div>
          )}
          {m.outcomePreview !== undefined && m.outcomePreview.length > 0 && (
            <>
              <div className="hq-msg-sublabel">outcome</div>
              <pre className="hq-msg-pre">{m.outcomePreview}</pre>
            </>
          )}
          <div className="hq-msg-meta">
            <span>
              <strong>source:</strong> {flat.source}
            </span>
            {m.replyTo !== undefined && (
              <span>
                <strong>reply to:</strong> {shortId(m.replyTo)}
              </span>
            )}
            {m.senderSessionId !== undefined && (
              <span>
                <strong>sender session:</strong> {shortId(m.senderSessionId)}
              </span>
            )}
            {(m.readCount ?? 0) > 0 && (
              <span>
                <strong>reads:</strong> {m.readCount}
              </span>
            )}
            {m.unreadCount !== undefined && m.unreadCount > 0 && (
              <span>
                <strong>unread:</strong> {m.unreadCount}
              </span>
            )}
            {m.task !== undefined && (
              <span>
                <strong>task:</strong> {m.task.taskId ?? '—'}
                {m.task.agentName !== undefined ? ` · ${m.task.agentName}` : ''}
                {m.task.status !== undefined ? ` (${m.task.status})` : ''}
              </span>
            )}
          </div>
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
    <div style={{ textAlign: 'center' }}>
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
  const state = useHqStore();
  for (let i = state.events.length - 1; i >= 0; i--) {
    const evt = state.events[i];
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
export type { FlatMessage, ProjectGroup, HqMailboxMessageSummary };
