import { useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineHttp } from './engine-http';
import { dateTimeText, entries, record } from './engine-values';
import { displayDecimal } from './display-dates';

export function TechStackTrends({ http, snapshotId }: { http: EngineHttp; snapshotId: string }) {
  const { t, i18n } = useDesktopText();
  const [trend, setTrend] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setTrend(null);
    setError('');
    void http('/api/techstack/trends')
      .then((data) => {
        if (active) setTrend(record(record(data)['trend']));
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [http, snapshotId]);
  if (error) return <p role="alert">{error}</p>;
  if (!trend) return <p role="status">{t('techTrends.reading')}</p>;
  const points = entries(trend['points']);
  const max = Math.max(
    1,
    ...points.map((point) =>
      Math.max(Number(point['outdated']) || 0, Number(point['vulnerable']) || 0),
    ),
  );
  return (
    <section className="tech-trends" aria-label={t('techTrends.label')}>
      <h2>{t('techTrends.title')}</h2>
      <p>
        {t('techTrends.snapshots', { count: Number(trend['snapshots'] ?? 0) })}
        {trend['from']
          ? ` · ${dateTimeText(trend['from'], i18n.language)} → ${dateTimeText(trend['to'], i18n.language)}`
          : ''}
      </p>
      {typeof trend['vulnerabilityHalfLifeMs'] === 'number' && (
        <p>
          {t('techTrends.halfLife', {
            count: Number((trend['vulnerabilityHalfLifeMs'] / 86400000).toFixed(1)),
          })}
        </p>
      )}
      {points.length ? (
        <>
          <div className="tech-trend-chart" role="img" aria-label={t('techTrends.chart')}>
            {points.map((point, i) => (
              <div
                key={String(point['snapshotId'])}
                title={t('techTrends.bar', {
                  at: dateTimeText(point['createdAt'], i18n.language),
                  outdated: String(point['outdated']),
                  vulnerable: String(point['vulnerable']),
                })}
              >
                <div>
                  <i
                    className="tech-outdated-bar"
                    style={{ height: `${(Number(point['outdated']) / max) * 150}px` }}
                  />
                  <i
                    className="tech-vulnerable-bar"
                    style={{ height: `${(Number(point['vulnerable']) / max) * 150}px` }}
                  />
                </div>
                <small>{i + 1}</small>
              </div>
            ))}
          </div>
          <p className="field-help">{t('techTrends.legend')}</p>
          <div className="tech-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('techTrends.col.observed')}</th>
                  <th>{t('techTrends.col.dependencies')}</th>
                  <th>{t('techTrends.col.outdated')}</th>
                  <th>{t('techTrends.col.vulnerable')}</th>
                </tr>
              </thead>
              <tbody>
                {points.map((point) => (
                  <tr key={String(point['snapshotId'])}>
                    <td>{dateTimeText(point['createdAt'], i18n.language)}</td>
                    <td>{String(point['dependencies'])}</td>
                    <td>{String(point['outdated'])}</td>
                    <td>{String(point['vulnerable'])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p>{t('techTrends.none')}</p>
      )}
      <h3>{t('techTrends.movement')}</h3>
      <div className="tech-table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('techTrends.col.dependency')}</th>
              <th>{t('techTrends.col.version')}</th>
              <th>{t('techTrends.col.age')}</th>
              <th>{t('techTrends.col.changes')}</th>
              <th>{t('techTrends.col.perDay')}</th>
            </tr>
          </thead>
          <tbody>
            {entries(trend['dependencies']).map((item) => (
              <tr key={String(item['key'])}>
                <td>
                  {String(item['name'])}
                  <small>{String(item['ecosystem'])}</small>
                </td>
                <td>{String(item['currentVersion'] ?? t('techTrends.notReported'))}</td>
                <td>
                  {t('techTrends.days', {
                    count: Number((Number(item['lockedVersionAgeMs']) / 86400000).toFixed(1)),
                  })}
                </td>
                <td>{String(item['versionChanges'])}</td>
                <td>{displayDecimal(Number(item['upgradeVelocityPerDay']), 3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
