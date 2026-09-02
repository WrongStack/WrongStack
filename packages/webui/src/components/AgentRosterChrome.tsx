import { Library, Loader2, RefreshCw } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { CustomRosterStats, RosterTab } from './agent-roster-data';
import { TABS } from './agent-roster-data';

export function AgentRosterHeader({
  customStats,
  rosterLoading,
  onRefresh,
}: {
  customStats: CustomRosterStats[];
  rosterLoading: boolean;
  onRefresh: () => void;
}) {
  const { t } = useAppTranslation();
  return (
    <div className="shrink-0 border-b border-border/70 bg-card/80 px-4 py-2.5">
      <div className="flex items-center justify-between gap-2 flex-nowrap min-w-0">
        <div className="flex items-center gap-3 min-w-0 overflow-hidden">
          <div className="flex items-center justify-center w-8 h-8 shrink-0 rounded-lg bg-primary/10">
            <Library className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0 overflow-hidden">
            <h1 className="text-sm font-semibold truncate">{t('activity:agentRoster.heading')}</h1>
            <p className="text-[10px] text-muted-foreground truncate">
              {t('activity:agentRoster.headerSummary', {
                customized: customStats.filter(
                  (s) => s.exists || s.hasIdentity || s.hasConfig || s.hasKnowledge,
                ).length,
                entries: customStats.reduce((sum, s) => sum + s.entryCount, 0),
              })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {rosterLoading && (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
          )}
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1 rounded border border-border/50 px-2 py-1 text-[10px] hover:bg-accent transition-colors shrink-0 whitespace-nowrap"
            title={t('activity:agentRoster.refreshRosterData')}
          >
            <RefreshCw className="h-3 w-3" /> {t('common:action.refresh')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AgentRosterTabs({
  activeTab,
  onTabChange,
}: {
  activeTab: RosterTab;
  onTabChange: (tab: RosterTab) => void;
}) {
  const { t } = useAppTranslation();
  return (
    <div className="shrink-0 border-b border-border/50 bg-muted/20 px-3 flex gap-0">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onTabChange(tab.id)}
          className={cn(
            'flex items-center gap-1.5 px-3 py-2 text-[10px] font-medium border-b-2 transition-colors',
            activeTab === tab.id
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30',
          )}
        >
          {tab.icon}
          {t(tab.labelKey)}
        </button>
      ))}
    </div>
  );
}
