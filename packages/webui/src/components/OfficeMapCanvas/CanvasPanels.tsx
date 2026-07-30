import { MiniMap, Panel } from '@xyflow/react';
import { Bot, LayoutGrid, ScrollText, Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SessionWatchPanel } from '../SessionWatchPanel';
import { OFFICE_COLOR } from './nodes.js';
import type { OfficeNodeData } from './utils.js';

export function OfficeToolbar({
  broadcastOpen,
  labels,
  onArrange,
  onBroadcastToggle,
  onFeedToggle,
  showFeed,
}: {
  broadcastOpen: boolean;
  labels: {
    arrange: string;
    arrangeTitle: string;
    broadcast: string;
    broadcastTitle: string;
    feed: string;
    feedTitle: string;
  };
  onArrange: () => void;
  onBroadcastToggle: () => void;
  onFeedToggle: () => void;
  showFeed: boolean;
}) {
  return (
    <Panel position="top-right" className="flex items-center gap-2">
      <button
        type="button"
        onClick={onArrange}
        title={labels.arrangeTitle}
        className="flex items-center gap-1.5 rounded-md border border-border/70 bg-card/90 px-2.5 py-1.5 text-xs text-foreground shadow-sm transition-colors hover:bg-accent"
      >
        <LayoutGrid className="h-3.5 w-3.5" />
        {labels.arrange}
      </button>
      <button
        type="button"
        onClick={onFeedToggle}
        title={labels.feedTitle}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs transition-colors',
          showFeed
            ? 'border-primary/35 bg-primary/10 text-primary'
            : 'border-border/70 bg-card/90 text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <ScrollText className="h-3.5 w-3.5" />
        {labels.feed}
      </button>
      <button
        type="button"
        onClick={onBroadcastToggle}
        title={labels.broadcastTitle}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs transition-colors',
          broadcastOpen
            ? 'border-warning/35 bg-warning/10 text-warning'
            : 'border-border/70 bg-card/90 text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <Send className="h-3.5 w-3.5" />
        {labels.broadcast}
      </button>
    </Panel>
  );
}

export function OfficeMiniMap() {
  return (
    <MiniMap
      className="rounded-lg border border-border/70 bg-card/90"
      nodeColor={(n) => {
        const data = n.data as OfficeNodeData;
        switch (data.kind) {
          case 'coordinator':
            return OFFICE_COLOR.primary;
          case 'webui':
            return OFFICE_COLOR.info;
          case 'tui':
            return OFFICE_COLOR.success;
          case 'repl':
          case 'mailbox':
            return OFFICE_COLOR.warning;
          default:
            return OFFICE_COLOR.primary;
        }
      }}
      maskColor="hsl(var(--background) / 0.72)"
    />
  );
}

export function SessionWatchDrawer({
  closeTitle,
  label,
  onClose,
  sessionId,
  streamTitle,
}: {
  closeTitle: string;
  label: string;
  onClose: () => void;
  sessionId: string;
  streamTitle: string;
}) {
  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-[min(680px,92%)] flex-col border-l border-border bg-background shadow-2xl">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5 shrink-0 bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <Bot className="h-4 w-4 text-primary shrink-0" />
          <div className="min-w-0">
            <div className="truncate text-sm font-bold text-foreground">{label}</div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {streamTitle}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          title={closeTitle}
          className="text-muted-foreground hover:text-foreground text-xl leading-none shrink-0"
        >
          ×
        </button>
      </div>
      <div className="flex-1 min-h-0 p-4">
        <SessionWatchPanel sessionId={sessionId} limit={500} />
      </div>
    </div>
  );
}
