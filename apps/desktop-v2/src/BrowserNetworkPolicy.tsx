import { Globe } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { record } from './engine-values';
import './brain-policy.css';

/** Allowed private origins and the setup line from a `browser.policy.result` message. */
export function browserPolicyState(message: string): { setup: string; origins: string[] } {
  const line = /Allowed private origins: (.*?)\.?$/m.exec(message)?.[1] ?? '';
  return {
    setup: message.split('\n')[0] ?? '',
    origins: line === '(none)' ? [] : line.split(', ').filter(Boolean),
  };
}

/**
 * Which private network origins (a local dev server, loopback ports) the agent's browser,
 * fetch and URL reads may reach in this project (`browser.policy`, the `/browser` command).
 * Changes are saved in the project's policy file and apply immediately.
 */
export function BrowserNetworkPolicy({ command }: { command: EngineCommand }) {
  const [state, setState] = useState<{ setup: string; origins: string[] } | null>(null),
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
          setNotice(message);
          if (message.includes('Allowed private origins')) {
            const { origins } = browserPolicyState(message);
            setState((current) => ({ setup: current?.setup ?? '', origins }));
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
    [command],
  );
  useEffect(() => {
    void run('', 'status');
  }, [run]);
  return (
    <section className="brain-decisions" aria-label="Browser and network access">
      <h3>
        <Globe size={14} /> Browser and network access
      </h3>
      <p className="field-help">
        Private origins (a local dev server, loopback ports) the agent's browser, fetch and URL
        reads may reach in this project. Public sites are not affected.
      </p>
      {state && <p>{state.setup}</p>}
      {state && state.origins.length === 0 && <p>No private origins are allowed.</p>}
      {state && state.origins.length > 0 && (
        <ol className="brain-decision-log">
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
                  Remove
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
          Allow an origin
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
            Allow
          </button>
          <button
            type="button"
            className="button secondary small"
            disabled={Boolean(busy)}
            onClick={() => void run('allow loopback')}
          >
            Allow every loopback port
          </button>
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
            {busy === 'install' ? 'Installing Chromium…' : 'Install Chromium'}
          </button>
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
