import { ArrowRight, File, Folder, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineSend } from './engine-operations';
import { contentText, type EngineState, entries, record } from './engine-state';

const queries = {
  files: 'files.list',
  changes: 'git.changes',
  skills: 'skills.list',
  mailbox: 'mailbox.messages',
  kanban: 'kanban.list',
} as const;
export function EngineDataView({
  tab,
  state,
  send,
  onError,
}: {
  tab: keyof typeof queries;
  state: EngineState;
  send: EngineSend;
  onError: (error: unknown) => void;
}) {
  const { t } = useDesktopText();
  const tabWord = t(`engineData.tab.${tab}`);
  const [search, setSearch] = useState('');
  const request = (type: string, payload?: Record<string, unknown>) => {
    void send(type, payload).catch(onError);
  };
  useEffect(() => {
    setSearch('');
    if (state.connected)
      void send(queries[tab], tab === 'files' ? { limit: 500, path: '.' } : {}).catch(onError);
  }, [tab, state.connected, send, onError]);
  const data = state.results[queries[tab]];
  const matches = (text: string) => text.toLowerCase().includes(search.toLowerCase());
  const files = Array.isArray(data?.['files']) ? data['files'] : [];
  const detail =
    state.results[
      tab === 'files'
        ? 'files.read'
        : tab === 'changes'
          ? 'git.diff'
          : tab === 'skills'
            ? 'skills.content'
            : 'kanban.get'
    ];
  return (
    <section className="engine-data-view" aria-label={t('engineData.panel', { tab: tabWord })}>
      <header className="data-toolbar">
        <input
          aria-label={t('engineData.search', { tab: tabWord })}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('engineData.searchPlaceholder', { tab: tabWord })}
        />
        <button
          type="button"
          className="icon-button"
          title={t('engineData.refresh')}
          disabled={!state.connected}
          onClick={() => request(queries[tab], tab === 'files' ? { limit: 500, path: '.' } : {})}
        >
          <RefreshCw size={14} />
        </button>
      </header>
      {typeof data?.['error'] === 'string' && (
        <p className="session-error">{String(data['error'])}</p>
      )}
      {!data && (
        <p className="quiet-state">
          {state.connected ? t('engineData.loading') : t('engineData.waiting')}
        </p>
      )}
      {tab === 'files' && (
        <div className="native-file-layout">
          <div className="native-list">
            {files
              .filter((file) => typeof file === 'string' && matches(file))
              .map((file) => (
                <button
                  type="button"
                  key={String(file)}
                  onClick={() => request('files.read', { filePath: file })}
                >
                  <File size={14} />
                  <span>{String(file)}</span>
                  <ArrowRight size={13} />
                </button>
              ))}
            {data && !files.length && <p className="quiet-state">{t('engineData.noFiles')}</p>}
          </div>
          {detail && (
            <div className="native-file-content">
              <strong>{String(detail['filePath'] ?? '')}</strong>
              <pre>
                {contentText(detail['content']) ||
                  String(detail['error'] ?? t('engineData.noText'))}
              </pre>
            </div>
          )}
        </div>
      )}
      {tab === 'changes' && (
        <>
          <div className="native-list">
            {entries(data?.['files'])
              .filter((file) => matches(String(file['path'])))
              .map((file) => (
                <button
                  type="button"
                  key={String(file['path'])}
                  onClick={() => request('git.diff', { path: file['path'] })}
                >
                  <span className="change-status">{String(file['status'])}</span>
                  <span>{String(file['path'])}</span>
                  <ArrowRight size={13} />
                </button>
              ))}
            {data && !files.length && <p className="quiet-state">{t('engineData.clean')}</p>}
          </div>
          {detail && (
            <div className="native-diff">
              <div>
                <span>{t('engineData.before')}</span>
                <pre>{contentText(detail['oldText'])}</pre>
              </div>
              <div>
                <span>{t('engineData.after')}</span>
                <pre>{contentText(detail['newText'])}</pre>
              </div>
              {typeof detail['error'] === 'string' && <p>{String(detail['error'])}</p>}
            </div>
          )}
        </>
      )}
      {tab === 'skills' && (
        <>
          <div className="native-list">
            {entries(data?.['skills'])
              .filter((skill) => matches(String(skill['name'])))
              .map((skill) => (
                <button
                  type="button"
                  key={String(skill['name'])}
                  onClick={() =>
                    request('skills.content', { name: skill['name'], source: skill['source'] })
                  }
                >
                  <div>
                    <strong>{String(skill['name'])}</strong>
                    <p>{String(skill['description'] ?? '')}</p>
                  </div>
                  <ArrowRight size={13} />
                </button>
              ))}
          </div>
          {detail && (
            <article className="native-document">
              <h3>{String(detail['name'])}</h3>
              <pre>{contentText(detail['body'])}</pre>
            </article>
          )}
        </>
      )}
      {tab === 'mailbox' && (
        <div className="native-mailbox">
          {entries(data?.['messages'])
            .filter((mail) => matches(`${mail['subject']} ${mail['body']}`))
            .map((mail, index) => (
              <article key={String(mail['id'] ?? index)}>
                <span className="eyebrow">
                  {String(mail['from'] ?? t('engineData.agent'))} →{' '}
                  {String(mail['to'] ?? t('engineData.workspace'))}
                </span>
                <h3>{String(mail['subject'] ?? t('engineData.message'))}</h3>
                <p>{contentText(mail['body'])}</p>
              </article>
            ))}
          {data && !entries(data['messages']).length && (
            <p className="quiet-state">{t('engineData.mailboxClear')}</p>
          )}
        </div>
      )}
      {tab === 'kanban' && (
        <>
          <div className="native-list">
            {entries(data?.['data'])
              .filter((board) => matches(String(board['name'] ?? board['id'])))
              .map((board) => (
                <button
                  type="button"
                  key={String(board['id'])}
                  onClick={() => request('kanban.get', { boardId: board['id'] })}
                >
                  <Folder size={15} />
                  <span>{String(board['name'] ?? board['id'])}</span>
                  <ArrowRight size={13} />
                </button>
              ))}
            {data && !entries(data['data']).length && (
              <p className="quiet-state">{t('engineData.noBoards')}</p>
            )}
          </div>
          {detail && (
            <div className="native-board">
              {entries(record(detail['data'])['tasks']).map((task) => (
                <article key={String(task['id'])}>
                  <span className="eyebrow">
                    {String(task['status'] ?? task['columnId'] ?? t('engineData.task'))}
                  </span>
                  <h3>{String(task['title'])}</h3>
                  <p>{String(task['description'] ?? '')}</p>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
