import { useEffect, useRef, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { safeId } from '@/lib/utils';
import { useUIStore } from '@/stores';
import type { JevSettings, JevState } from '@/types/jev';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ModelTiersSection } from './ModelTiersSection';

export function JevSection({
  syncPref,
}: {
  syncPref?: (key: string, value: unknown) => void;
} = {}) {
  const { client } = useWebSocket();
  const { t } = useAppTranslation();
  const [state, setState] = useState<JevState>({});
  const [form, setForm] = useState<JevSettings>();
  const [key, setKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [includeChecks, setIncludeChecks] = useState(false);
  const checking = useRef(false);
  const prefix = useRef(safeId());
  const pending = useRef<string | undefined>(undefined);
  const initialRoute = useRef('');
  const saving = useRef(false);
  useEffect(() => {
    const off = client.on('jev.state', (msg) => {
      const next = msg.payload as JevState;
      if (!next.requestId?.startsWith(prefix.current)) return;
      const completed = next.requestId === pending.current;
      const saved = completed && saving.current && !next.error;
      setState((old) => ({
        ...next,
        message: completed ? next.message : old.message,
        error: completed ? next.error : (next.error ?? old.error),
      }));
      if (next.settings) {
        const settings = next.settings;
        setForm((old) => {
          if (old && !saved) return old;
          initialRoute.current = settings.route;
          return settings;
        });
      }
      if (next.requestId === pending.current) {
        pending.current = undefined;
        setBusy(false);
        if (saved) {
          setKey('');
          setRemoveKey(false);
        }
      }
    });
    const refresh = () =>
      client.send({ type: 'jev.get', payload: { requestId: `${prefix.current}:poll` } });
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [client]);
  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(
      () => {
        pending.current = undefined;
        setBusy(false);
        setState((old) => ({ ...old, error: t('settings:jev.timeout') }));
      },
      checking.current ? 70000 : 15000,
    );
    return () => clearTimeout(timer);
  }, [busy, t]);
  const send = (type: 'jev.set' | 'jev.test' | 'jev.check') => {
    if (!form) return;
    const requestId = `${prefix.current}:${safeId()}`;
    pending.current = requestId;
    saving.current = type === 'jev.set';
    checking.current = type === 'jev.check';
    setBusy(true);
    if (type !== 'jev.set') client.send({ type, payload: { requestId } });
    else
      client.send({
        type,
        payload: {
          requestId,
          patch: {
            enabled: form.enabled === true,
            route: form.route,
            endpoint: form.endpoint.trim() || null,
            model: form.model.trim() || null,
            requestTimeoutMs: form.requestTimeoutMs,
            logContent: form.logContent === true,
            features: form.features,
            ...(form.recallTurnContext !== undefined &&
            form.recallTurnContext !== state.settings?.recallTurnContext
              ? { recallTurnContext: form.recallTurnContext }
              : {}),
            ...(form.contextStrategy && form.contextStrategy !== state.settings?.contextStrategy
              ? { contextStrategy: form.contextStrategy }
              : {}),
            ...(key.trim() ? { apiKey: key.trim() } : removeKey ? { apiKey: null } : {}),
          },
        },
      });
  };
  const entries =
    state.activity?.entries.filter(
      (entry) =>
        (!filter || entry.feature === filter) && (includeChecks || entry.purpose !== 'self-test'),
    ) ?? [];
  return (
    <div className="space-y-5 min-w-0">
      <div>
        <h3 className="font-semibold">TypeSafe / Jev</h3>
        <p className="text-sm text-muted-foreground">{t('settings:jev.description')}</p>
      </div>
      <p role="status" className="text-sm break-words">
        {state.settings
          ? `${t(`settings:jev.account.${state.settings.status}`)} · ${t(
              `settings:jev.keySource.${state.settings.keySource}`,
              { defaultValue: state.settings.keySource },
            )}`
          : t('settings:jev.loading')}{' '}
        {state.settings?.reason}
      </p>
      {(state.error || state.message) && (
        <p role="status" className="text-sm break-words">
          {state.error ?? state.message}
        </p>
      )}
      {form && (
        <fieldset disabled={busy} className="space-y-3 min-w-0">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={form.enabled === true}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            {t('settings:jev.enabled')}
          </label>
          <p className="text-xs text-muted-foreground">{t('settings:jev.enabledHint')}</p>
          <label className="block text-sm">
            {t('settings:jev.route')}
            <select
              className="mt-1 block w-full rounded border bg-background p-2"
              value={form.route}
              onChange={(e) => {
                setForm({ ...form, route: e.target.value, endpoint: '', model: '' });
                setKey('');
              }}
            >
              <option value="typesafe">TypeSafe</option>
              <option value="openrouter">OpenRouter Decisions</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          {form.route !== initialRoute.current && (
            <p className="text-xs text-muted-foreground">{t('settings:jev.routeChange')}</p>
          )}
          <label htmlFor="jev-key" className="block text-sm">
            {t('settings:jev.key')}
            <Input
              id="jev-key"
              type="password"
              autoComplete="new-password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={t('settings:jev.keyHint')}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={removeKey}
              onChange={(e) => setRemoveKey(e.target.checked)}
            />
            {t('settings:jev.removeKey')}
          </label>
          <label htmlFor="jev-endpoint" className="block text-sm">
            {t('settings:jev.endpoint')}
            <Input
              id="jev-endpoint"
              value={form.endpoint}
              onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
              placeholder={t('settings:jev.defaultHint')}
            />
          </label>
          <label htmlFor="jev-model" className="block text-sm">
            {t('settings:jev.model')}
            <Input
              id="jev-model"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              placeholder={t('settings:jev.defaultHint')}
            />
          </label>
          <label htmlFor="jev-requestTimeout" className="block text-sm">
            {t('settings:jev.requestTimeout')}
            <Input
              id="jev-requestTimeout"
              type="number"
              min={100}
              max={120000}
              value={form.requestTimeoutMs}
              onChange={(e) => setForm({ ...form, requestTimeoutMs: Number(e.target.value) })}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.logContent === true}
              onChange={(e) => setForm({ ...form, logContent: e.target.checked })}
            />
            {t('settings:jev.logContent')}
          </label>
          <p className="text-xs text-muted-foreground">{t('settings:jev.logContentHint')}</p>
          <p className="text-xs text-muted-foreground">{t('settings:jev.featureHint')}</p>
          <p className="text-xs text-muted-foreground">{t('settings:jev.readinessScope')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {Object.entries(form.features).map(([feature, enabled]) => {
              const readiness = state.settings?.readiness?.[feature];
              const latest = state.activity?.entries.find(
                (entry) => entry.feature === feature && entry.purpose !== 'self-test',
              );
              const draft = enabled !== state.settings?.features[feature];
              return (
                <div
                  key={feature}
                  className="rounded-lg border p-3 space-y-2"
                  data-testid={`jev-feature-${feature}`}
                >
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          features: { ...form.features, [feature]: e.target.checked },
                        })
                      }
                    />
                    {t(`settings:jev.features.${feature}`)}
                  </label>
                  <p className="text-xs font-medium" role="status">
                    {draft
                      ? t('settings:jev.unsaved')
                      : readiness
                        ? t(`settings:jev.readiness.${readiness.state}`)
                        : t('settings:jev.unknownReadiness')}
                  </p>
                  {readiness && readiness.reason !== 'trigger-required' && (
                    <p className="text-xs text-muted-foreground">
                      {t(`settings:jev.reasons.${readiness.reason}`)}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t(`settings:jev.triggers.${feature}`)}
                  </p>
                  <p className="text-xs">
                    {latest
                      ? `${t('settings:jev.lastRequest')}: ${new Date(latest.at).toLocaleString()} · ${latest.outcome} · ${latest.durationMs} ms${latest.reason ? ` · ${latest.reason}` : ''}`
                      : t('settings:jev.notObserved')}
                  </p>
                </div>
              );
            })}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.recallTurnContext === true}
              onChange={(e) => setForm({ ...form, recallTurnContext: e.target.checked })}
            />
            {t('settings:jev.recallTurnContext')}
          </label>
          <p className="text-xs text-muted-foreground">{t('settings:jev.recallTurnHint')}</p>
          <label htmlFor="jev-context-strategy" className="block text-sm">
            {t('settings:jev.contextStrategy')}
            <select
              id="jev-context-strategy"
              className="mt-1 block w-full rounded border bg-background p-2"
              value={form.contextStrategy ?? 'hybrid'}
              onChange={(e) =>
                setForm({
                  ...form,
                  contextStrategy: e.target.value as JevSettings['contextStrategy'],
                })
              }
            >
              <option value="hybrid">Hybrid</option>
              <option value="intelligent">Intelligent</option>
              <option value="selective">Selective (Jev)</option>
            </select>
          </label>
          <p className="text-xs text-muted-foreground">{t('settings:jev.contextScope')}</p>
          <Button
            variant="outline"
            onClick={() => useUIStore.getState().setSettingsActiveTab('context')}
          >
            {t('settings:jev.openContext')}
          </Button>
          {syncPref ? (
            <details className="rounded border p-3">
              <summary className="cursor-pointer text-sm font-medium">
                {t('settings:jev.configureTiers')}
              </summary>
              <p className="my-3 text-xs text-muted-foreground">{t('settings:jev.tiersHint')}</p>
              <ModelTiersSection syncPref={syncPref} />
            </details>
          ) : (
            <Button
              variant="outline"
              onClick={() => useUIStore.getState().setSettingsActiveTab('routing')}
            >
              {t('settings:jev.configureTiers')}
            </Button>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => send('jev.set')}>{t('settings:jev.save')}</Button>
            <Button
              variant="outline"
              disabled={state.settings?.enabled !== true}
              onClick={() => send('jev.test')}
            >
              {t('settings:jev.test')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('settings:jev.testHint')}</p>
        </fieldset>
      )}
      <section className="space-y-3 border-t pt-4" aria-label={t('settings:jev.checkHeading')}>
        <h4 className="font-semibold">{t('settings:jev.checkHeading')}</h4>
        <p className="text-xs text-muted-foreground">{t('settings:jev.checkHint')}</p>
        <Button
          variant="outline"
          disabled={
            busy ||
            state.checks?.running ||
            !form ||
            state.settings?.enabled !== true ||
            state.settings?.status !== 'ready'
          }
          onClick={() => send('jev.check')}
        >
          {state.checks?.running || (busy && checking.current)
            ? t('settings:jev.checkRunning')
            : t('settings:jev.checkAll')}
        </Button>
        {state.checks?.report && (
          <div className="space-y-2" data-testid="jev-check-report">
            <p className="text-sm font-medium">
              {state.checks.report.passed}/{state.checks.report.total} · {state.checks.report.model}{' '}
              · {new Date(state.checks.report.at).toLocaleString()}
            </p>
            {state.checks.report.cases.map((result) => (
              <details
                key={`${result.feature}:${result.name}`}
                className="rounded border p-2 text-xs"
              >
                <summary className="cursor-pointer">
                  {result.ok ? '✓' : '✗'} {t(`settings:jev.features.${result.feature}`)} ·{' '}
                  {result.name} · {result.ms} ms
                </summary>
                <p>
                  {t('settings:jev.expected')}: {result.expected}
                </p>
                <p>
                  {t('settings:jev.actual')}: {result.actual}
                </p>
                {result.note && <p>{result.note}</p>}
              </details>
            ))}
          </div>
        )}
      </section>
      <div className="space-y-3 border-t pt-4">
        <h4 className="font-semibold">{t('settings:jev.activity')}</h4>
        <p className="text-xs text-muted-foreground">{t('settings:jev.activityHint')}</p>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={includeChecks}
            onChange={(e) => setIncludeChecks(e.target.checked)}
          />
          {t('settings:jev.includeChecks')}
        </label>
        {state.activity?.path && (
          <p className="break-all text-xs font-mono">{state.activity.path}</p>
        )}
        {/* The SAVED value, not the draft: the file below is written by this
            process, which read the switch when it built its client. */}
        <p className="text-xs text-muted-foreground" role="status">
          {state.settings?.logContent
            ? t('settings:jev.logContentOn')
            : t('settings:jev.logContentOff')}
        </p>
        {state.activity?.writeError && <p role="alert">{state.activity.writeError}</p>}
        <label className="block text-sm">
          {t('settings:jev.filter')}
          <select
            className="ml-2 rounded border bg-background p-1"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="">{t('settings:jev.all')}</option>
            {Object.keys(form?.features ?? {})
              .concat('connectionTest', 'evaluation')
              .map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
          </select>
        </label>
        {!entries.length && (
          <p className="text-sm text-muted-foreground">{t('settings:jev.empty')}</p>
        )}
        {entries.map((entry) => (
          <details key={entry.id} className="rounded border p-2 text-xs break-words">
            <summary className="cursor-pointer">
              {new Date(entry.at).toLocaleTimeString()} · {entry.feature} ·{' '}
              {entry.purpose === 'self-test' ? `${t('settings:jev.selfTest')} · ` : ''}
              {entry.outcome} · {entry.durationMs} ms
            </summary>
            <p className="mt-2">
              {entry.route} / {entry.model} · {entry.inputTokens ?? 0} in /{' '}
              {entry.outputTokens ?? 0} out
            </p>
            <p>{entry.project}</p>
            <p>{entry.reason}</p>
            <pre className="whitespace-pre-wrap break-all">
              {JSON.stringify(entry.answers ?? {}, null, 2)}
            </pre>
            <p>{entry.id}</p>
          </details>
        ))}
      </div>
    </div>
  );
}
