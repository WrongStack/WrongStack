import { Activity as ActivityIcon, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FileActivity } from '@/stores/codemap-activity-store';
import { useAppTranslation } from '@/i18n';

interface CodeMapActivityDrawerProps {
  historyFile: string;
  fileHistory: FileActivity[];
  onClose: () => void;
}

export function CodeMapActivityDrawer({
  historyFile,
  fileHistory,
  onClose,
}: CodeMapActivityDrawerProps): React.ReactElement {
  const { t } = useAppTranslation();
  return (
    <div className="absolute right-0 top-0 z-50 flex h-full w-[390px] max-w-[90%] flex-col border-l bg-card shadow-2xl">
      <div className="flex h-12 items-center justify-between border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <ActivityIcon className="h-4 w-4 shrink-0 text-warning" />
          <span className="truncate font-mono text-[11px] font-semibold" title={historyFile}>
            {historyFile}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center border text-muted-foreground hover:bg-muted"
          aria-label={t('activity:codeMap.closeActivity')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {fileHistory.length === 0 ? (
          <p className="py-12 text-center text-[10px] text-muted-foreground">
            {t('activity:codeMap.noActivityRecordedForThisFile')}
          </p>
        ) : (
          fileHistory.map((activity, index) => (
            <div
              key={`${activity.timestamp}-${index}`}
              className="mb-1 flex items-start gap-2 border p-2 text-[10px]"
            >
              <span
                className={cn(
                  'border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase',
                  activity.type === 'delete'
                    ? 'border-destructive/40 text-destructive'
                    : activity.type === 'read'
                      ? 'border-info/40 text-info'
                      : 'border-warning/40 text-warning',
                )}
              >
                {activity.type}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[9px] text-muted-foreground">
                  {new Date(activity.timestamp).toLocaleTimeString()}
                </div>
                {activity.toolName && <div className="mt-1">via {activity.toolName}</div>}
                {activity.agent && <div className="text-muted-foreground">{activity.agent}</div>}
                {activity.summary && (
                  <div className="mt-1 text-muted-foreground">{activity.summary}</div>
                )}
                {activity.change && (
                  <div className="mt-1 flex items-center gap-1 font-mono text-[8px]">
                    <span className="border border-success/40 bg-success/10 px-1 text-success">
                      +{activity.change.added}
                    </span>
                    <span className="border border-destructive/40 bg-destructive/10 px-1 text-destructive">
                      −{activity.change.removed}
                    </span>
                    {activity.change.before && (
                      <span
                        className="ml-1 truncate text-destructive/80"
                        title={activity.change.before}
                      >
                        {activity.change.before}
                      </span>
                    )}
                    {activity.change.after && (
                      <span className="truncate text-success/80" title={activity.change.after}>
                        → {activity.change.after}
                      </span>
                    )}
                  </div>
                )}
                <div className="mt-1 flex gap-2 font-mono text-[8px] uppercase text-muted-foreground">
                  <span>{activity.status ?? 'observed'}</span>
                  <span>{activity.source ?? 'legacy'}</span>
                  {activity.durationMs !== undefined && <span>{activity.durationMs}ms</span>}
                  {activity.watcherConfirmed && (
                    <span className="text-success">{t('activity:codeMap.fsVerified')}</span>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="border-t px-4 py-2 font-mono text-[9px] text-muted-foreground">
        {fileHistory.length} events · newest first
      </div>
    </div>
  );
}
