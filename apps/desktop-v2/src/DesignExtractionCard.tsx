import { Check, Circle, FileCode2, LoaderCircle, Palette, X } from 'lucide-react';
import { designExtractionResult } from './design-extraction-result';
import { useDesktopText } from './desktop-i18n';
import type { ActivityRow } from './session-activity-model';
import './conversation-welcome.css';
import './design-flow.css';

const stages = [
  'designFlow.measure',
  'chatView.designStageSubpages',
  'chatView.designStageSynthesis',
  'chatView.designStageSpec',
] as const;

export function DesignExtractionCard({
  row,
  projectRoot,
  onOpenFile,
  onOpenDesign,
}: {
  row: ActivityRow;
  projectRoot?: string | null | undefined;
  onOpenFile: (path: string) => void;
  onOpenDesign?: (() => void) | undefined;
}) {
  const { t } = useDesktopText();
  const extraction = designExtractionResult(row, projectRoot);
  if (!extraction) return null;
  const { step, path, pages } = extraction;
  const status =
    row.status === 'running'
      ? 'running'
      : row.status === 'done'
        ? 'done'
        : row.status === 'failed'
          ? 'failed'
          : row.status === 'aborted'
            ? 'aborted'
            : 'recorded';
  return (
    <section className="design-extraction-card" aria-label={t('chatView.designTitle')}>
      <header>
        <strong>{t('chatView.designTitle')}</strong>
        <span>{t(`runLog.status.${status}`)}</span>
      </header>
      <ol className="conversation-welcome-design-stages">
        {stages.map((label, index) => {
          const done = row.status === 'done' || index + 1 < step;
          const active = index + 1 === step && row.status === 'running';
          const failed =
            index + 1 === step && (row.status === 'failed' || row.status === 'aborted');
          const Icon = done ? Check : active ? LoaderCircle : failed ? X : Circle;
          return (
            <li
              key={label}
              aria-current={active ? 'step' : undefined}
              data-state={done ? 'done' : active ? 'running' : failed ? 'failed' : 'pending'}
            >
              <Icon size={14} aria-hidden="true" className={active ? 'spin' : undefined} />
              <span className="design-step-status">
                {done
                  ? t('runLog.status.done')
                  : active
                    ? t('runLog.status.running')
                    : failed
                      ? t(`runLog.status.${status}`)
                      : t('designFlow.pending')}
                :
              </span>
              {t(label)}
            </li>
          );
        })}
      </ol>
      {row.status === 'done' &&
        (path ? (
          <div className="design-extraction-artifact">
            <code title={path}>{path}</code>
            {pages !== undefined && (
              <small>{t('designFlow.measuredPages', { count: pages })}</small>
            )}
            <div className="design-flow-actions">
              <button
                type="button"
                className="button secondary small"
                onClick={() => onOpenFile(path)}
              >
                <FileCode2 size={14} aria-hidden="true" /> {t('designFlow.openSpec')}
              </button>
              {onOpenDesign && (
                <button type="button" className="button secondary small" onClick={onOpenDesign}>
                  <Palette size={14} aria-hidden="true" /> {t('pages.design')}
                </button>
              )}
            </div>
          </div>
        ) : (
          <small>{t('designFlow.noArtifact')}</small>
        ))}
    </section>
  );
}
