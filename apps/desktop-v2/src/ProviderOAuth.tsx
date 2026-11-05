import { useEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { CopyButton } from './CopyButton';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand, EngineSend } from './engine-operations';
import { entries } from './engine-values';
import { Modal } from './Modal';
import {
  acceptOAuthStatus,
  type OAuthAttempt,
  oauthActive,
  oauthAliasIssue,
  oauthUrl,
} from './oauth-model';
import { openExternal } from './platform';
import { surfaceI18n } from './surface-i18n';
import './provider-oauth.css';

export function ProviderOAuth({
  command,
  send,
  status,
}: {
  command: EngineCommand;
  send: EngineSend;
  status: Record<string, unknown> | undefined;
}) {
  const { t } = useDesktopText();
  const aliasWords = {
    invalid: t('providerSettings.oauth.aliasInvalid'),
    exists: t('providerSettings.oauth.aliasExists'),
  };
  const [strategies, setStrategies] = useState<Record<string, unknown>[] | null>(null),
    [saved, setSaved] = useState<Record<string, unknown>[]>([]);
  const [kind, setKind] = useState(''),
    [mode, setMode] = useState('default'),
    [alias, setAlias] = useState('');
  const [attempt, setAttempt] = useState<OAuthAttempt | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [review, setReview] = useState<string | null>(null),
    [paste, setPaste] = useState(false),
    [input, setInput] = useState('');
  const mounted = useRef(true),
    live = useRef<OAuthAttempt | null>(null),
    verified = useRef(''),
    operation = useRef(0);
  live.current = attempt;
  useEffect(() => {
    mounted.current = true;
    void Promise.all([
      command('auth.oauth.list', {}, ['auth.oauth.providers']),
      command('providers.saved', {}, ['providers.saved']),
    ])
      .then(([catalog, accounts]) => {
        if (!mounted.current) return;
        const values = entries(catalog['providers']);
        setStrategies(values);
        setKind(String(values[0]?.['id'] ?? ''));
        setSaved(entries(accounts['providers']));
      })
      .catch((error) => {
        if (!mounted.current) return;
        setStrategies([]);
        setError(String(error));
      });
    return () => {
      mounted.current = false;
      const current = live.current;
      if (oauthActive(current) && current)
        void send('auth.oauth.cancel', { kind: current.kind, attemptId: current.attemptId }).catch(
          () => {},
        );
    };
  }, [command, send]);
  useEffect(() => {
    if (status) setAttempt((current) => acceptOAuthStatus(current, status));
  }, [status]);
  useEffect(() => {
    if (attempt?.phase !== 'success' || verified.current === attempt.attemptId) return;
    verified.current = attempt.attemptId;
    const id = attempt.attemptId;
    void command('providers.saved', {}, ['providers.saved'])
      .then((reply) => {
        if (!mounted.current || live.current?.attemptId !== id) return;
        const accounts = entries(reply['providers']);
        setSaved(accounts);
        const account = accounts.find((item) => item['id'] === attempt['providerId']);
        if (!account || !entries(account['apiKeys']).some((key) => key['authMethod'] === 'oauth'))
          throw Error(t('providerSettings.oauth.unverified'));
        setNotice(t('providerSettings.oauth.signedIn', { account: account['id'] }));
        void send('providers.saved').catch(() => {});
      })
      .catch((error) => {
        if (mounted.current && live.current?.attemptId === id) setError(String(error));
      });
  }, [attempt, command, send, t]);
  const strategy = strategies?.find((item) => item['id'] === kind),
    active = oauthActive(attempt);
  const target = mode === 'default' ? String(strategy?.['providerId'] ?? '') : alias.trim();
  const start = async () => {
    const account = review;
    if (!account || busy) return;
    const action = ++operation.current;
    setBusy(true);
    setReview(null);
    setError('');
    setNotice('');
    setInput('');
    setPaste(false);
    const current: OAuthAttempt = { kind, attemptId: crypto.randomUUID(), phase: 'starting' };
    live.current = current;
    setAttempt(current);
    try {
      const accounts = entries(
        (await command('providers.saved', {}, ['providers.saved']))['providers'],
      );
      const issue = oauthAliasIssue(
        account,
        accounts.map((item) => String(item['id'])),
        mode === 'new',
        aliasWords,
      );
      if (issue) throw Error(issue);
      if (!mounted.current || operation.current !== action) return;
      const reply = await command(
        'auth.oauth.start',
        { kind, providerId: account, attemptId: current.attemptId },
        ['auth.oauth.status'],
        { timeoutMs: 90000 },
      );
      if (mounted.current && operation.current === action)
        setAttempt((value) => acceptOAuthStatus(value, reply));
    } catch (error) {
      void send('auth.oauth.cancel', { kind, attemptId: current.attemptId }).catch(() => {});
      if (mounted.current && operation.current === action) {
        setAttempt({ ...current, phase: 'error' });
        setError(String(error));
      }
    } finally {
      if (mounted.current && operation.current === action) setBusy(false);
    }
  };
  const cancel = async () => {
    if (!attempt || attempt.phase === 'fetching_models') return;
    const action = ++operation.current;
    setBusy(true);
    setInput('');
    try {
      await command('auth.oauth.cancel', { kind: attempt.kind, attemptId: attempt.attemptId }, [
        'auth.oauth.status',
      ]);
      if (mounted.current && operation.current === action) {
        setAttempt({ ...attempt, phase: 'cancelled' });
        setNotice(t('providerSettings.oauth.cancelledNotice'));
      }
    } catch (error) {
      if (mounted.current && operation.current === action) setError(String(error));
    } finally {
      if (mounted.current && operation.current === action) setBusy(false);
    }
  };
  const submitCode = async () => {
    if (!attempt || !input.trim() || busy) return;
    const action = ++operation.current;
    const value = input.trim();
    setInput('');
    setBusy(true);
    setError('');
    try {
      const reply = await command(
        'auth.oauth.code',
        { kind: attempt.kind, attemptId: attempt.attemptId, input: value },
        ['auth.oauth.status'],
        { timeoutMs: 90000 },
      );
      if (mounted.current && operation.current === action)
        setAttempt((current) => acceptOAuthStatus(current, reply));
    } catch (error) {
      if (mounted.current && operation.current === action) setError(String(error));
    } finally {
      if (mounted.current && operation.current === action) setBusy(false);
    }
  };
  const link = oauthUrl(attempt?.['authorizeUrl'] ?? attempt?.['verificationUri']);
  return (
    <section className="provider-oauth" aria-label={t('providerSettings.oauth.label')}>
      <header>
        <span className="eyebrow">{t('providerSettings.oauth.eyebrow')}</span>
        <h3>{t('providerSettings.oauth.title')}</h3>
        <p>{t('providerSettings.oauth.intro')}</p>
      </header>
      <div className="oauth-controls">
        <label>
          {t('providerSettings.oauth.service')}
          <select
            aria-label={t('providerSettings.oauth.serviceLabel')}
            value={kind}
            disabled={active || busy}
            onChange={(event) => {
              setKind(event.target.value);
              setAlias('');
              setError('');
            }}
          >
            {!strategies?.length && (
              <option value="">
                {strategies
                  ? t('providerSettings.oauth.noServices')
                  : t('providerSettings.oauth.loadingServices')}
              </option>
            )}
            {strategies?.map((item) => (
              <option key={String(item['id'])} value={String(item['id'])}>
                {String(item['label'])}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('providerSettings.oauth.connection')}
          <select
            aria-label={t('providerSettings.oauth.connectionLabel')}
            value={mode}
            disabled={active || busy}
            onChange={(event) => {
              setMode(event.target.value);
              setAlias('');
            }}
          >
            <option value="default">{t('providerSettings.oauth.mode.default')}</option>
            <option value="new">{t('providerSettings.oauth.mode.new')}</option>
            <option value="existing">{t('providerSettings.oauth.mode.existing')}</option>
          </select>
        </label>
        {mode === 'new' && (
          <label>
            {t('providerSettings.oauth.accountName')}
            <input
              aria-label={t('providerSettings.oauth.accountNameLabel')}
              value={alias}
              maxLength={80}
              disabled={active || busy}
              onChange={(event) => setAlias(event.target.value)}
              placeholder="work-account"
            />
          </label>
        )}
        {mode === 'existing' && (
          <label>
            {t('providerSettings.oauth.savedAccount')}
            <select
              aria-label={t('providerSettings.oauth.savedAccountLabel')}
              value={alias}
              disabled={active || busy}
              onChange={(event) => setAlias(event.target.value)}
            >
              <option value="">{t('providerSettings.oauth.chooseAccount')}</option>
              {saved
                .filter((item) =>
                  entries(item['apiKeys']).some((key) => key['authMethod'] === 'oauth'),
                )
                .map((item) => (
                  <option key={String(item['id'])}>{String(item['id'])}</option>
                ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="button primary"
          disabled={!strategy || active || busy}
          onClick={() => {
            const issue = oauthAliasIssue(
              target,
              saved.map((item) => String(item['id'])),
              mode === 'new',
              aliasWords,
            );
            setError(issue ?? '');
            if (!issue) setReview(target);
          }}
        >
          {t('providerSettings.oauth.start')}
        </button>
      </div>
      {typeof strategy?.['description'] === 'string' && (
        <p className="field-help">{strategy['description']}</p>
      )}
      {Array.isArray(strategy?.['notes']) && (
        <details>
          <summary>{t('providerSettings.oauth.guidance')}</summary>
          {strategy['notes'].map((note, index) => (
            <p key={index}>{String(note)}</p>
          ))}
        </details>
      )}
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="studio-notice" role="status">
          {notice}
        </p>
      )}
      {attempt && (
        <section className="oauth-progress" aria-label={t('providerSettings.oauth.progress')}>
          <p role="status">{t(`providerSettings.oauth.phase.${attempt.phase}`)}</p>
          {attempt.phase === 'error' && (
            <p role="alert">{String(attempt['message'] ?? t('providerSettings.oauth.retry'))}</p>
          )}
          {active && link && (
            <button
              type="button"
              className="button secondary"
              onClick={() => void openExternal(link).catch((error) => setError(String(error)))}
            >
              {t('providerSettings.oauth.openWebsite')}
            </button>
          )}
          {active && typeof attempt['userCode'] === 'string' && (
            <div className="oauth-device-code">
              <strong>{attempt['userCode']}</strong>
              <CopyButton text={attempt['userCode']} label={t('providerSettings.oauth.copyCode')} />
            </div>
          )}
          {attempt.phase === 'awaiting_browser' && (
            <>
              <button
                type="button"
                className="button secondary"
                onClick={() => setPaste((value) => !value)}
              >
                {t('providerSettings.oauth.paste')}
              </button>
              {paste && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitCode();
                  }}
                >
                  <label>
                    {t('providerSettings.oauth.callback')}
                    <input
                      type="password"
                      autoComplete="off"
                      aria-label={t('providerSettings.oauth.callbackLabel')}
                      value={input}
                      onChange={(event) => setInput(event.target.value)}
                    />
                  </label>
                  <p className="field-help">{t('providerSettings.oauth.callbackHint')}</p>
                  <button type="submit" className="button primary" disabled={busy || !input.trim()}>
                    {t('providerSettings.oauth.complete')}
                  </button>
                </form>
              )}
            </>
          )}
          {active && (
            <button
              type="button"
              className="button secondary"
              disabled={attempt.phase === 'fetching_models'}
              onClick={() => void cancel()}
            >
              {t('providerSettings.oauth.cancel')}
            </button>
          )}
        </section>
      )}
      <p className="field-help">{t('providerSettings.oauth.removeHint')}</p>
      {review && (
        <Modal onClose={() => setReview(null)}>
          <h2 id="dialog-title">{t('providerSettings.oauth.reviewTitle')}</h2>
          <p>
            <Trans
              i18n={surfaceI18n}
              ns="desktop"
              i18nKey="providerSettings.oauth.saveTo"
              values={{ account: review }}
              components={{ strong: <strong /> }}
            />
          </p>
          <p>
            {saved.some((item) => item['id'] === review)
              ? t('providerSettings.oauth.updates')
              : t('providerSettings.oauth.creates')}
          </p>
          <div className="modal-actions">
            <button type="button" className="button secondary" onClick={() => setReview(null)}>
              {t('providerSettings.oauth.keep')}
            </button>
            <button type="button" className="button primary" onClick={() => void start()}>
              {t('providerSettings.oauth.begin')}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
