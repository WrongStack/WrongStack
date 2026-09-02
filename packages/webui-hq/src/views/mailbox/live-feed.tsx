/**
 * Live mailbox feed — one flat, filterable timeline across every project.
 *
 * Filters are persisted to local prefs so a reload lands the operator back on
 * the same slice of traffic. Building the feed itself is pure
 * (`buildLiveFeedFromHq`) and unit-tested without a DOM.
 */
import type {
  HqEventEnvelope,
  HqMailboxMessageType,
  HqMailboxPriority,
  HqSnapshot,
} from '@wrongstack/core/hq';
import type * as React from 'react';
import { useEffect, useMemo, useReducer } from 'react';
import { EmptyState } from '../../components/hq/primitives.js';
import { FilterChip } from '../../components/hq/filter-chip.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { Checkbox } from '../../components/ui/checkbox.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { setHqMailboxPrefs, useHqLocalPrefs } from '../../data/local-prefs.js';
import { mailboxLiveFilterReducer } from '../../domain/mailbox-filters.js';
import { groupMailboxEvents } from '../../domain/mailbox-grouping.js';
import { buildLiveFeedFromHq } from '../../domain/mailbox-live.js';
import { MessageRow } from './message-row.js';

/** Hard ceiling on rendered rows; the counter above the list reports the rest. */
const FEED_LIMIT = 500;

const MESSAGE_TYPES: readonly HqMailboxMessageType[] = [
  'ask',
  'assign',
  'steer',
  'review',
  'result',
  'status',
  'broadcast',
  'note',
  'btw',
  'control',
];

const PRIORITIES: readonly HqMailboxPriority[] = ['high', 'normal', 'low'];

function FilterSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
        {title}
      </div>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

export function LiveMailboxFeed({
  snapshot,
  events,
}: {
  snapshot: Pick<HqSnapshot, 'mailboxes'> | null;
  events: readonly HqEventEnvelope[];
}): React.ReactElement {
  const persisted = useHqLocalPrefs();
  const initialFilters = useMemo(() => {
    const mailbox = persisted.mailbox;
    return {
      types: new Set<HqMailboxMessageType>(mailbox.types as HqMailboxMessageType[]),
      priorities: new Set<HqMailboxPriority>(mailbox.priorities as HqMailboxPriority[]),
      projectIds: new Set<string>(),
      includeCompleted: mailbox.includeCompleted,
      query: mailbox.query,
    };
  }, [persisted.mailbox]);

  const [filters, dispatch] = useReducer(mailboxLiveFilterReducer, initialFilters);

  useEffect(() => {
    setHqMailboxPrefs({
      query: filters.query,
      types: [...filters.types],
      priorities: [...filters.priorities],
      includeCompleted: filters.includeCompleted,
    });
  }, [filters.query, filters.types, filters.priorities, filters.includeCompleted]);

  const projectOptions = useMemo(() => {
    const grouped = groupMailboxEvents(snapshot ?? null, events);
    return grouped.projects.map((project) => ({
      projectId: project.projectId,
      count: project.messages.length,
    }));
  }, [snapshot, events]);

  const feed = useMemo(
    () =>
      buildLiveFeedFromHq(snapshot ?? null, events, {
        types: [...filters.types],
        priorities: [...filters.priorities],
        projectIds: [...filters.projectIds],
        includeCompleted: filters.includeCompleted,
        query: filters.query || undefined,
        limit: FEED_LIMIT,
      }),
    [snapshot, events, filters],
  );

  const activeFilterCount =
    filters.types.size +
    filters.priorities.size +
    filters.projectIds.size +
    (filters.includeCompleted ? 0 : 1) +
    (filters.query.trim().length > 0 ? 1 : 0);

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-muted-foreground">
        Live mailbox feed · {feed.returned} of {feed.totalMatched} message
        {feed.totalMatched === 1 ? '' : 's'}
        {feed.truncated ? ' · refine to see the rest' : ''}
      </div>

      <Card className="space-y-3 p-3">
        <div className="space-y-1">
          <Label htmlFor="mailbox-live-query">Search</Label>
          <Input
            id="mailbox-live-query"
            value={filters.query}
            onChange={(event) => dispatch({ type: 'set-query', value: event.target.value })}
            placeholder="subject / sender / recipient / body…"
          />
        </div>

        <FilterSection title="Types">
          {MESSAGE_TYPES.map((type) => (
            <FilterChip
              key={type}
              label={type}
              selected={filters.types.has(type)}
              onClick={() => dispatch({ type: 'toggle-type', value: type })}
            />
          ))}
        </FilterSection>

        <FilterSection title="Priority">
          {PRIORITIES.map((priority) => (
            <FilterChip
              key={priority}
              label={priority}
              tone={priority === 'high' ? 'error' : priority === 'low' ? 'idle' : 'info'}
              selected={filters.priorities.has(priority)}
              onClick={() => dispatch({ type: 'toggle-priority', value: priority })}
            />
          ))}
        </FilterSection>

        {projectOptions.length > 0 && (
          <FilterSection title="Projects">
            {projectOptions.map((project) => (
              <FilterChip
                key={project.projectId}
                label={`${project.projectId} (${project.count})`}
                selected={filters.projectIds.has(project.projectId)}
                onClick={() => dispatch({ type: 'toggle-project', value: project.projectId })}
              />
            ))}
          </FilterSection>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 text-[11px]">
            <Checkbox
              id="mailbox-include-completed"
              checked={filters.includeCompleted}
              onCheckedChange={(checked) =>
                dispatch({ type: 'set-include-completed', value: checked === true })
              }
            />
            <label htmlFor="mailbox-include-completed">include completed</label>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={activeFilterCount === 0}
            onClick={() => dispatch({ type: 'clear-all' })}
            className="ml-auto"
          >
            Clear filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </Button>
        </div>
      </Card>

      {feed.entries.length === 0 ? (
        <EmptyState title="No mailbox activity matches the current filters" />
      ) : (
        <div data-testid="live-feed" className="space-y-1.5">
          {feed.entries.map((entry, index) => (
            <MessageRow
              key={entry.key}
              flat={entry.flat}
              // Auto-open the top hit of a search: the operator is looking for
              // content, not for a header line.
              defaultExpanded={index === 0 && filters.query.trim().length > 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}
