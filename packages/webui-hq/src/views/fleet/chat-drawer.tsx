/**
 * Instant chat over the topology canvas.
 *
 * Same transcript pipeline as the full Console (`useSessionTranscript`), so
 * clicking a node never means leaving the map to see what an agent is doing.
 *
 * `aria-modal="false"` on purpose: the map stays interactive behind the panel
 * — this is a peek, not a modal. Focus is moved to the close button and
 * restored on unmount, and Escape closes.
 */
import { ArrowDownToLine, Bot, ExternalLink, SquareTerminal, X } from 'lucide-react';
import type * as React from 'react';
import { useEffect, useId, useRef } from 'react';
import { VList } from 'virtua';
import { EmptyState } from '../../components/hq/primitives.js';
import { TranscriptTurn } from '../../components/hq/transcript/turn.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { useHqStore } from '../../data/store/index.js';
import type { FleetChatTarget } from '../../domain/fleet-chat-target.js';
import { activityTone } from '../../domain/status-tone.js';
import { turnKey, useSessionTranscript } from '../../domain/use-session-transcript.js';

export function FleetChatDrawer({
  target,
  onClose,
}: {
  target: FleetChatTarget;
  onClose: () => void;
}): React.ReactElement {
  const chat = useSessionTranscript(target.sessionId, target.agentId);
  const { entries } = chat;
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (previousFocus?.isConnected === true) previousFocus.focus({ preventScroll: true });
    };
  }, [onClose]);

  return (
    <div data-testid="hq-fleet-chat-drawer" className="absolute inset-0 z-20 flex justify-end">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close fleet transcript"
        onClick={onClose}
        className="absolute inset-0 bg-background/50"
      />
      <aside
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        className="relative flex h-full w-full max-w-lg flex-col border-l border-border bg-card shadow-xl"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          {target.agentId !== null ? (
            <Bot className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span
            id={titleId}
            title={target.label}
            className="min-w-0 flex-1 truncate text-xs font-medium"
          >
            {target.label}
          </span>
          {target.status !== undefined && (
            <Badge tone={activityTone(target.status)}>{target.status}</Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            title="Open this conversation in the full Console"
            onClick={() => {
              onClose();
              useHqStore.getState().setActiveView('console');
            }}
          >
            <ExternalLink />
            Console
          </Button>
          <Button
            ref={closeButtonRef}
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close fleet transcript"
            title="Close (Esc)"
          >
            <X className="size-3.5" />
          </Button>
        </div>

        <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-border px-3 py-1.5">
          <Badge tone="neutral">{chat.stats.turns} turns</Badge>
          <Badge tone="neutral">{chat.stats.tools} tools</Badge>
          {chat.stats.running > 0 && <Badge tone="running">{chat.stats.running} running</Badge>}
          {chat.stats.errors > 0 && <Badge tone="error">{chat.stats.errors} err</Badge>}
          {chat.meta.source !== undefined && (
            <Badge
              tone="idle"
              title={
                chat.meta.source === 'disk'
                  ? 'full history replayed from this machine'
                  : 'live ring only (remote, or not yet persisted)'
              }
            >
              {chat.meta.source === 'disk' ? 'full history' : 'live ring'}
            </Badge>
          )}
        </div>

        <div className="relative min-h-0 flex-1">
          {chat.loading && entries.length === 0 ? (
            <p className="p-4 text-xs text-muted-foreground">Loading transcript…</p>
          ) : chat.error !== null ? (
            <EmptyState title="Could not load transcript" hint={chat.error} className="m-4" />
          ) : entries.length === 0 ? (
            <EmptyState
              title={
                target.agentId !== null
                  ? `No messages from ${target.label} yet`
                  : 'No transcript entries yet'
              }
              className="m-4"
            />
          ) : (
            <VList ref={chat.listRef} onScroll={chat.onScroll} className="h-full px-2 py-2">
              {entries.map((entry, index) => (
                <div key={turnKey(entry, index)} className="pb-1.5">
                  <TranscriptTurn entry={entry} running={chat.isRunningAt(entry, index)} />
                </div>
              ))}
            </VList>
          )}

          {!chat.pinned && entries.length > 0 && (
            <Button
              size="icon"
              onClick={chat.jumpToLatest}
              title="Jump to latest"
              aria-label="Jump to latest"
              className="absolute bottom-3 right-3 shadow-lg"
            >
              <ArrowDownToLine />
            </Button>
          )}
        </div>
      </aside>
    </div>
  );
}
