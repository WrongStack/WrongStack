import { useEffect, useState } from 'react';
import { ConversationReconnect } from './ConversationReconnect';
import { useDesktopText } from './desktop-i18n';
import { journalReader } from './engine-stream';
import { isLive, type Session } from './model';
import { request } from './platform';
import {
  type DraftDiagnostics,
  recoveryDraft,
  recoveryIdentity,
  recoveryLayout,
} from './recovery-identity';
import {
  canReconnect,
  desktopStorageSize,
  type JournalStatus,
  journalStatus,
} from './session-reconnect-model';
import './reconnect.css';

function storedSize(): number {
  try {
    return desktopStorageSize(localStorage);
  } catch {
    return 0;
  }
}

/**
 * The desktop's counterpart of the WebUI's refresh diagnostics: what carries over when the
 * window reloads or the app restarts. For each of the project's conversations it shows the
 * engine's state, how far this window has read its journal and which session it recorded,
 * with a reconnect for conversations whose engine stopped.
 */
export function ConnectionDiagnostics({
  sessions,
  layout,
  draftDiagnostics,
}: {
  sessions: readonly Session[];
  layout?: string | null | undefined;
  draftDiagnostics?: ((id: string) => DraftDiagnostics) | undefined;
}) {
  const { t } = useDesktopText();
  // Journal readers advance on their own; the table follows them once a second.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const [identities, setIdentities] = useState<Record<string, string>>({});
  const [draftVersions, setDraftVersions] = useState<Record<string, Record<string, unknown>>>({});
  const liveIds = sessions
    .filter((session) => session.kind === 'agent' && isLive(session))
    .map((session) => session.id)
    .sort()
    .join('\n');
  useEffect(() => {
    let cancelled = false,
      busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const savedDrafts: Record<string, Record<string, unknown>> = {};
        const pairs = await Promise.all(
          liveIds
            .split('\n')
            .filter(Boolean)
            .map(async (id) => {
              try {
                const [value, versions] = await Promise.all([
                  request<Record<string, unknown>>('engine.identity', { id }).catch(() => null),
                  request<Record<string, unknown>>('draft.revisions', { id }).catch(
                    () => undefined,
                  ),
                ]);
                if (versions) savedDrafts[id] = versions;
                return [
                  id,
                  typeof value?.['sessionId'] === 'string' ? value['sessionId'] : '',
                ] as const;
              } catch {
                return [id, ''] as const;
              }
            }),
        );
        if (!cancelled) {
          setIdentities(Object.fromEntries(pairs));
          setDraftVersions(savedDrafts);
        }
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [liveIds]);
  const savedLayout = recoveryLayout(layout);
  const agents = sessions.filter((session) => session.kind === 'agent');
  const journalText = (status: JournalStatus) =>
    status.kind === 'reading'
      ? t('connectionView.journal.reading', { percent: status.percent })
      : t(`connectionView.journal.${status.kind}`);
  return (
    <section className="connection-diagnostics" aria-label={t('connectionView.title')}>
      <header>
        <span className="eyebrow">{t('connectionView.eyebrow')}</span>
        <h2>{t('connectionView.title')}</h2>
        <p>{t('connectionView.body')}</p>
        <p className="field-help">
          {t('connectionView.summary', {
            live: agents.filter(isLive).length,
            attention: agents.filter(canReconnect).length,
          })}{' '}
          · {t('connectionView.storage', { size: storedSize().toLocaleString() })}
        </p>
      </header>
      {savedLayout && (
        <p className="field-help">
          {t('recoveryIdentity.layout')} · {savedLayout.project || '—'} ·{' '}
          {savedLayout.selected || '—'} · {savedLayout.page || '—'}
        </p>
      )}
      {agents.length === 0 ? (
        <p className="field-help">{t('connectionView.none')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">{t('connectionView.column.conversation')}</th>
              <th scope="col">{t('connectionView.column.engine')}</th>
              <th scope="col">{t('connectionView.column.journal')}</th>
              <th scope="col">{t('connectionView.column.updated')}</th>
              <th scope="col">
                <span className="sr-only">{t('connectionView.column.action')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {agents.map((session) => {
              const progress = journalReader('engine', session.id);
              return (
                <tr key={session.id}>
                  <td>
                    <strong>{session.title}</strong>
                    {progress?.sessionId && (
                      <small>{t('connectionView.recorded', { id: progress.sessionId })}</small>
                    )}
                    <small role="status">
                      {t(
                        `recoveryIdentity.${recoveryIdentity(
                          identities[session.id],
                          progress?.sessionId,
                          progress?.hydrating ?? true,
                        )}`,
                      )}
                    </small>
                    {identities[session.id] && (
                      <small>
                        {t('recoveryIdentity.expected', { id: identities[session.id] })}
                      </small>
                    )}
                    <small>
                      {t(
                        `recoveryDraft.${recoveryDraft(draftDiagnostics?.(session.id), draftVersions[session.id])}`,
                      )}
                    </small>
                    {progress && (
                      // The WebUI's transcript check after F5: what this window rebuilt.
                      <small>{t('connectionView.restored', { count: progress.messages })}</small>
                    )}
                  </td>
                  <td>
                    {t(`status.${session.status}`)}
                    {session.error && <small>{session.error}</small>}
                  </td>
                  <td>
                    {journalText(journalStatus(progress))}
                    {progress?.lastAt ? (
                      <small>
                        {t('connectionView.lastFrame', {
                          time: new Date(progress.lastAt).toLocaleTimeString(),
                        })}
                      </small>
                    ) : null}
                  </td>
                  <td>{new Date(session.updatedAt).toLocaleString()}</td>
                  <td>
                    <ConversationReconnect session={session} compact />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
