import { ChevronRight, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { useDesktopText } from './desktop-i18n';
import { LazyDetails } from './LazyDetails';
import type { ActivityRow } from './session-activity-model';
import { TranscriptTimestamp } from './TranscriptTimestamp';

/** Iteration headers are disclosures, never tool cards. Unknown/truncated work stays ungrouped. */
export function ActivityGroups({
  rows,
  allRows,
  children,
}: {
  rows: readonly ActivityRow[];
  allRows: readonly ActivityRow[];
  children: (row: ActivityRow) => ReactNode;
}) {
  const { t } = useDesktopText();
  const groups: Array<{ header: ActivityRow; rows: ActivityRow[] } | ActivityRow> = [];
  const iterations = new Map<string, { header: ActivityRow; rows: ActivityRow[] }>();
  for (const row of allRows) {
    if (row.iterationId === row.id) iterations.set(row.id, { header: row, rows: [] });
  }
  const included = new Set<string>();
  for (const row of rows) {
    const group = row.iterationId ? iterations.get(row.iterationId) : undefined;
    if (!group) {
      groups.push(row);
      continue;
    }
    if (!included.has(group.header.id)) {
      groups.push(group);
      included.add(group.header.id);
    }
    if (row.id !== group.header.id) group.rows.push(row);
  }
  return (
    <div className="activity-list">
      {groups.map((group) => {
        if (!('header' in group)) return children(group);
        const { header, rows } = group;
        const calls = rows.filter((row) => row.kind === 'tool').length;
        const failed = rows.filter((row) => row.status === 'failed').length;
        return (
          <LazyDetails
            key={header.id}
            className={`activity-iteration activity-${header.status}`}
            defaultOpen
            summary={
              <summary>
                <ChevronRight size={14} className="activity-chevron" aria-hidden="true" />
                <strong>
                  {header.label ? t(header.label.key, header.label.values ?? {}) : header.title}
                </strong>
                <span className="activity-iteration-meta">
                  {calls > 0 &&
                    t(calls === 1 ? 'turn.toolCall' : 'turn.toolCalls', { count: calls })}
                  {failed > 0 && <span> · {t('turn.failed', { count: failed })}</span>}
                </span>
                <TranscriptTimestamp value={header.at} />
                <span className="activity-iteration-status">
                  {header.status === 'running' && (
                    <LoaderCircle size={12} className="spin" aria-hidden="true" />
                  )}
                  {t(`runLog.status.${header.status === 'info' ? 'recorded' : header.status}`)}
                </span>
              </summary>
            }
          >
            <div className="activity-iteration-rows">
              {rows.length ? (
                rows.map(children)
              ) : (
                <p className="quiet-state">{t('runLog.noDetails')}</p>
              )}
            </div>
          </LazyDetails>
        );
      })}
    </div>
  );
}
