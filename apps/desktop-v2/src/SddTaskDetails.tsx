import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { entries, record } from './engine-state';
import { parseSddSubtasks } from './sdd-task-split';

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export function SddTaskDetails({
  task,
  tasks,
  board,
  waiting,
  request,
  onSelect,
}: {
  task: Record<string, unknown>;
  tasks: Record<string, unknown>[];
  board: Record<string, unknown>;
  waiting: boolean;
  request: (type: string, payload: Record<string, unknown>, description: string) => Promise<void>;
  onSelect: (id: string) => void;
}) {
  const { t } = useDesktopText();
  const shown = (value: unknown) =>
    typeof value === 'string' && value
      ? value
      : typeof value === 'number'
        ? String(value)
        : t('sddView.notReported');
  const named = (value: unknown) =>
    typeof value === 'string' && value
      ? t(`sddView.value.${value}`, { defaultValue: value })
      : shown(value);
  const [agent, setAgent] = useState(
    typeof task['agentName'] === 'string' ? task['agentName'] : '',
  );
  const [model, setModel] = useState(typeof task['model'] === 'string' ? task['model'] : '');
  const [provider, setProvider] = useState(
    typeof task['provider'] === 'string' ? task['provider'] : '',
  );
  const [fallbacks, setFallbacks] = useState(strings(task['fallbackModels']).join('\n'));
  const [verification, setVerification] = useState(
    typeof task['verificationCommand'] === 'string' ? task['verificationCommand'] : '',
  );
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null);
  const [splitText, setSplitText] = useState('');
  const [confirmSplit, setConfirmSplit] = useState(false);
  const live = ['running', 'paused'].includes(String(board['status']));
  const status = String(task['displayStatus'] ?? task['status']);
  const mutate = (action: string, payload: Record<string, unknown>, description: string) =>
    request(
      `sdd.board.${action}`,
      { runId: board['runId'], taskId: task['id'], ...payload },
      description,
    );
  const history = entries(record(board['taskEvents'])[String(task['id'])]);
  const feed = history.length
    ? history
    : entries(board['feed']).filter(
        (item) => item['taskId'] === task['id'] || item['taskShortId'] === task['shortId'],
      );
  const dependencies = strings(task['deps']);
  const dependents = tasks.filter((item) =>
    strings(item['deps']).includes(String(task['shortId'])),
  );
  return (
    <aside className="sdd-task-detail" aria-label={t('sddView.taskDetail.label')}>
      <span className="eyebrow">
        {t('sddView.taskDetail.eyebrow', { id: shown(task['shortId']) })}
      </span>
      <h3>{shown(task['title'])}</h3>
      <p>
        {typeof task['description'] === 'string' && task['description']
          ? task['description']
          : t('sddView.taskDetail.noDescription')}
      </p>
      <dl className="sdd-task-meta">
        {[
          ['status', named(task['displayStatus'] ?? task['status'])],
          ['priority', named(task['priority'])],
          ['type', shown(task['type'])],
          ['agent', shown(task['agentName'])],
          ['model', shown(task['model'] ?? board['defaultModel'])],
          ['provider', shown(task['provider'] ?? board['defaultProvider'])],
          ['retries', shown(task['retries'])],
          ['branch', shown(task['worktreeBranch'])],
          ['verification', named(task['verificationState'])],
        ].map(([name, value]) => (
          <div key={name}>
            <dt>{t(`sddView.taskDetail.meta.${name}`)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {typeof task['verificationDetail'] === 'string' && task['verificationDetail'] && (
        <p className="session-error">{task['verificationDetail']}</p>
      )}
      {dependencies.length > 0 && (
        <div className="sdd-dependencies">
          <h4>{t('sddView.taskDetail.dependsOn')}</h4>
          {dependencies.map((id) => {
            const dependency = tasks.find((item) => item['shortId'] === id);
            return dependency && typeof dependency['id'] === 'string' ? (
              <button
                type="button"
                className="button secondary"
                key={id}
                onClick={() => onSelect(dependency['id'] as string)}
              >
                {shown(dependency['title'])}
              </button>
            ) : (
              <span key={id}>{id}</span>
            );
          })}
        </div>
      )}
      {dependents.length > 0 && (
        <div className="sdd-dependencies">
          <h4>{t('sddView.taskDetail.unblocks')}</h4>
          {dependents.map((item) => (
            <button
              type="button"
              className="button secondary"
              key={String(item['id'])}
              onClick={() => onSelect(String(item['id']))}
            >
              {shown(item['title'])}
            </button>
          ))}
        </div>
      )}
      {live && (
        <div className="sdd-task-controls">
          <p>{t('sddView.taskDetail.controlsHint')}</p>
          <div className="sdd-actions">
            {['failed', 'blocked'].includes(status) && (
              <button
                type="button"
                className="button secondary"
                disabled={waiting}
                onClick={() => void mutate('retry', {}, t('sddView.taskDetail.action.retry'))}
              >
                {t('sddView.taskDetail.retry')}
              </button>
            )}
            {status === 'in_progress' && (
              <button
                type="button"
                className="button secondary"
                disabled={waiting}
                onClick={() => setConfirm('cancel')}
              >
                {t('sddView.taskDetail.cancel')}
              </button>
            )}
            {['pending', 'blocked', 'queued'].includes(status) && (
              <button
                type="button"
                className="button secondary"
                disabled={waiting}
                onClick={() => setConfirm('delete')}
              >
                {t('sddView.taskDetail.delete')}
              </button>
            )}
            {confirm && (
              <>
                <span>
                  {confirm === 'cancel'
                    ? t('sddView.taskDetail.cancelAsk')
                    : t('sddView.taskDetail.deleteAsk')}
                </span>
                <button
                  type="button"
                  className="button secondary"
                  disabled={waiting}
                  onClick={() => {
                    const action = confirm;
                    setConfirm(null);
                    void mutate(
                      action === 'cancel' ? 'cancel_task' : 'delete_task',
                      {},
                      action === 'cancel'
                        ? t('sddView.taskDetail.action.cancel')
                        : t('sddView.taskDetail.action.delete'),
                    );
                  }}
                >
                  {confirm === 'cancel'
                    ? t('sddView.taskDetail.confirmCancel')
                    : t('sddView.taskDetail.confirmDelete')}
                </button>
                <button type="button" onClick={() => setConfirm(null)}>
                  {t('sddView.taskDetail.keep')}
                </button>
              </>
            )}
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (agent.trim())
                void mutate(
                  'reassign',
                  { agentName: agent.trim() },
                  t('sddView.taskDetail.action.assign'),
                );
            }}
          >
            <label>
              {t('sddView.taskDetail.agent')}
              <input
                aria-label={t('sddView.taskDetail.agent')}
                value={agent}
                onChange={(event) => setAgent(event.target.value)}
              />
            </label>
            <button type="submit" className="button secondary" disabled={!agent.trim() || waiting}>
              {t('sddView.taskDetail.updateAgent')}
            </button>
          </form>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(
                'set_task_model',
                {
                  ...(model.trim() ? { model: model.trim() } : {}),
                  ...(provider.trim() ? { provider: provider.trim() } : {}),
                },
                t('sddView.taskDetail.action.model'),
              );
            }}
          >
            <div className="sdd-model-inputs">
              <label>
                {t('sddView.taskDetail.provider')}
                <input
                  aria-label={t('sddView.taskDetail.provider')}
                  value={provider}
                  onChange={(event) => setProvider(event.target.value)}
                  placeholder={t('sddView.taskDetail.providerPlaceholder')}
                />
              </label>
              <label>
                {t('sddView.taskDetail.model')}
                <input
                  aria-label={t('sddView.taskDetail.model')}
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder={t('sddView.taskDetail.modelPlaceholder')}
                />
              </label>
            </div>
            <button type="submit" className="button secondary" disabled={waiting}>
              {t('sddView.taskDetail.updateModel')}
            </button>
          </form>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(
                'set_task_fallbacks',
                {
                  fallbackModels: fallbacks
                    .split('\n')
                    .map((item) => item.trim())
                    .filter(Boolean),
                },
                t('sddView.taskDetail.action.fallbacks'),
              );
            }}
          >
            <label>
              {t('sddView.taskDetail.fallbacks')}
              <textarea
                aria-label={t('sddView.taskDetail.fallbacksLabel')}
                value={fallbacks}
                onChange={(event) => setFallbacks(event.target.value)}
              />
            </label>
            <button type="submit" className="button secondary" disabled={waiting}>
              {t('sddView.taskDetail.updateFallbacks')}
            </button>
          </form>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(
                'set_task_verification',
                { verificationCommand: verification.trim() },
                t('sddView.taskDetail.action.verification'),
              );
            }}
          >
            <label>
              {t('sddView.taskDetail.verification')}
              <input
                aria-label={t('sddView.taskDetail.verification')}
                value={verification}
                onChange={(event) => setVerification(event.target.value)}
                placeholder={t('sddView.taskDetail.verificationPlaceholder')}
              />
            </label>
            <button type="submit" className="button secondary" disabled={waiting}>
              {t('sddView.taskDetail.updateVerification')}
            </button>
          </form>
          {['pending', 'blocked', 'queued'].includes(status) && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (parseSddSubtasks(splitText).length) setConfirmSplit(true);
              }}
            >
              <label>
                {t('sddView.taskDetail.split')}
                <textarea
                  aria-label={t('sddView.taskDetail.split')}
                  value={splitText}
                  onChange={(event) => {
                    setSplitText(event.target.value);
                    setConfirmSplit(false);
                  }}
                  placeholder={t('sddView.taskDetail.splitPlaceholder')}
                />
              </label>
              {confirmSplit ? (
                <>
                  <p>
                    {t('sddView.taskDetail.splitBody', {
                      count: parseSddSubtasks(splitText).length,
                    })}
                  </p>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={waiting}
                    onClick={() => {
                      setConfirmSplit(false);
                      void mutate(
                        'split_task',
                        { subtasks: parseSddSubtasks(splitText) },
                        t('sddView.taskDetail.action.split'),
                      );
                    }}
                  >
                    {t('sddView.taskDetail.confirmSplit')}
                  </button>
                  <button type="button" onClick={() => setConfirmSplit(false)}>
                    {t('sddView.taskDetail.keep')}
                  </button>
                </>
              ) : (
                <button
                  type="submit"
                  className="button secondary"
                  disabled={!parseSddSubtasks(splitText).length || waiting}
                >
                  {t('sddView.taskDetail.reviewSplit')}
                </button>
              )}
            </form>
          )}
        </div>
      )}
      {feed.length > 0 && (
        <div className="sdd-task-history">
          <h4>{t('sddView.taskDetail.activity')}</h4>
          {feed.slice(-30).map((item, index) => (
            <article key={`${String(item['ts'])}-${index}`}>
              <strong>
                {typeof item['kind'] === 'string' && item['kind']
                  ? t(`sddView.feed.kind.${item['kind']}`, { defaultValue: item['kind'] })
                  : shown(item['kind'])}
              </strong>
              <p>{typeof item['text'] === 'string' ? item['text'] : t('sddView.feed.noDetails')}</p>
              {typeof item['detail'] === 'string' && <p>{item['detail']}</p>}
            </article>
          ))}
        </div>
      )}
    </aside>
  );
}
