/**
 * SideEffectTimeline — audit trail of non-filesystem side effects
 * (bash commands, package installs, network requests) produced during
 * the current session.
 *
 * P2 #5 Phase 4 (WebUI): reads from the side-effect store and renders
 * a scrollable table with risk-level filter and sortable columns.
 * Auto-refreshes via the server's event-driven side_effects push.
 */

import {
  Activity,
  ChevronDown,
  ChevronUp,
  Download,
  Globe,
  Package,
  RefreshCw,
  Terminal,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { usePagination } from '@/hooks/usePagination';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { SideEffectEntry } from '@/stores';
import { useSessionStore, useSideEffectStore } from '@/stores';
import { Pagination } from './ui/pagination';

const RISK_ICONS: Record<string, typeof Terminal> = {
  shell: Terminal,
  package: Package,
  network: Globe,
  'fs.write': Activity,
  config: Activity,
};

const RISK_COLORS: Record<string, string> = {
  shell: 'text-warning',
  package: 'text-info',
  network: 'text-success',
  'fs.write': 'text-primary',
  config: 'text-muted-foreground',
};

const RISK_FILTERS = ['all', 'shell', 'package', 'network', 'fs.write', 'config'] as const;
type RiskFilter = (typeof RISK_FILTERS)[number];

type SortKey = 'time' | 'tool' | 'risk';
type SortDir = 'asc' | 'desc';

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return ts.slice(11, 19);
  }
}

function formatInput(se: SideEffectEntry): string {
  if (se.input['command']) return String(se.input['command']).slice(0, 80);
  if (se.input['url']) return String(se.input['url']).slice(0, 80);
  if (se.input['packages']) {
    const pkgs = se.input['packages'];
    return Array.isArray(pkgs) ? pkgs.join(', ').slice(0, 80) : String(pkgs).slice(0, 80);
  }
  return JSON.stringify(se.input).slice(0, 80);
}

