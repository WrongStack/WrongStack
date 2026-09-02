/**
 * Mailbox — cross-project coordination traffic.
 *
 * Two data planes feed it:
 *   1. `snapshot.mailboxes[]` — per-project aggregate counters.
 *   2. `mailbox.event` envelopes — each carrying a full message summary.
 *
 * The counters answer "how much is outstanding"; the envelopes answer "what
 * does it actually say". Grouping, dedup and sorting are pure
 * (`domain/mailbox-grouping`), so they are unit-tested without a DOM.
 *
 * Envelopes are seeded from the PERSISTED event log, because the in-memory
 * ring only holds what arrived after this browser connected — without the
 * backfill a fresh tab shows counters with no messages behind them.
 */
import { ChevronDown, ChevronRight, Inbox, Layers3, ListFilter, Radio } from 'lucide-react';
import type * as React from 'react';
import { useMemo, useState } from 'react';
import { EmptyState, Mono, StatTile } from '../../components/hq/primitives.js';
import { HeroMetric, ViewHero, ViewShell } from '../../components/hq/view-chrome.js';
import { Badge } from '../../components/ui/badge.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { useHqStore } from '../../data/store/index.js';
import { groupMailboxEvents, type ProjectGroup } from '../../domain/mailbox-grouping.js';
import { useBackfilledEvents } from '../../domain/use-backfilled-events.js';
import { type ComposerProject, MailboxComposer } from './composer.js';
import { LiveMailboxFeed } from './live-feed.js';
import { MessageRow } from './message-row.js';

const BACKFILL_LIMIT = 300;

function ProjectSection({ group }: { group: ProjectGroup }): React.ReactElement {
  const [expanded, setExpanded] = useState(true);

  return (
    <Card data-testid="mailbox-project">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse project messages' : 'Expand project messages'}
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <span className="text-sm font-medium">{group.projectId}</span>
        {group.scope !== undefined && <Badge tone="info">{group.scope}</Badge>}
        {group.mailboxId !== undefined && <Mono>{group.mailboxId}</Mono>}
        <Mono className="tabular ml-auto">
          {group.messages.length} message{group.messages.length === 1 ? '' : 's'}
        </Mono>
      </div>

      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <StatTile label="messages" value={group.messages.length} />
          <StatTile
            label="unread"
            value={group.unreadCount}
            tone={group.unreadCount > 0 ? 'warn' : 'idle'}
          />
          <StatTile
            label="incomplete"
            value={group.incompleteCount}
            tone={group.incompleteCount > 0 ? 'error' : 'idle'}
          />
          <StatTile
            label="high priority"
            value={group.highPriorityCount}
            tone={group.highPriorityCount > 0 ? 'error' : 'idle'}
          />
          <StatTile
            label="online agents"
            value={group.onlineAgentCount}
            tone={group.onlineAgentCount > 0 ? 'active' : 'idle'}
          />
        </div>

        {expanded &&
          (group.messages.length > 0 ? (
            <div className="space-y-1.5">
              {group.messages.map((message) => (
                <MessageRow key={message.key} flat={message} />
              ))}
            </div>
          ) : (
            <EmptyState
              title="Counters only"
              hint="This project reported mailbox totals, but no detailed events have streamed yet."
            />
          ))}
      </CardContent>
    </Card>
  );
}

export function MailboxView(): React.ReactElement {
  const snapshot = useHqStore((state) => state.snapshot);
  const { events } = useBackfilledEvents('mailbox.event', BACKFILL_LIMIT);

  const { projects, hasAnyActivity } = useMemo(
    () => groupMailboxEvents(snapshot, events),
    [snapshot, events],
  );

  const mailboxes = snapshot?.mailboxes ?? [];
  const totalUnread = snapshot?.totals.unreadMailboxMessages ?? 0;
  const totalIncomplete = snapshot?.totals.incompleteMailboxMessages ?? 0;
  const totalMessages = mailboxes.reduce((sum, mailbox) => sum + mailbox.messageCount, 0);
  const highPriority = mailboxes.reduce((sum, mailbox) => sum + mailbox.highPriorityCount, 0);
  const onlineAgents = mailboxes.reduce((sum, mailbox) => sum + mailbox.onlineAgentCount, 0);

  /**
   * Compose targets: every project HQ knows about. A project is a valid
   * destination before any mailbox traffic has streamed, so the snapshot's
   * project records are unioned in — and their human names win over ids.
   */
  const composerProjects = useMemo<ComposerProject[]>(() => {
    const byId = new Map<string, ComposerProject>();
    for (const project of snapshot?.projects ?? []) {
      byId.set(project.projectId, { projectId: project.projectId, label: project.projectName });
    }
    for (const group of projects) {
      if (!byId.has(group.projectId)) byId.set(group.projectId, { projectId: group.projectId });
    }
    return [...byId.values()];
  }, [snapshot, projects]);

  if (projects.length === 0 && composerProjects.length === 0) {
    return (
      <ViewShell>
        <EmptyState
          icon={Inbox}
          title="Waiting for mailbox traffic"
          hint="Connected projects, inter-agent messages and durable prompts appear here as soon as a client reports mailbox activity."
        />
      </ViewShell>
    );
  }

  return (
    <ViewShell>
      <ViewHero
        eyebrow="Coordination inbox"
        headline={
          totalUnread > 0
            ? `${totalUnread} message${totalUnread === 1 ? '' : 's'} ${totalUnread === 1 ? 'needs' : 'need'} review`
            : 'Coordination is clear'
        }
        description="Live cross-project traffic, durable prompts and unresolved coordination work in one operator inbox."
        tone={totalUnread > 0 ? 'warn' : 'active'}
        metrics={
          <>
            <HeroMetric label="messages" value={totalMessages} />
            <HeroMetric
              label="unread"
              value={totalUnread}
              tone={totalUnread > 0 ? 'warn' : 'active'}
            />
            <HeroMetric
              label="high priority"
              value={highPriority}
              tone={highPriority > 0 ? 'error' : 'active'}
            />
            <HeroMetric
              label="online agents"
              value={onlineAgents}
              tone={onlineAgents > 0 ? 'active' : 'idle'}
            />
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <Badge tone="active">
          <Radio />
          live sync
        </Badge>
        <Mono>
          {projects.length} project{projects.length === 1 ? '' : 's'} · {totalUnread} unread ·{' '}
          {totalIncomplete} incomplete
          {hasAnyActivity ? ' · detailed messages available' : ''}
        </Mono>
        <div className="ml-auto">
          <MailboxComposer projects={composerProjects} />
        </div>
      </div>

      <Tabs defaultValue="live">
        <TabsList>
          <TabsTrigger value="live">
            <ListFilter />
            Live feed
          </TabsTrigger>
          <TabsTrigger value="grouped">
            <Layers3 />
            Grouped by project
          </TabsTrigger>
        </TabsList>

        <TabsContent value="live" className="pt-3">
          <LiveMailboxFeed snapshot={snapshot} events={events} />
        </TabsContent>

        <TabsContent value="grouped" className="space-y-3 pt-3">
          {projects.length === 0 ? (
            <EmptyState title="No project mailbox activity yet" />
          ) : (
            projects.map((group) => <ProjectSection key={group.projectId} group={group} />)
          )}
        </TabsContent>
      </Tabs>
    </ViewShell>
  );
}
