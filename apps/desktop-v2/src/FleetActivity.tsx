import { useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineHttp } from './engine-http';
import { entries, record } from './engine-values';
import { MarkdownContent } from './MarkdownContent';
import { StructuredToolValue } from './ToolApprovalCard';

export function FleetActivity({ http, sessionId }: { http: EngineHttp; sessionId: string }) {
  const { t } = useDesktopText();
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const alive = useRef(true),
    sequence = useRef(0),
    pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sequence.current++;
    };
  }, []);
  const load = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    const current = ++sequence.current;
    try {
      const value = record(
        await http(`/api/sessions/${encodeURIComponent(sessionId)}/events?limit=100`),
      );
      if (
        value['sessionId'] !== sessionId ||
        !Array.isArray(value['entries']) ||
        entries(value['entries']).some(
          (row) =>
            typeof row['text'] !== 'string' ||
            !['user', 'assistant', 'tool', 'system', 'error'].includes(String(row['role'])),
        )
      )
        throw Error(t('liveFleet.activity.invalid'));
      if (alive.current && current === sequence.current) setSnapshot(value);
    } catch (error) {
      if (alive.current && current === sequence.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      if (alive.current && current === sequence.current) setBusy(false);
    }
  };
  return (
    <section className="live-fleet-activity" aria-label={t('liveFleet.activity.label')}>
      <header>
        <div>
          <h4>{t('liveFleet.activity.title')}</h4>
          <p>{t('liveFleet.activity.help')}</p>
        </div>
        <button
          type="button"
          className="button secondary small"
          disabled={busy}
          onClick={() => void load()}
        >
          {busy
            ? t('liveFleet.activity.reading')
            : snapshot
              ? t('liveFleet.activity.refresh')
              : t('liveFleet.activity.read')}
        </button>
      </header>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {snapshot && (
        <>
          <p className="live-fleet-caption">
            {t('liveFleet.activity.showing', {
              n: entries(snapshot['entries']).length,
              rest: snapshot['truncated']
                ? t('liveFleet.activity.upperBound')
                : t('liveFleet.activity.total', {
                    n: Number(snapshot['total'] ?? 0).toLocaleString(),
                  }),
            })}
          </p>
          <div>
            {entries(snapshot['entries']).map((entry, index) => (
              <article key={index}>
                <header>
                  <span className="eyebrow">
                    {t(`liveFleet.activity.role.${String(entry['role'])}`, {
                      defaultValue: String(entry['role']),
                    })}
                    {entry['tool'] ? ` · ${entry['tool']}` : ''}
                  </span>
                  <time>
                    {Number.isFinite(Date.parse(String(entry['ts'])))
                      ? new Date(String(entry['ts'])).toLocaleString()
                      : t('liveFleet.activity.noTime')}
                  </time>
                  {typeof entry['durationMs'] === 'number' && (
                    <small>{entry['durationMs'].toLocaleString()} ms</small>
                  )}
                </header>
                {entry['role'] === 'tool' || entry['role'] === 'error' ? (
                  <>
                    <p>
                      {entry['isError']
                        ? t('liveFleet.activity.failure')
                        : entry['tool']
                          ? t('liveFleet.activity.tool')
                          : t('liveFleet.activity.error')}
                    </p>
                    {entry['input'] !== undefined && (
                      <details>
                        <summary>{t('liveFleet.activity.arguments')}</summary>
                        <StructuredToolValue value={entry['input']} />
                      </details>
                    )}
                    {entry['output'] !== undefined ? (
                      <details>
                        <summary>{t('liveFleet.activity.output')}</summary>
                        {typeof entry['output'] === 'string' ? (
                          <MarkdownContent text={entry['output'].slice(0, 20000)} />
                        ) : (
                          <StructuredToolValue value={entry['output']} />
                        )}
                      </details>
                    ) : (
                      entry['input'] === undefined && (
                        <MarkdownContent text={String(entry['text']).slice(0, 20000)} />
                      )
                    )}
                  </>
                ) : (
                  <MarkdownContent text={String(entry['text']).slice(0, 20000)} />
                )}
                {(String(entry['text']).length > 20000 ||
                  (typeof entry['output'] === 'string' && entry['output'].length > 20000)) && (
                  <small>{t('liveFleet.activity.preview')}</small>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
