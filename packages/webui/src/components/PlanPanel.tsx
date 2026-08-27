import { CheckCircle2, Circle, Clock } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useActiveSessionId } from '@/stores';

interface PlanItem {
  id: string;
  title: string;
  details?: string | undefined;
  status: 'open' | 'in_progress' | 'done';
}

const STATUS_CONFIG: Record<
  PlanItem['status'],
  { icon: React.ReactNode; labelKey: string; color: string }
> = {
  open: {
    icon: <Circle className="w-3.5 h-3.5" />,
    labelKey: 'statusOpen',
    color: 'text-muted-foreground/70',
  },
  in_progress: {
    icon: <Clock className="w-3.5 h-3.5 animate-spin" />,
    labelKey: 'statusInProgress',
    color: 'text-warning',
  },
  done: {
    icon: <CheckCircle2 className="w-3.5 h-3.5" />,
    labelKey: 'statusDone',
    color: 'text-success',
  },
};

/**
 * Live plan board panel. Connects via WebSocket, requests the current
 * plan snapshot, and stays in sync via `plan.updated` events.
 *
 * **Interactive**: Each plan item has hover quick-actions:
 * - **Start** (open → in_progress)
 * - **Done** (in_progress/open → done)
 * - **Reopen** (done → open)
 *
 * Sections: In Progress → Open → Done, each collapsible.
 * Auto-hides when the plan is empty.
 */
export function PlanPanel(): React.ReactElement | null {
  const { t } = useAppTranslation();
  const [items, setItems] = useState<PlanItem[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const ws = getWSClient();
  // The plan board belongs to the tab in front. Reading the lane pointer (not
  // `session?.id`, which is null until the resumed tab's `session.start`
  // lands) means the refetch below fires the moment the switch happens.
  const sessionId = useActiveSessionId();

  useEffect(() => {
    // Drop the previous tab's items immediately so a slow `plan.get` round
    // trip cannot briefly render one tab's plan under another tab's name.
    setItems([]);
    ws.getPlan();
    const off = ws.on('plan.updated', (msg: unknown) => {
      const payload = (msg as { payload?: { sessionId?: string; plan?: { items?: PlanItem[] } } })
        ?.payload;
      // The server stamps every worklist frame with the session it served.
      // Untagged frames (older server, embedded host) stay compatible.
      if (payload?.sessionId && sessionId && payload.sessionId !== sessionId) return;
      if (payload?.plan?.items) setItems(payload.plan.items);
    });
    return () => {
      off();
    };
  }, [sessionId, ws]);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleStatusChange = useCallback(
    (item: PlanItem, status: PlanItem['status']) => {
      // Use the item's id as the target — server resolves by id, index, or title match
      ws.updatePlanItem(item.id, status);
    },
    [ws],
  );

  const statusOrder: PlanItem['status'][] = ['in_progress', 'open', 'done'];
  const sortedItems = [...items].sort(
    (a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status),
  );
  // Plan items are bounded (per session), show all without pagination.
  const grouped = new Map<PlanItem['status'], PlanItem[]>();
  for (const it of sortedItems) {
    const list = grouped.get(it.status) ?? [];
    list.push(it);
    grouped.set(it.status, list);
  }

  const done = items.filter((item) => item.status === 'done').length;
  if (items.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card/50 backdrop-blur-sm overflow-hidden">
      <div className="px-3 py-1.5 flex items-center gap-2 border-b border-border/50">
        <h2 className="text-[11px] font-semibold text-foreground uppercase tracking-wider">
          📋 {t('activity:work.plan')}
        </h2>
        <span className="tabular text-[10px] text-muted-foreground ml-auto">
          {done}/{items.length}
        </span>
      </div>

      {statusOrder.map((status) => {
        const group = grouped.get(status);
        if (!group || group.length === 0) return null;
        const cfg = STATUS_CONFIG[status];
        const isCollapsed = collapsed.has(status);

        return (
          <div key={status} className="border-b border-border/30 last:border-b-0">
            <button
              type="button"
              onClick={() => toggle(status)}
              className="w-full px-3 py-1 flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <span className="tabular">
                {isCollapsed ? '▶' : '▼'} {group.length} {t(`activity:plan.${cfg.labelKey}`)}
              </span>
            </button>
            {!isCollapsed &&
              group.map((it) => (
                <div
                  key={it.id}
                  className={cn(
                    'px-3 py-1.5 flex items-start gap-2 text-[13px] group',
                    it.status === 'in_progress' ? 'bg-warning/8' : '',
                  )}
                >
                  <span className={cn('mt-0.5 shrink-0', cfg.color)}>{cfg.icon}</span>
                  <span
                    className={cn(
                      'leading-snug flex-1 min-w-0',
                      it.status === 'done'
                        ? 'text-muted-foreground line-through'
                        : 'text-foreground/80',
                    )}
                  >
                    {it.title}
                  </span>

                  {/* Quick Actions */}
                  <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    {it.status === 'open' && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStatusChange(it, 'in_progress');
                        }}
                        className="px-1.5 py-0.5 text-[9px] rounded bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
                        title={t('activity:plan.startTitle')}
                      >
                        {t('common:action.start')}
                      </button>
                    )}
                    {it.status !== 'done' && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStatusChange(it, 'done');
                        }}
                        className="px-1.5 py-0.5 text-[9px] rounded bg-success/15 text-success hover:bg-success/25 transition-colors"
                        title={t('activity:plan.doneTitle')}
                      >
                        {t('activity:plan.statusDone')}
                      </button>
                    )}
                    {it.status === 'done' && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStatusChange(it, 'open');
                        }}
                        className="px-1.5 py-0.5 text-[9px] rounded bg-muted text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                        title={t('activity:plan.reopenTitle')}
                      >
                        {t('activity:plan.reopen')}
                      </button>
                    )}
                  </div>
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}
