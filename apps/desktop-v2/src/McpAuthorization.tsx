import { KeyRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import {
  type McpAuthStatus,
  mcpAuthScopes,
  mcpAuthStatus,
  mcpAuthSummary,
  safeAuthorizationUrl,
} from './mcp-auth-model';
import './mcp-connection.css';

/** Loaded on use: the platform bridge needs the desktop window. */
const openExternal = (url: string) =>
  import('./platform').then((platform) => platform.openExternal(url));

const POLL_MS = 2_000;
/** A browser sign-in is followed at most this long when the engine reports no expiry. */
const DEFAULT_WAIT_MS = 10 * 60_000;

/**
 * OAuth sign-in for a remote MCP connection through the engine's authorization manager. The
 * engine receives the redirect on its own loopback port; this panel opens the authorization
 * page and follows `mcp.auth.status` until the sign-in finishes, expires or the panel closes.
 * Tokens never reach this window.
 */
export function McpAuthorization({ name, command }: { name: string; command: EngineCommand }) {
  const { t } = useDesktopText();
  const [status, setStatus] = useState<McpAuthStatus | null>(null),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [waiting, setWaiting] = useState(false),
    [confirmOut, setConfirmOut] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [link, setLink] = useState(''),
    [clientId, setClientId] = useState(''),
    [scopes, setScopes] = useState('');
  const run = useRef(0);
  useEffect(
    () => () => {
      run.current++;
    },
    [],
  );
  const read = async () => {
    // A refusal (no authorization manager, not an HTTP server) arrives as an operation result.
    const reply = await command('mcp.auth.status', { name }, [
      'mcp.auth.status',
      'mcp.operation_result',
    ]);
    const parsed = mcpAuthStatus(reply);
    if (!parsed) throw Error(t('mcpAuth.unrecognized'));
    return parsed;
  };
  const refresh = async () => {
    setError('');
    try {
      setStatus(await read());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoaded(true);
    }
  };
  const signIn = async () => {
    const token = ++run.current;
    setBusy(true);
    setError('');
    setNotice('');
    setLink('');
    try {
      const requested = mcpAuthScopes(scopes);
      const pending = await command(
        'mcp.auth.login',
        {
          name,
          ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
          ...(requested.length ? { scopes: requested } : {}),
        },
        ['mcp.auth.pending', 'mcp.operation_result'],
      );
      const url = safeAuthorizationUrl(pending['authorizationUrl']);
      if (!url) throw Error(t('mcpAuth.notHttps'));
      setLink(url);
      await openExternal(url).catch(() => setNotice(t('mcpAuth.browserFailed')));
      setWaiting(true);
      const deadline =
        typeof pending['expiresAt'] === 'number'
          ? pending['expiresAt']
          : Date.now() + DEFAULT_WAIT_MS;
      while (run.current === token && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (run.current !== token) return;
        const current = await read();
        setStatus(current);
        if (current.state === 'authorized') {
          setNotice(t('mcpAuth.signedIn'));
          setLink('');
          return;
        }
        if (current.state !== 'pending') break;
      }
      if (run.current === token) setError(t('mcpAuth.notFinished'));
    } catch (failure) {
      if (run.current === token)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (run.current === token) {
        setBusy(false);
        setWaiting(false);
      }
    }
  };
  const signOut = async () => {
    run.current++;
    setBusy(true);
    setError('');
    setNotice('');
    setConfirmOut(false);
    try {
      const reply = await command('mcp.auth.logout', { name }, ['mcp.operation_result']);
      setNotice(String(reply['message'] ?? t('mcpAuth.removed')));
      setStatus(await read());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="mcp-authorization"
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open && !loaded) void refresh();
      }}
    >
      <summary>
        <KeyRound size={13} /> {t('mcpAuth.title')}
      </summary>
      {!loaded ? (
        <p role="status">{t('mcpAuth.reading')}</p>
      ) : status ? (
        <p>
          {mcpAuthSummary(status, Date.now(), (word, values) =>
            t(`mcpAuth.summary.${word}`, values ?? {}),
          )}
        </p>
      ) : null}
      {waiting && <p role="status">{t('mcpAuth.waiting')}</p>}
      {link && (
        <p className="field-help">
          {t('mcpAuth.page')}{' '}
          <button
            type="button"
            className="button secondary small"
            onClick={() => void openExternal(link).catch((e) => setError(String(e)))}
          >
            {t('mcpAuth.openAgain')}
          </button>
        </p>
      )}
      {loaded && (
        <>
          <details className="mcp-authorization-advanced">
            <summary>{t('mcpAuth.advanced')}</summary>
            <label>
              {t('mcpAuth.clientId')}
              <input
                value={clientId}
                disabled={busy}
                onChange={(event) => setClientId(event.target.value)}
              />
            </label>
            <label>
              {t('mcpAuth.scopes')}
              <input
                value={scopes}
                disabled={busy}
                onChange={(event) => setScopes(event.target.value)}
              />
            </label>
          </details>
          <div className="mcp-authorization-actions">
            <button
              type="button"
              className="button primary small"
              disabled={busy}
              onClick={() => void signIn()}
            >
              {status?.state === 'authorized' ? t('mcpAuth.signInAgain') : t('mcpAuth.signIn')}
            </button>
            {waiting && (
              <button
                type="button"
                className="button secondary small"
                onClick={() => {
                  run.current++;
                  setBusy(false);
                  setWaiting(false);
                  setNotice(t('mcpAuth.stopped'));
                }}
              >
                {t('mcpAuth.stopWaiting')}
              </button>
            )}
            {status &&
              status.state !== 'not_authorized' &&
              !waiting &&
              (confirmOut ? (
                <>
                  <button
                    type="button"
                    className="button danger small"
                    disabled={busy}
                    onClick={() => void signOut()}
                  >
                    {t('mcpAuth.removeCredentials')}
                  </button>
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => setConfirmOut(false)}
                  >
                    {t('mcpAuth.keep')}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="button secondary small"
                  disabled={busy}
                  onClick={() => setConfirmOut(true)}
                >
                  {t('mcpAuth.signOut')}
                </button>
              ))}
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={() => void refresh()}
            >
              {t('mcpAuth.refresh')}
            </button>
          </div>
          {confirmOut && <p className="field-help">{t('mcpAuth.signOutHelp')}</p>}
        </>
      )}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}
