import { Globe } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { record } from './engine-values';
import './brain-policy.css';

type BrowserPolicyState = {
  setup: string;
  /** Chromium ready, missing, or another line to show as it is. */
  kind: 'ready' | 'missing' | 'other';
  origins: string[];
};
/** Allowed private origins and the setup line from a `browser.policy.result` message. */
export function browserPolicyState(message: string): BrowserPolicyState {
  const line = /Allowed private origins: (.*?)\.?$/m.exec(message)?.[1] ?? '';
  const setup = message.split('\n')[0] ?? '';
  return {
    setup,
    kind: /^Playwright Chromium is available/.test(setup)
      ? 'ready'
      : /^Chromium is missing/.test(setup)
        ? 'missing'
        : 'other',
    origins: line === '(none)' ? [] : line.split(', ').filter(Boolean),
  };
}

/**
 * Which private network origins (a local dev server, loopback ports) the agent's browser,
 * fetch and URL reads may reach in this project (`browser.policy`, the `/browser` command).
 * Changes are saved in the project's policy file and apply immediately.
 */
export function BrowserNetworkPolicy({ command }: { command: EngineCommand }) {
  const { t } = useDesktopText();
  const [state, setState] = useState<BrowserPolicyState | null>(null),
    [origin, setOrigin] = useState(''),
    [busy, setBusy] = useState(''),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const run = useCallback(
    async (args: string, label = args) => {
      setBusy(label);
      setError('');
      try {
        const message = String(
          record(
            await command('browser.policy', { args }, ['browser.policy.result'], {
              // Installing Chromium downloads a browser.
              timeoutMs: args === 'install' ? 600_000 : 15_000,
            }),
          )['message'] ?? '',
        );
        if (!args) setState(browserPolicyState(message));
        else {
          setNotice(
            message.startsWith('Chromium installed and ready')
              ? t('networkPolicy.installed')
              : message.startsWith('Network project policy saved')
                ? t('networkPolicy.saved')
                : message,
          );
          if (message.includes('Allowed private origins')) {
            const { origins } = browserPolicyState(message);
            setState((current) => ({
              setup: current?.setup ?? '',
              kind: current?.kind ?? 'other',
              origins,
            }));
          }
        }
        return true;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        return false;
      } finally {
        setBusy('');
      }
    },
    [command, t],
  );
  const setup = state?.kind ?? null;
  useEffect(() => {
    void run('', 'status');
  }, [run]);
  return (
    <section className="brain-decisions" aria-label={t('networkPolicy.title')}>
      <h3>
        <Globe size={14} /> {t('networkPolicy.title')}
      </h3>
      <p className="field-help">{t('networkPolicy.intro')}</p>
      {state && (
        <p>
          {setup === 'ready'
            ? t('networkPolicy.ready')
            : setup === 'missing'
              ? t('networkPolicy.missing')
              : state.setup}
        </p>
      )}
      {state && state.origins.length === 0 && <p>{t('networkPolicy.none')}</p>}
      {state && state.origins.length > 0 && (
        <ol className="brain-decision-log network-origin-list">
          {state.origins.map((item) => (
            <li key={item}>
              <code>{item}</code>
              <span className="jev-actions">
                <button
                  type="button"
                  className="button secondary small"
                  disabled={Boolean(busy)}
                  onClick={() => void run(`remove ${item}`)}
                >
                  {t('networkPolicy.remove')}
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
      <form
        className="brain-ask"
        onSubmit={(event) => {
          event.preventDefault();
          const value = origin.trim();
          if (!value || /\s/.test(value)) return;
          void run(`allow ${value}`).then((ok) => {
            if (ok) setOrigin('');
          });
        }}
      >
        <label>
          {t('networkPolicy.allowOrigin')}
          <input
            value={origin}
            disabled={Boolean(busy)}
            placeholder="http://localhost:3000"
            onChange={(event) => setOrigin(event.target.value)}
          />
        </label>
        <span className="jev-actions">
          <button
            type="submit"
            className="button primary small"
            disabled={Boolean(busy) || !origin.trim() || /\s/.test(origin.trim())}
          >
            {t('networkPolicy.allow')}
          </button>
          <button
            type="button"
            className="button secondary small"
            disabled={Boolean(busy)}
            onClick={() => void run('allow loopback')}
          >
            {t('networkPolicy.loopback')}
          </button>
          {setup && setup !== 'ready' && (
            <button
              type="button"
              className="button secondary small"
              disabled={Boolean(busy)}
              onClick={() =>
                void run('install', 'install').then((ok) => {
                  if (ok) void run('', 'status');
                })
              }
            >
              {busy === 'install' ? t('networkPolicy.installing') : t('networkPolicy.install')}
            </button>
          )}
        </span>
      </form>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
    </section>
  );
}
