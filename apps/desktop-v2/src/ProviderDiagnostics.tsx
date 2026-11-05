import { FlaskConical, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';
import { providerChoices } from './provider-settings-model';

export function ProviderDiagnostics({ state, send }: { state: EngineState; send: EngineSend }) {
  const { t } = useDesktopText();
  const [provider, setProvider] = useState(state.needsSetup ? '' : state.provider);
  const [models, setModels] = useState(state.model);
  const [timeout, setTimeoutMs] = useState(45000);
  const [tokens, setTokens] = useState(32);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [queued, setQueued] = useState(false);
  useEffect(() => {
    void Promise.all([send('providers.list'), send('providers.saved')]).catch((error: unknown) =>
      setError(String(error)),
    );
  }, [send]);
  const runs = Object.values(state.providerTests);
  const run = selected ? state.providerTests[selected] : runs.at(-1);
  const busy = queued || Boolean(run && !run.complete);
  useEffect(() => {
    if (selected && state.providerTests[selected]) setQueued(false);
  }, [selected, state.providerTests]);
  useEffect(() => {
    if (!queued) return;
    const timer = setTimeout(() => {
      setQueued(false);
      setError(t('providerTests.noAck'));
    }, 15000);
    return () => clearTimeout(timer);
  }, [queued, t]);
  const start = async () => {
    setError('');
    const ids = [
      ...new Set(
        models
          .split(/[\n,]/)
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ];
    if (!provider || !ids.length || ids.length > 200) {
      setError(t('providerTests.invalid'));
      return;
    }
    const requestId = crypto.randomUUID();
    setSelected(requestId);
    setQueued(true);
    try {
      await send('provider.test.run', {
        requestId,
        providerId: provider,
        modelIds: ids,
        timeoutMs: timeout,
        maxTokens: tokens,
      });
    } catch (error) {
      setQueued(false);
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <section className="feature-editor provider-test-workspace">
      <h3>{t('providerTests.title')}</h3>
      <p>{t('providerTests.intro')}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <div className="feature-field-grid">
          <label>
            {t('providerTests.provider')}
            <select
              aria-label={t('providerTests.providerLabel')}
              required
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
            >
              <option value="">{t('providerTests.choose')}</option>
              {providerChoices(state)
                .filter((item) => item.saved)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            {t('providerTests.timeout')}
            <input
              aria-label={t('providerTests.timeoutLabel')}
              type="number"
              min={1}
              max={120}
              value={timeout / 1000}
              onChange={(event) => setTimeoutMs(Number(event.target.value) * 1000)}
            />
          </label>
          <label>
            {t('providerTests.tokens')}
            <input
              aria-label={t('providerTests.tokensLabel')}
              type="number"
              min={1}
              max={4096}
              value={tokens}
              onChange={(event) => setTokens(Number(event.target.value))}
            />
          </label>
        </div>
        <label>
          {t('providerTests.models')}
          <textarea
            aria-label={t('providerTests.modelsLabel')}
            required
            rows={3}
            value={models}
            onChange={(event) => setModels(event.target.value)}
            placeholder={t('providerTests.modelsPlaceholder')}
          />
        </label>
        {error && (
          <p className="session-error" role="alert">
            {error}
          </p>
        )}
        <div className="feature-actions">
          <button type="submit" className="button primary" disabled={busy || !state.connected}>
            <FlaskConical size={13} />
            {t('providerTests.start')}
          </button>
          {busy && run && (
            <button
              type="button"
              className="button secondary"
              onClick={() =>
                void send('provider.test.cancel', { requestId: run.id }).catch((error: unknown) =>
                  setError(String(error)),
                )
              }
            >
              <Square size={13} />
              {t('providerTests.stop')}
            </button>
          )}
        </div>
      </form>
      {runs.length > 0 && (
        <label>
          {t('providerTests.run')}
          <select
            aria-label={t('providerTests.runLabel')}
            value={run?.id ?? ''}
            onChange={(event) => setSelected(event.target.value)}
          >
            {[...runs].reverse().map((item) => (
              <option value={item.id} key={item.id}>
                {item.provider} · {Object.keys(item.results).length}/{item.total} ·{' '}
                {item.complete ? t('providerTests.finishedShort') : t('providerTests.runningShort')}
              </option>
            ))}
          </select>
        </label>
      )}
      {run && (
        <>
          <p role="status">
            {run.complete
              ? t('providerTests.finished', {
                  passed: run.complete['passed'] ?? 0,
                  failed: run.complete['failed'] ?? 0,
                  cancelled: run.complete['cancelled'] ?? 0,
                })
              : t('providerTests.testing', {
                  count: run.total,
                  done: Object.keys(run.results).length,
                })}
          </p>
          {run.complete?.['error'] && (
            <p className="session-error">{String(run.complete['error'])}</p>
          )}
          <div className="provider-test-table">
            <table>
              <thead>
                <tr>
                  <th>{t('providerTests.model')}</th>
                  <th>{t('providerTests.status')}</th>
                  <th>{t('providerTests.latency')}</th>
                  <th>{t('providerTests.details')}</th>
                </tr>
              </thead>
              <tbody>
                {Object.values(run.results).map((item) => (
                  <tr key={String(item['modelId'])}>
                    <td>{String(item['modelId'])}</td>
                    <td>
                      {t(`providerTests.result.${String(item['status'])}`, {
                        defaultValue: String(item['status']),
                      })}
                    </td>
                    <td>{String(item['latencyMs'] ?? '—')} ms</td>
                    <td>{String(item['error'] ?? item['diagnosis'] ?? '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
