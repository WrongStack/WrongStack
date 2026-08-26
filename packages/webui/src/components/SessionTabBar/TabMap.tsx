/**
 * TabMap — the answer to "which tab is which".
 *
 * Four cards, one per slot, laid out side by side: the session in it, the model
 * it runs, whether it is working, how much of its context is spent, what it has
 * queued, and which subagents belong to it. It is a READ of the lane
 * registries, so what it shows is, by construction, what that tab holds — the
 * map cannot disagree with the territory because there is only one copy.
 *
 * Empty slots are drawn too. Seeing "slot 4 — empty" is the point: the ceiling
 * is four and the map shows all four.
 */

import { Bot, CircleDot, Loader2, MessageSquare, Plus, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MAX_OPEN_TABS, type TabSummary } from '@/stores/session-tab-store';
import { formatTokens, slotAccent } from './summaries';

export function TabMap({
  tabs,
  onSelect,
  onNew,
}: {
  tabs: TabSummary[];
  onSelect: (sessionId: string) => void;
  onNew: () => void;
}) {
  const slots = Array.from({ length: MAX_OPEN_TABS }, (_, i) => tabs[i] ?? null);

  return (
    <div className="w-[min(92vw,760px)] p-2">
      <div className="px-1 pb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        Tab map — {tabs.length}/{MAX_OPEN_TABS} slots · one session per tab, nothing shared
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {slots.map((tab, slot) =>
          tab ? (
            <TabCard key={tab.sessionId} tab={tab} onSelect={onSelect} />
          ) : (
            <EmptySlot key={`empty-${slot}`} slot={slot} onNew={onNew} />
          ),
        )}
      </div>
    </div>
  );
}

function TabCard({ tab, onSelect }: { tab: TabSummary; onSelect: (id: string) => void }) {
  const accent = slotAccent(tab.slot);
  return (
    <button
      type="button"
      onClick={() => onSelect(tab.sessionId)}
      className={cn(
        'group flex w-full flex-col gap-1.5 rounded-md border p-2.5 text-left transition-colors',
        tab.isActive
          ? cn('border-border/80 bg-background shadow-xs', accent.border)
          : 'border-border/40 bg-muted/20 hover:bg-muted/40',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold',
            accent.soft,
            accent.text,
          )}
        >
          {tab.slot + 1}
        </span>
        <span className="truncate text-xs font-medium">{tab.title}</span>
        {tab.isActive && (
          <span className={cn('shrink-0 text-[9px] font-semibold uppercase', accent.text)}>
            on screen
          </span>
        )}
        <span className="ml-auto shrink-0">
          {tab.needsAttention ? (
            <TriangleAlert className="h-3.5 w-3.5 text-warning" />
          ) : tab.isRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          ) : (
            <CircleDot className="h-3.5 w-3.5 text-muted-foreground/50" />
          )}
        </span>
      </div>

      <div className="truncate font-mono text-[10px] text-muted-foreground">
        {tab.provider || '—'} / {tab.model || '—'} · {tab.mode}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <Stat icon={<MessageSquare className="h-3 w-3" />} label={`${tab.messageCount} msg`} />
        {tab.unread > 0 && (
          <span className="rounded bg-primary/15 px-1 font-semibold text-primary">
            +{tab.unread} new
          </span>
        )}
        {tab.queued > 0 && <span>{tab.queued} queued</span>}
        <Stat
          icon={<Bot className="h-3 w-3" />}
          label={
            tab.agentsTotal === 0 ? 'no agents' : `${tab.agentsRunning}/${tab.agentsTotal} agents`
          }
          tone={tab.agentsRunning > 0 ? 'text-success' : undefined}
        />
        {tab.tokens > 0 && <span>{formatTokens(tab.tokens)} tok</span>}
        {tab.cost > 0 && <span>${tab.cost.toFixed(4)}</span>}
        {tab.contextPct > 0 && <span>{tab.contextPct}% ctx</span>}
      </div>

      <div className="truncate font-mono text-[9px] text-muted-foreground/60">{tab.sessionId}</div>
    </button>
  );
}

function Stat({
  icon,
  label,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  tone?: string | undefined;
}) {
  return (
    <span className={cn('inline-flex items-center gap-1', tone)}>
      {icon}
      {label}
    </span>
  );
}

function EmptySlot({ slot, onNew }: { slot: number; onNew: () => void }) {
  const accent = slotAccent(slot);
  return (
    <button
      type="button"
      onClick={onNew}
      className="flex w-full items-center gap-2 rounded-md border border-dashed border-border/50 p-2.5 text-left text-muted-foreground transition-colors hover:border-border hover:text-foreground"
    >
      <span
        className={cn(
          'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold opacity-50',
          accent.soft,
          accent.text,
        )}
      >
        {slot + 1}
      </span>
      <span className="text-xs">Empty slot</span>
      <Plus className="ml-auto h-3.5 w-3.5" />
    </button>
  );
}