/** Escape a value for CSV — wraps in quotes if it contains commas, quotes, or newlines. */
function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Build a CSV string from side effects and trigger a browser download. */
function exportCSV(entries: SideEffectEntry[]): void {
  const header = 'timestamp,tool,risk,detail,outcome';
  const rows = entries.map((se) => {
    const detail =
      se.input['command'] ?? se.input['url'] ?? se.input['packages'] ?? JSON.stringify(se.input);
    return [
      csvEscape(se.ts),
      csvEscape(se.toolName),
      csvEscape(se.risk),
      csvEscape(String(detail)),
      csvEscape(se.outcome ?? ''),
    ].join(',');
  });
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `side-effects-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function SideEffectTimeline() {
  const sideEffects = useSideEffectStore((s) => s.sideEffects);
  const loading = useSideEffectStore((s) => s.loading);
  const { t } = useAppTranslation();

  const [riskFilter, setRiskFilter] = useState<RiskFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('time');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // The request must NAME the session it is about. The server answers from
  // the named session's agent and stamps the reply with it, and the browser
  // files the reply by that stamp — unnamed, both ends fall back to the
  // runtime's session, which is a different tab from the one on screen as
  // often as not once four are open.
  const sessionId = useSessionStore((s) => s.session?.id);

  useEffect(() => {
    useSideEffectStore.getState().setLoading(true);
    import('@/lib/ws-client').then(({ getWSClient }) => {
      getWSClient().send({
        type: 'side_effects.list',
        ...(sessionId ? { payload: { sessionId } } : {}),
      });
    });
  }, [sessionId]);

  const refresh = () => {
    useSideEffectStore.getState().setLoading(true);
    import('@/lib/ws-client').then(({ getWSClient }) => {
      getWSClient().send({
        type: 'side_effects.list',
        ...(sessionId ? { payload: { sessionId } } : {}),
      });
    });
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'time' ? 'desc' : 'asc');
    }
  };

  const filtered = useMemo(() => {
    const result =
      riskFilter === 'all' ? [...sideEffects] : sideEffects.filter((se) => se.risk === riskFilter);

    result.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'time') cmp = a.ts.localeCompare(b.ts);
      else if (sortKey === 'tool') cmp = a.toolName.localeCompare(b.toolName);
      else if (sortKey === 'risk') cmp = a.risk.localeCompare(b.risk);
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return result;
  }, [sideEffects, riskFilter, sortKey, sortDir]);
  const effectPage = usePagination(filtered, 20, `${riskFilter}:${sortKey}:${sortDir}`);

  if (sideEffects.length === 0 && !loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-muted-foreground">
        <Activity className="h-8 w-8 opacity-40" />
        <p className="text-sm">{t('activity:sideEffects.empty')}</p>
        <p className="text-xs text-muted-foreground/75">{t('activity:sideEffects.emptyHint')}</p>
      </div>
    );
  }

  const SortIcon = ({ column }: { column: SortKey }) => {
    if (sortKey !== column) return <span className="opacity-30">↕</span>;
    return sortDir === 'asc' ? (
      <ChevronUp className="inline h-3 w-3" />
    ) : (
      <ChevronDown className="inline h-3 w-3" />
    );
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* Header: title + refresh */}
      <div className="flex items-center justify-between border-b border-border/70 bg-card/70 px-3 py-2">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground">
          {t('activity:sideEffects.heading')} ({filtered.length}
          {riskFilter !== 'all' ? `/${sideEffects.length}` : ''})
        </h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => exportCSV(filtered)}
            disabled={filtered.length === 0}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
            title={t('activity:sideEffects.exportTitle')}
          >
            <Download className="h-3 w-3" />
            CSV
          </button>
          <button
            type="button"
            onClick={refresh}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
            {t('common:action.refresh')}
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-1 border-b border-border/60 bg-muted/20 px-2 py-1">
        {RISK_FILTERS.map((risk) => (
          <button
            type="button"
            key={risk}
            onClick={() => setRiskFilter(risk)}
            className={cn(
              'rounded-md px-2 py-0.5 text-[10px] font-medium uppercase transition-colors',
              riskFilter === risk
                ? 'bg-primary/10 text-primary ring-1 ring-primary/20'
                : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
            )}
          >
            {risk === 'all' ? t('activity:sideEffects.all') : risk}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card/95 text-muted-foreground backdrop-blur">
            <tr>
              <th
                className="cursor-pointer select-none px-2 py-1 text-left font-medium hover:text-foreground"
                onClick={() => toggleSort('time')}
              >
                {t('activity:sideEffects.colTime')} <SortIcon column="time" />
              </th>
              <th
                className="cursor-pointer select-none px-2 py-1 text-left font-medium hover:text-foreground"
                onClick={() => toggleSort('tool')}
              >
                {t('activity:sideEffects.colTool')} <SortIcon column="tool" />
              </th>
              <th
                className="cursor-pointer select-none px-2 py-1 text-left font-medium hover:text-foreground"
                onClick={() => toggleSort('risk')}
              >
                {t('activity:sideEffects.colRisk')} <SortIcon column="risk" />
              </th>
              <th className="px-2 py-1 text-left font-medium">
                {t('activity:sideEffects.colDetail')}
              </th>
              <th className="px-2 py-1 text-left font-medium">
                {t('activity:sideEffects.colOutcome')}
              </th>
            </tr>
          </thead>
          <tbody>
            {effectPage.pageItems.map((se, i) => {
              const Icon = RISK_ICONS[se.risk] ?? Activity;
              const colorClass = RISK_COLORS[se.risk] ?? 'text-muted-foreground';
              return (
                <tr
                  key={`${se.toolUseId}-${i}`}
                  className="border-b border-border/45 hover:bg-muted/45"
                >
                  <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                    {formatTime(se.ts)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 font-medium text-foreground">
                    {se.toolName}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <span className={cn('flex items-center gap-1', colorClass)}>
                      <Icon className="h-3 w-3" />
                      {se.risk}
                    </span>
                  </td>
                  <td className="max-w-xs truncate px-2 py-1.5 font-mono text-muted-foreground">
                    {formatInput(se)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                    {se.outcome ?? ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pagination
        page={effectPage.page}
        pageSize={effectPage.pageSize}
        totalItems={effectPage.totalItems}
        onPageChange={effectPage.setPage}
        itemLabel="side effects"
      />
    </div>
  );
}
