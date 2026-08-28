import { Activity as ActivityIcon, GitBranch, Radio } from 'lucide-react';
import type { FileActivity } from '@/stores/codemap-activity-store';
import { LiveOperationRow } from './CodeMapLiveOverlay';
import { useAppTranslation } from '@/i18n';

type CodeMapActivityStreamPanelProps = {
  activeOperations: FileActivity[];
  recentActivities: FileActivity[];
  activityTotalCount: number;
  onLocate: (activity: FileActivity) => void;
};

export function CodeMapActivityStreamPanel({
  activeOperations,
  recentActivities,
  activityTotalCount,
  onLocate,
}: CodeMapActivityStreamPanelProps) {
  const { t } = useAppTranslation();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {activeOperations.length > 0 && (
        <section className="border-b">
          <div className="flex h-9 items-center gap-2 border-b bg-success/5 px-3">
            <Radio className="h-3 w-3 animate-pulse text-success" />
            <h3 className="text-[9px] font-bold uppercase tracking-[0.16em]">{t('activity:codeMap.activeNow')}</h3>
            <span className="ml-auto font-mono text-[9px] text-success">
              {activeOperations.length}
            </span>
          </div>
          {activeOperations.map((activity) => (
            <LiveOperationRow
              key={activity.id ?? `${activity.toolUseId}:${activity.filePath}`}
              activity={activity}
              onLocate={onLocate}
              showAgent
            />
          ))}
        </section>
      )}
      <section>
        <div className="flex h-9 items-center gap-2 border-b px-3">
          <ActivityIcon className="h-3 w-3 text-muted-foreground" />
          <h3 className="text-[9px] font-bold uppercase tracking-[0.16em]">{t('activity:codeMap.eventStream')}</h3>
          <span className="ml-auto font-mono text-[8px] text-muted-foreground">
            {activityTotalCount} total
          </span>
        </div>
        {recentActivities.length > 0 ? (
          recentActivities.map((activity, index) => (
            <LiveOperationRow
              key={activity.id ?? `${activity.timestamp}:${index}`}
              activity={activity}
              onLocate={onLocate}
              showAgent
            />
          ))
        ) : (
          <div className="flex flex-col items-center justify-center px-7 py-16 text-center">
            <span className="mb-4 flex h-12 w-12 items-center justify-center border bg-muted text-muted-foreground">
              <GitBranch className="h-5 w-5" />
            </span>
            <h3 className="text-xs font-semibold">{t('activity:codeMap.selectANodeOrWaitFor')}</h3>
            <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
              {t('activity:codeMap.relationsAppearOnSelectionToolCalls')}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
