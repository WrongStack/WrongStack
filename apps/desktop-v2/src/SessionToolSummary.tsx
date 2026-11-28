import { type CSSProperties, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useDesktopText } from './desktop-i18n';
import { displayCount } from './display-dates';
import type { EngineState } from './engine-state';
import { surfaceI18n } from './surface-i18n';
import { conversationToolCallCounts } from './tool-stats-model';

/** A local, live conversation summary; never fetches counts from another session. */
export function SessionToolSummary({ activity }: { activity: Pick<EngineState, 'toolCalls'> }) {
  const { t } = useDesktopText();
  const { t: words } = useTranslation('sessionInspector', { i18n: surfaceI18n });
  const summary = useMemo(() => conversationToolCallCounts(activity), [activity.toolCalls]);
  // Each tool's bar is its share of the busiest tool, so the leader always fills the row.
  const busiest = Math.max(1, ...summary.tools.map((tool) => tool.calls));
  return (
    <section className="session-tool-summary" aria-label={t('toolStats.title')}>
      <h3>{t('toolStats.title')}</h3>
      <p>{t('toolStats.thisConversation')}</p>
      <dl>
        <div className="session-tool-total">
          <dt>{words('total')}</dt>
          <dd>{displayCount(summary.total)}</dd>
        </div>
        {summary.tools.map((tool) => (
          <div
            key={tool.name}
            className="session-tool-row"
            style={{ '--share': `${(tool.calls / busiest) * 100}%` } as CSSProperties}
          >
            <dt>
              <code>{tool.name}</code>
            </dt>
            <dd>{displayCount(tool.calls)}</dd>
          </div>
        ))}
      </dl>
      {!summary.total && <p>{t('toolStats.none')}</p>}
    </section>
  );
}
