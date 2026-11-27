import { Database, FileText, RefreshCw } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ProjectAgentLearnStats } from './custom-roster-types';

/** Sidebar of customized roles with their identity / entry / capture markers. */
export function CustomRosterRoleList({
  roles,
  selectedRole,
  setSelectedRole,
  onRefresh,
}: {
  roles: ProjectAgentLearnStats[];
  selectedRole: string | null;
  setSelectedRole: (role: string) => void;
  onRefresh: () => void;
}) {
  const { t } = useAppTranslation();
  return (
    <div className="w-64 border-r border-line shrink-0 overflow-y-auto">
      <div className="p-3 border-b border-line flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t('activity:customRoster.heading')}</h2>
        <button
          type="button"
          onClick={onRefresh}
          aria-label={t('common:action.refresh')}
          className="p-1 hover:bg-accent rounded"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
      {roles.map((r) => (
        <button
          key={r.role}
          type="button"
          onClick={() => setSelectedRole(r.role)}
          className={cn(
            'w-full text-left px-3 py-2 text-xs border-b border-line/50 hover:bg-accent/50 transition-colors',
            selectedRole === r.role && 'bg-primary/10 border-l-2 border-l-primary',
          )}
        >
          <div className="flex items-center justify-between">
            <span className="font-medium">{r.role}</span>
            <span className="text-[10px] text-muted-foreground">{r.totalBytes}B</span>
          </div>
          <div className="flex gap-2 text-[10px] text-muted-foreground mt-0.5">
            {r.hasIdentity && (
              <span className="flex items-center gap-0.5">
                <FileText className="h-3 w-3" />
                id
              </span>
            )}
            {r.entryCount > 0 && (
              <span className="flex items-center gap-0.5">
                <Database className="h-3 w-3" />
                {r.entryCount}e
              </span>
            )}
            {r.needsSummarization && <span className="text-warning">⚠</span>}
            {r.sessionCaptureCount > 0 && (
              <span className="text-brand-2">+{r.sessionCaptureCount}</span>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}

/** Entry count, size, last capture and session captures of the selected role. */
export function CustomRosterStatsBar({ stats }: { stats: ProjectAgentLearnStats }) {
  const { t } = useAppTranslation();
  return (
    <div className="grid grid-cols-4 gap-3 text-xs">
      <div className="bg-card rounded-lg p-2 border border-line">
        <div className="text-muted-foreground">{t('activity:customRoster.entries')}</div>
        <div className="text-lg font-semibold">{stats.entryCount}</div>
      </div>
      <div className="bg-card rounded-lg p-2 border border-line">
        <div className="text-muted-foreground">{t('activity:customRoster.size')}</div>
        <div className="text-lg font-semibold">{stats.totalBytes}B</div>
      </div>
      <div className="bg-card rounded-lg p-2 border border-line">
        <div className="text-muted-foreground">{t('activity:agentRoster.lastCapture')}</div>
        <div className="text-lg font-semibold">
          {stats.lastCapture ? new Date(stats.lastCapture).toLocaleDateString() : '—'}
        </div>
      </div>
      <div className="bg-card rounded-lg p-2 border border-line">
        <div className="text-muted-foreground">{t('activity:customRoster.sessionCaptures')}</div>
        <div className="text-lg font-semibold">{stats.sessionCaptureCount}/3</div>
      </div>
    </div>
  );
}
