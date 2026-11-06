import { useCallback, useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import './brain-policy.css';
import { displayTime } from './display-dates';

export const JEV_FEATURE_NAMES: Record<string, string> = {
  tool: 'Tool-call risk',
  brain: 'Brain decisions',
  memoryTriage: 'Memory triage',
  topicShift: 'Topic shift',
  memoryRecall: 'Memory recall',
  compaction: 'Compaction',
  kanbanVerify: 'Kanban verification',
  modelTier: 'Model tier',
  semanticLint: 'Semantic lint',
  skillSuggestion: 'Skill suggestions',
  fleetDispatch: 'Fleet dispatch',
};

export interface JevState {
  enabled: boolean;
  status: string;
  reason: string;
  route: string;
  model: string;
  endpoint: string;
  requestTimeoutMs: number;
  keySource: 'config' | 'env' | 'none';
  features: Record<string, boolean>;
  readiness: Record<string, { state: string; reason: string }>;
  logContent: boolean;
  checks: {
    running: boolean;
    report: {
      passed: number;
      total: number;
      model: string;
      cases: { feature: string; name: string; ok: boolean; expected: string; actual: string }[];
    } | null;
  };
  activity: { at: number; feature: string; outcome: string; durationMs: number; reason: string }[];
  message: string;
}

/** The engine's `jev.state` (no secret values are sent). */
export function jevState(value: unknown): JevState {
  const reply = record(value);
  const settings = record(reply['settings']);
  const checks = record(reply['checks']);
  const report = record(checks['report']);
  return {
    enabled: settings['enabled'] === true,
    status: String(settings['status'] ?? 'unknown'),
    reason: typeof settings['reason'] === 'string' ? settings['reason'] : '',
    route: String(settings['route'] ?? 'typesafe'),
    model: String(settings['model'] ?? ''),
    endpoint: String(settings['endpoint'] ?? ''),
    requestTimeoutMs:
      typeof settings['requestTimeoutMs'] === 'number' ? settings['requestTimeoutMs'] : 4000,
    keySource:
      settings['keySource'] === 'config' || settings['keySource'] === 'env'
        ? settings['keySource']
        : 'none',
    features: Object.fromEntries(
      Object.entries(record(settings['features'])).map(([key, on]) => [key, on === true]),
    ),
    readiness: Object.fromEntries(
      Object.entries(record(settings['readiness'])).map(([key, item]) => [
        key,
        {
          state: String(record(item)['state'] ?? ''),
          reason: String(record(item)['reason'] ?? ''),
        },
      ]),
    ),
    logContent: settings['logContent'] === true,
    checks: {
      running: checks['running'] === true,
      report:
        typeof report['total'] === 'number'
          ? {
              passed: Number(report['passed'] ?? 0),
              total: report['total'],
              model: String(report['model'] ?? ''),
              cases: entries(report['cases']).map((item) => ({
                feature: String(item['feature'] ?? ''),
                name: String(item['name'] ?? ''),
                ok: item['ok'] === true,
                expected: String(item['expected'] ?? ''),
                actual: String(item['actual'] ?? ''),
              })),
            }
          : null,
    },
    activity: entries(record(reply['activity'])['entries'])
      .slice(0, 20)
      .map((item) => ({
        at: typeof item['at'] === 'number' ? item['at'] : 0,
        feature: String(item['feature'] ?? ''),
        outcome: String(item['outcome'] ?? ''),
        durationMs: typeof item['durationMs'] === 'number' ? item['durationMs'] : 0,
        reason: typeof item['reason'] === 'string' ? item['reason'] : '',
      })),
    message: typeof reply['message'] === 'string' ? reply['message'] : '',
  };
}

/**
 * Jev (TypeSafe System One) settings: the account route, key, model, timeout and which
 * judgments use it, with a connection test and an account check of the judgments. Keys are
 * written to the profile's encrypted configuration and never sent back to this window.
 */
export function JevSettings({ command }: { command: EngineCommand }) {
  const { t } = useDesktopText();
  const feature = (id: string) =>
    t(`jevSettings.feature.${id}`, { defaultValue: JEV_FEATURE_NAMES[id] ?? id });
  const [state, setState] = useState<JevState | null>(null),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [apiKey, setApiKey] = useState(''),
    [model, setModel] = useState(''),
    [endpoint, setEndpoint] = useState(''),
    [timeout, setTimeoutMs] = useState('');
  const call = useCallback(
    async (type: string, payload: Record<string, unknown> = {}, label = type) => {
      setBusy(label);
      setError('');
      try {
        const next = jevState(await command(type, payload, ['jev.state']));
        setState(next);
        setModel(next.model);
        setEndpoint(next.endpoint);
        setTimeoutMs(String(next.requestTimeoutMs));
        return next;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        return null;
      } finally {
        setBusy('');
      }
    },
    [command],
  );
  useEffect(() => {
    void call('jev.get');
  }, [call]);
  if (!state)
    return (
      <section className="brain-decisions" aria-label={t('jevSettings.label')}>
        <h3>{t('jevSettings.title')}</h3>
        {error ? (
          <p className="session-error">{error}</p>
        ) : (
          <p role="status">{t('jevSettings.reading')}</p>
        )}
      </section>
    );
  const save = (patch: Record<string, unknown>) =>
    void call('jev.set', { patch }, 'save').then((next) => {
      if (next && 'apiKey' in patch) setApiKey('');
    });
  return (
    <section className="brain-decisions jev-settings" aria-label={t('jevSettings.label')}>
      <h3>{t('jevSettings.title')}</h3>
      <p className="field-help">{t('jevSettings.intro')}</p>
      <label className="jev-toggle">
        <input
          type="checkbox"
          checked={state.enabled}
          disabled={Boolean(busy)}
          onChange={(event) => save({ enabled: event.target.checked })}
        />
        {t('jevSettings.use')}
      </label>
      <p>
        {t(`jevSettings.status.${state.status}`, {
          defaultValue: t('jevSettings.account', { status: state.status }),
        })}
        {state.reason ? ` · ${state.reason}` : ''} · {t(`jevSettings.key.${state.keySource}`)}
      </p>
      <div className="jev-grid">
        <label>
          {t('jevSettings.route')}
          <select
            value={state.route}
            disabled={Boolean(busy)}
            onChange={(event) => save({ route: event.target.value })}
          >
            <option value="typesafe">TypeSafe</option>
            <option value="openrouter">OpenRouter</option>
            <option value="custom">{t('jevSettings.customEndpoint')}</option>
          </select>
        </label>
        <label>
          {t('jevSettings.model')}
          <input value={model} onChange={(event) => setModel(event.target.value)} />
        </label>
        {state.route === 'custom' && (
          <label>
            {t('jevSettings.endpoint')}
            <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} />
          </label>
        )}
        <label>
          {t('jevSettings.timeout')}
          <input
            type="number"
            min={100}
            max={120000}
            value={timeout}
            onChange={(event) => setTimeoutMs(event.target.value)}
          />
        </label>
        <label>
          {t('jevSettings.apiKey')} {state.keySource === 'config' ? t('jevSettings.replace') : ''}
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
      </div>
      <div className="jev-actions">
        <button
          type="button"
          className="button primary small"
          disabled={Boolean(busy)}
          onClick={() => {
            const ms = Number(timeout);
            if (!Number.isInteger(ms) || ms < 100 || ms > 120000) {
              setError(t('jevSettings.timeoutError'));
              return;
            }
            save({
              ...(model.trim() !== state.model ? { model: model.trim() || null } : {}),
              ...(state.route === 'custom' && endpoint.trim() !== state.endpoint
                ? { endpoint: endpoint.trim() || null }
                : {}),
              ...(ms !== state.requestTimeoutMs ? { requestTimeoutMs: ms } : {}),
              ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            });
          }}
        >
          {busy === 'save' ? t('jevSettings.saving') : t('jevSettings.save')}
        </button>
        {state.keySource === 'config' && (
          <button
            type="button"
            className="button secondary small"
            disabled={Boolean(busy)}
            onClick={() => save({ apiKey: null })}
          >
            {t('jevSettings.removeKey')}
          </button>
        )}
        <button
          type="button"
          className="button secondary small"
          disabled={Boolean(busy) || !state.enabled}
          onClick={() => void call('jev.test', {}, 'test')}
        >
          {busy === 'test' ? t('jevSettings.testing') : t('jevSettings.test')}
        </button>
        <button
          type="button"
          className="button secondary small"
          disabled={Boolean(busy) || !state.enabled || state.checks.running}
          onClick={() => void call('jev.check', {}, 'check')}
        >
          {busy === 'check' || state.checks.running
            ? t('jevSettings.checking')
            : t('jevSettings.check')}
        </button>
      </div>
      <fieldset className="jev-features">
        <legend>{t('jevSettings.judgments')}</legend>
        {Object.keys(state.features).map((id) => (
          <label key={id}>
            <input
              type="checkbox"
              checked={state.features[id] === true}
              disabled={Boolean(busy)}
              onChange={(event) => save({ features: { [id]: event.target.checked } })}
            />
            {feature(id)}
            {state.readiness[id]?.state && (
              <small> · {state.readiness[id]!.state.replace(/-/g, ' ')}</small>
            )}
          </label>
        ))}
      </fieldset>
      <label className="jev-toggle">
        <input
          type="checkbox"
          checked={state.logContent}
          disabled={Boolean(busy)}
          onChange={(event) => save({ logContent: event.target.checked })}
        />
        {t('jevSettings.logContent')}
      </label>
      {state.checks.report && (
        <details>
          <summary>
            {t('jevSettings.checkReport', {
              passed: state.checks.report.passed,
              total: state.checks.report.total,
            })}{' '}
            · {state.checks.report.model}
          </summary>
          <ul>
            {state.checks.report.cases.map((item) => (
              <li key={`${item.feature}:${item.name}`}>
                {item.ok ? t('jevSettings.passed') : t('jevSettings.failed')} ·{' '}
                {feature(item.feature)} · {item.name}
                {!item.ok &&
                  ` (${t('jevSettings.expected', { expected: item.expected, actual: item.actual })})`}
              </li>
            ))}
          </ul>
        </details>
      )}
      {state.activity.length > 0 && (
        <details>
          <summary>{t('jevSettings.activity')}</summary>
          <ul>
            {state.activity.map((item, index) => (
              <li key={`${item.at}:${index}`}>
                {item.at ? displayTime(item.at) : ''} · {feature(item.feature)} · {item.outcome} ·{' '}
                {item.durationMs} ms{item.reason ? ` · ${item.reason}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
      {state.message && <p role="status">{state.message}</p>}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
    </section>
  );
}
