/**
 * Command audit rail — the queued → delivered → acked lifecycle of everything
 * HQ has dispatched.
 *
 * Rows for other clients are dimmed rather than hidden: an operator switching
 * targets still needs to see that a command they sent a minute ago is stuck.
 */
import type { HqCommandAuditEntry } from '@wrongstack/core/hq';
import type * as React from 'react';
import { EmptyState, Mono } from '../../components/hq/primitives.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { relativeTime, shortId } from '../../domain/control-format.js';
import { commandAckTone, commandAuditTone } from '../../domain/status-tone.js';
import { cn } from '../../lib/utils.js';

function MetaItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span>
      <strong className="font-medium text-foreground">{label}</strong> {children}
    </span>
  );
}

export function CommandAuditRail({
  entries,
  loading,
  error,
  selectedClientId,
  highlightCommandId,
  onRefresh,
}: {
  entries: readonly HqCommandAuditEntry[];
  loading: boolean;
  error: string | null;
  selectedClientId: string | null;
  /** The most recent dispatch — highlighted so the eye lands on it. */
  highlightCommandId: string | null;
  onRefresh: () => void;
}): React.ReactElement {
  return (
    <Card data-testid="command-audit" className="min-w-0">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        <span className="font-display text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
          Command audit
        </span>
        <Badge tone="info">recent {entries.length}</Badge>
        {loading && <Badge tone="idle">refreshing</Badge>}
        {error !== null && <Badge tone="error">{error}</Badge>}
        <Button variant="outline" size="sm" onClick={onRefresh} className="ml-auto">
          Refresh
        </Button>
      </div>

      {entries.length === 0 ? (
        <EmptyState title="No command audit entries yet" className="m-3" />
      ) : (
        <div className="divide-y divide-border">
          {entries.map((entry) => {
            const isOtherClient = selectedClientId !== null && entry.clientId !== selectedClientId;
            return (
              <div
                key={entry.commandId}
                data-testid="audit-row"
                data-highlighted={entry.commandId === highlightCommandId}
                className={cn(
                  'space-y-1 px-3 py-2',
                  isOtherClient && 'opacity-55',
                  entry.commandId === highlightCommandId && 'bg-accent/50',
                )}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={commandAuditTone(entry)}>{entry.status}</Badge>
                  <Badge tone="info">{entry.type}</Badge>
                  <Mono>{shortId(entry.commandId)}</Mono>
                  {entry.ackStatus !== undefined && (
                    <Badge tone={commandAckTone(entry.ackStatus)}>ack {entry.ackStatus}</Badge>
                  )}
                </div>

                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                  <MetaItem label="client">{shortId(entry.clientId)}</MetaItem>
                  <MetaItem label="by">{entry.enqueuedBy}</MetaItem>
                  <MetaItem label="queued">{relativeTime(entry.enqueuedAt)}</MetaItem>
                  {entry.ackedAt !== undefined && (
                    <MetaItem label="acked">{relativeTime(entry.ackedAt)}</MetaItem>
                  )}
                </div>

                {entry.ackMessage !== undefined && entry.ackMessage.length > 0 && (
                  <p className="font-mono text-[11px] text-muted-foreground">{entry.ackMessage}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
