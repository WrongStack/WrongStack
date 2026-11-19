import {
  Activity,
  Brain,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  RotateCw,
  Wrench,
  XCircle,
} from 'lucide-react';
import { type ReactNode, Suspense, useMemo, useState } from 'react';
import { ActivityEntryBody } from './ActivityEntryBody';
import { ActivityGroups } from './ActivityGroups';
import { DesignExtractionCard } from './DesignExtractionCard';
import { DesignReviewCard } from './DesignReviewCard';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import type { EngineEvent } from './engine-state';
import { activityRows } from './session-activity-model';
import { ToolKindIcon } from './ToolKindIcon';
import { TranscriptTimestamp } from './TranscriptTimestamp';
import { toolInputHint } from './tool-input-view';
import './session-activity.css';
import { LazyDetails } from './LazyDetails';

export function SessionActivity({
  events,
  projectRoot,
  onOpenFile,
  onOpenDesign,
  compact = false,
  settled = false,
  interrupted = false,
  showThinkingLogs = true,
  command,
  collab,
}: {
  events: readonly EngineEvent[];
  projectRoot?: string | null | undefined;
  onOpenFile: (path: string) => void;
  onOpenDesign?: (() => void) | undefined;
  compact?: boolean;
  settled?: boolean;
  /** The host knows this engine stopped without necessarily writing a final run result. */
  interrupted?: boolean;
  showThinkingLogs?: boolean | undefined;
  /** The conversation's engine, to show the pictures an `image_generate` call saved. */
  command?: EngineCommand | undefined;
  /** The conversation's collaboration bar, shown under the full run log's header. */
  collab?: ReactNode;
}) {
  const { t } = useDesktopText();
  const [filter, setFilter] = useState<'all' | 'tool' | 'reasoning' | 'run'>('all');
  const rows = useMemo(() => {
    const rows = activityRows(events);
    return settled || interrupted
      ? rows.map((row) =>
          row.status === 'running'
            ? { ...row, status: interrupted ? ('aborted' as const) : ('info' as const) }
            : row,
        )
      : rows;
  }, [events, settled, interrupted]);
  const shown = rows.filter(
    (row) =>
      (showThinkingLogs || row.kind !== 'reasoning') &&
      (filter === 'all' ||
        (!showThinkingLogs && filter === 'reasoning') ||
        row.kind === filter ||
        (filter === 'run' && row.kind === 'retry')),
  );
  return (
    <section
      className={`session-activity ${compact ? 'session-activity-compact' : ''}`}
      aria-label={compact ? t('runLog.currentLabel') : t('runLog.label')}
    >
      {!compact && (
        <header className="session-activity-header">
          <div>
            <span className="eyebrow">{t('runLog.eyebrow')}</span>
            <h2>{t('turn.activity')}</h2>
            <p>{t('runLog.body')}</p>
          </div>
          <nav aria-label={t('runLog.filters')}>
            {(['all', 'tool', 'reasoning', 'run'] as const)
              .filter((kind) => showThinkingLogs || kind !== 'reasoning')
              .map((kind) => (
                <button
                  type="button"
                  key={kind}
                  aria-pressed={filter === kind}
                  onClick={() => setFilter(kind)}
                >
                  {t(`runLog.filter.${kind}`)}
                </button>
              ))}
          </nav>
        </header>
      )}
      {!compact && collab && <Suspense fallback={null}>{collab}</Suspense>}
      {!shown.length && (
        <p className="quiet-state">{rows.length ? t('runLog.noMatch') : t('runLog.empty')}</p>
      )}
      <ActivityGroups rows={shown} allRows={rows}>
        {(row) => {
          // The collapsed chat row names what the call acted on; its status is the trailing icon.
          const hint = compact && row.kind === 'tool' ? toolInputHint(row.title, row.input) : '';
          return [
            row.kind === 'tool' && row.title === 'design_reference' ? (
              <DesignExtractionCard
                key={`design:${row.id}`}
                row={row}
                projectRoot={projectRoot}
                onOpenFile={onOpenFile}
                onOpenDesign={onOpenDesign}
              />
            ) : null,
            row.kind === 'tool' && row.title === 'design_reference' ? (
              <DesignReviewCard
                key={`review:${row.id}`}
                row={row}
                projectRoot={projectRoot}
                onOpenFile={onOpenFile}
              />
            ) : null,
            <LazyDetails
              key={row.id}
              className={`activity-entry activity-${row.status} activity-kind-${row.kind}`}
              summary={
                <summary>
                  <span className="activity-entry-icon">
                    {row.kind === 'tool' ? (
                      compact ? (
                        <ToolKindIcon name={row.title} size={15} />
                      ) : (
                        <Wrench size={15} />
                      )
                    ) : row.kind === 'reasoning' ? (
                      <Brain size={15} />
                    ) : row.kind === 'retry' ? (
                      <RotateCw size={15} />
                    ) : (
                      <Activity size={15} />
                    )}
                  </span>
                  <span className="activity-entry-label">
                    <strong>
                      {row.label ? t(row.label.key, row.label.values ?? {}) : row.title}
                    </strong>
                    <small>
                      {row.agent ? `${row.agent} · ` : ''}
                      {hint ? (
                        <span className="activity-entry-hint">{hint}</span>
                      ) : row.status === 'running' ? (
                        t('runLog.status.running')
                      ) : row.status === 'done' ? (
                        t('runLog.status.done')
                      ) : row.status === 'failed' ? (
                        t('runLog.status.failed')
                      ) : row.status === 'aborted' ? (
                        t('runLog.status.aborted')
                      ) : row.kind === 'retry' ? (
                        t('runLog.status.retry')
                      ) : (
                        t('runLog.status.recorded')
                      )}
                    </small>
                  </span>
                  <TranscriptTimestamp value={row.at} />
                  {row.durationMs !== undefined && (
                    <small className="activity-metric">
                      <Clock3 size={12} />{' '}
                      {row.kind === 'retry'
                        ? t('runLog.wait', { ms: row.durationMs })
                        : `${row.durationMs} ms`}
                    </small>
                  )}
                  {row.outputBytes !== undefined && (
                    <small className="activity-metric">
                      {t('runLog.bytes', { bytes: row.outputBytes.toLocaleString() })}
                    </small>
                  )}
                  {row.status === 'running' ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : row.status === 'failed' ? (
                    <XCircle size={14} />
                  ) : row.status === 'done' ? (
                    <CheckCircle2 size={14} />
                  ) : null}
                </summary>
              }
            >
              <ActivityEntryBody row={row} onOpenFile={onOpenFile} command={command} />
            </LazyDetails>,
          ];
        }}
      </ActivityGroups>
    </section>
  );
}
