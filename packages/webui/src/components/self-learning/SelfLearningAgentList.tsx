import { Database, Loader2, Zap } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { CustomRosterStats } from '../agent-roster-data.js';

export function SelfLearningAgentList({
  populated,
  selectedRole,
  onSelectRole,
  onBulkOptimize,
  bulkOptimizing,
}: {
  populated: CustomRosterStats[];
  selectedRole: string | null;
  onSelectRole: (role: string) => void;
  onBulkOptimize: (roles: string[]) => void;
  bulkOptimizing: boolean;
}) {
  const { t } = useAppTranslation();
  const needsOpt = populated.filter((s) => s.needsSummarization);

  return (
    <div
      className={cn(
        'flex flex-col min-h-0 min-w-0 overflow-hidden border-r border-border/50',
        selectedRole ? 'w-80 shrink-0' : 'flex-1',
      )}
    >
      <div className="shrink-0 px-3 py-2 border-b border-border/50">
        <h3 className="text-xs font-semibold flex items-center gap-1.5">
          <Database className="h-3.5 w-3.5 text-brand-2" />
          {t('activity:agentRoster.allRosterAgents')}
        </h3>
        {needsOpt.length > 0 && (
          <div className="mt-2 flex flex-col gap-1.5 rounded border border-warning/40 bg-warning/10 px-2 py-1.5">
            <div className="flex items-center gap-2">
              <Zap className="h-3 w-3 text-warning shrink-0" />
              <span className="text-[10px] text-warning leading-tight">
                {needsOpt.length} agent{needsOpt.length > 1 ? 's' : ''} need
                {needsOpt.length === 1 ? 's' : ''} optimization
              </span>
              <button
                type="button"
                onClick={() => {
                  const first = needsOpt[0];
                  if (first) onSelectRole(first.role);
                }}
                className="ml-auto text-[9px] text-warning underline hover:text-warning/80 shrink-0"
              >
                {t('activity:agentRoster.review')}
              </button>
            </div>
            <button
              type="button"
              onClick={() => onBulkOptimize(needsOpt.map((s) => s.role))}
              disabled={bulkOptimizing}
              className="flex items-center justify-center gap-1 rounded bg-warning/20 border border-warning/40 px-2 py-1 text-[10px] font-medium text-warning hover:bg-warning/30 transition-colors disabled:opacity-50"
            >
              {bulkOptimizing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Zap className="h-3 w-3" />
              )}
              {bulkOptimizing
                ? t('activity:agentRoster.optimizing')
                : t('activity:agentRoster.optimizeAll', { count: needsOpt.length })}
            </button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2 space-y-1">
        {populated.map((stat) => (
          <button
            key={stat.role}
            type="button"
            onClick={() => onSelectRole(stat.role)}
            className={cn(
              'w-full text-left rounded-lg border px-3 py-2 transition-colors',
              selectedRole === stat.role
                ? 'border-primary/50 bg-primary/[0.06]'
                : 'border-border/60 hover:border-primary/30',
              stat.needsSummarization && selectedRole !== stat.role && 'border-warning/40',
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold">{stat.role}</span>
              <span
                className={cn(
                  'text-[9px] tabular-nums',
                  stat.learningEnabled ? 'text-success' : 'text-muted-foreground',
                )}
              >
                {stat.learningEnabled
                  ? t('activity:agentRoster.learning')
                  : t('activity:agentRoster.paused')}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1 text-[9px] text-muted-foreground">
              <span className="tabular-nums">{stat.entryCount} entries</span>
              {stat.sessionCaptureCount > 0 && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span className="text-success tabular-nums">+{stat.sessionCaptureCount}</span>
                </>
              )}
              {typeof stat.directiveHitRate === 'number' && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span
                    className={cn(
                      'tabular-nums',
                      stat.directiveHitRate >= 0.7
                        ? 'text-success'
                        : stat.directiveHitRate < 0.4 && 'text-warning',
                    )}
                    title="Share of directive applications that ended in a successful task"
                  >
                    {Math.round(stat.directiveHitRate * 100)}%
                  </span>
                </>
              )}
              {stat.lastCapture && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span>{new Date(stat.lastCapture).toLocaleDateString()}</span>
                </>
              )}
              {stat.needsSummarization && (
                <span className="inline-flex items-center gap-0.5 text-warning font-medium">
                  <Zap className="h-2.5 w-2.5" />
                  optimize
                </span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
