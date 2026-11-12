import { ToolCallOverview } from '@wrongstack/project-surfaces/tools/ToolCallOverview';
import {
  Activity,
  Brain,
  CheckCircle2,
  Clock3,
  FileCode2,
  LoaderCircle,
  RotateCw,
  Wrench,
  XCircle,
} from 'lucide-react';
import { type ReactNode, Suspense, useMemo, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { DesignExtractionCard } from './DesignExtractionCard';
import { DesignReviewCard } from './DesignReviewCard';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import type { EngineEvent } from './engine-state';
import { GeneratedImages } from './GeneratedImages';
import { activityRows } from './session-activity-model';
import { surfaceI18n } from './surface-i18n';
import { StructuredToolValue } from './ToolApprovalCard';
import { ToolInputView } from './ToolInputView';
import { ToolOutputActions } from './ToolOutputActions';
import './session-activity.css';

function readableOutput(value: string): unknown {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      /* Plain text remains unchanged. */
    }
  }
  return value;
}
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
      <div className="activity-list">
        {shown.flatMap((row) => [
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
          <details key={row.id} className={`activity-entry activity-${row.status}`}>
            <summary>
              <span className="activity-entry-icon">
                {row.kind === 'tool' ? (
                  <Wrench size={15} />
                ) : row.kind === 'reasoning' ? (
                  <Brain size={15} />
                ) : row.kind === 'retry' ? (
                  <RotateCw size={15} />
                ) : (
                  <Activity size={15} />
                )}
              </span>
              <span className="activity-entry-label">
                <strong>{row.label ? t(row.label.key, row.label.values ?? {}) : row.title}</strong>
                <small>
                  {row.agent ? `${row.agent} · ` : ''}
                  {row.status === 'running'
                    ? t('runLog.status.running')
                    : row.status === 'done'
                      ? t('runLog.status.done')
                      : row.status === 'failed'
                        ? t('runLog.status.failed')
                        : row.status === 'aborted'
                          ? t('runLog.status.aborted')
                          : row.kind === 'retry'
                            ? t('runLog.status.retry')
                            : t('runLog.status.recorded')}
                </small>
              </span>
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
            <div className="activity-entry-body">
              {row.kind === 'tool' && (
                <I18nextProvider i18n={surfaceI18n}>
                  <div className="ws-surfaces">
                    <ToolCallOverview
                      message={{
                        toolName: row.title,
                        toolInput: row.input,
                        toolResult: row.output,
                        toolOutputBytes: row.outputBytes,
                      }}
                    />
                  </div>
                </I18nextProvider>
              )}
              {row.input !== undefined && (
                <section className="approval-arguments" aria-label={t('runLog.inputLabel')}>
                  <strong>{t('runLog.input')}</strong>
                  {row.kind === 'tool' ? (
                    <ToolInputView name={row.title} input={row.input} />
                  ) : (
                    <StructuredToolValue value={row.input} />
                  )}
                </section>
              )}
              {row.progress.length > 0 && (
                <section>
                  <h4>{t('runLog.progress')}</h4>
                  {row.progress.map((text, i) => (
                    <pre key={i}>{text}</pre>
                  ))}
                </section>
              )}
              {row.output && (
                <section>
                  {/* The actions sit beside the heading, not in it: a heading is named by its
                      text, so "Output" must not read as "Output exit 0 Copy Save". */}
                  <div className="activity-output-heading">
                    <h4>
                      {row.kind === 'reasoning'
                        ? t('runLog.thinking')
                        : row.kind === 'retry'
                          ? t('runLog.retryDetails')
                          : row.outputBytes !== undefined &&
                              row.outputBytes > new TextEncoder().encode(row.output).length
                            ? t('runLog.outputPreview')
                            : t('runLog.output')}
                    </h4>
                    {row.kind === 'tool' && (
                      <ToolOutputActions tool={row.title} output={row.output} />
                    )}
                  </div>
                  <div className="approval-arguments">
                    <StructuredToolValue value={readableOutput(row.output)} />
                  </div>
                  {command && row.kind === 'tool' && row.title === 'image_generate' && (
                    <GeneratedImages output={row.output} command={command} />
                  )}
                </section>
              )}
              {row.files.length > 0 && (
                <section>
                  <h4>{t('runLog.files')}</h4>
                  <div className="activity-files">
                    {row.files.map((file) => (
                      <button type="button" key={file.path} onClick={() => onOpenFile(file.path)}>
                        <FileCode2 size={13} />
                        <span>{file.path}</span>
                        <small>{file.operation}</small>
                      </button>
                    ))}
                  </div>
                </section>
              )}
              {row.sage.length > 0 && (
                <section>
                  <h4>{t('runLog.sage')}</h4>
                  <ul>
                    {row.sage.map((memory, i) => (
                      <li key={i}>{memory}</li>
                    ))}
                  </ul>
                </section>
              )}
              {!row.input &&
                !row.output &&
                !row.progress.length &&
                !row.files.length &&
                !row.sage.length && <p>{t('runLog.noDetails')}</p>}
            </div>
          </details>,
        ])}
      </div>
    </section>
  );
}
