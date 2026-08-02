/**
 * Token gate — full-screen token/password entry shown when the HQ server runs
 * in browser-token or password mode and this tab has no (valid) credential.
 *
 * Before this screen existed, a token-less navigation got a bare JSON 401
 * (the shell itself was gated) and a wrong/expired token looked like an
 * endless "reconnecting…". The shell is now served publicly; every byte of
 * telemetry still flows through the gated `/api/*` + `/ws/*` channels.
 *
 * Submitting persists the token to sessionStorage (see `lib/auth.ts`) and
 * reloads so the WS singleton and all views restart authenticated. Password
 * login sets an HttpOnly session cookie on the server; the reload sends it
 * automatically for both HTTP and WebSocket requests.
 */
import { useEffect, useState } from 'react';
import { clearHqToken, setHqToken } from '../lib/auth.js';

interface AuthStatus {
  tokenMode: boolean;
  passwordMode: boolean;
  loggedIn: boolean;
}

export function TokenGate({ hadToken }: { hadToken: boolean }): React.ReactElement {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/status')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as AuthStatus;
      })
      .then(setStatus)
      .catch(() => setStatusError('Could not load HQ auth status.'));
  }, []);

  const showToken = status?.tokenMode ?? true;
  const showPassword = status?.passwordMode ?? false;
  const [tab, setTab] = useState<'token' | 'password'>('token');

  useEffect(() => {
    if (!status) return;
    // When both methods exist, prefer the human-friendly password flow.
    // Tokens remain available for operators and automation through the tab.
    setTab(status.passwordMode ? 'password' : 'token');
  }, [status]);

  if (statusError) {
    return (
      <div className="hq-token-gate">
        <div className="hq-token-card">
          <div className="hq-brand">WrongStack HQ</div>
          <div className="hq-token-title">Auth status unavailable</div>
          <p className="hq-token-text">{statusError}</p>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="hq-token-gate">
        <div className="hq-token-card">
          <div className="hq-brand">WrongStack HQ</div>
          <div className="hq-token-title">Checking auth mode…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="hq-token-gate">
      <div className="hq-token-card">
        <div className="hq-brand">WrongStack HQ</div>
        {showToken && showPassword ? (
          <div className="hq-token-tabs">
            <button
              type="button"
              className={'hq-token-tab' + (tab === 'token' ? ' active' : '')}
              onClick={() => setTab('token')}
            >
              Browser token
            </button>
            <button
              type="button"
              className={'hq-token-tab' + (tab === 'password' ? ' active' : '')}
              onClick={() => setTab('password')}
            >
              Password
            </button>
          </div>
        ) : null}
        {tab === 'token' || !showPassword ? <TokenForm hadToken={hadToken} /> : <PasswordForm />}
      </div>
    </div>
  );
}

function TokenForm({ hadToken }: { hadToken: boolean }): React.ReactElement {
  const [value, setValue] = useState('');

  const submit = (): void => {
    const token = value.trim();
    if (token.length === 0) return;
    setHqToken(token);
    window.location.reload();
  };

  return (
    <>
      <div className="hq-token-title">Browser token required</div>
      <p className="hq-token-text">
        {hadToken
          ? 'The saved token was rejected — it may have been revoked or the server was reset. Paste a current browser token.'
          : 'This HQ server runs in token mode. Paste the browser token printed at startup (the ?token= value in the URL wstack --hq shows).'}
      </p>
      <input
        className="hq-token-input"
        type="password"
        placeholder="browser token"
        autoComplete="off"
        value={value}
        onChange={(ev) => setValue(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') submit();
        }}
      />
      <button
        type="button"
        className="hq-token-submit"
        onClick={submit}
        disabled={value.trim().length === 0}
      >
        Connect
      </button>
      <p className="hq-token-hint">
        Manage tokens with <code>wstack hq token list</code> / <code>wstack hq token create</code> —
        they live in <code>~/.wrongstack/hq/auth.json</code>.
      </p>
    </>
  );
}

function PasswordForm(): React.ReactElement {
  const [value, setValue] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const password = value;
    if (password.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        let msg = 'Login failed.';
        try {
          const body = (await res.json()) as { error?: { message?: string } | string };
          const err = body.error;
          if (typeof err === 'string') msg = err;
          else if (typeof err?.message === 'string') msg = err.message;
        } catch {
          /* ignore */
        }
        setError(msg);
        setBusy(false);
        return;
      }
      const body = (await res.json()) as { loggedIn?: boolean; totpRequired?: boolean };
      if (body.totpRequired) {
        setTotpRequired(true);
        setBusy(false);
        return;
      }
      // Login complete — clear any stale token, reload to pick up cookie.
      clearHqToken();
      window.location.reload();
    } catch {
      setError('Network error.');
      setBusy(false);
    }
  };

  const submitTotp = async (): Promise<void> => {
    const rawCode = totpCode.trim();
    if (rawCode.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // Recovery codes contain a hyphen; TOTP codes are pure digits.
      const payload =
        rawCode.includes('-')
          ? { recoveryCode: rawCode }
          : { code: rawCode.replace(/\D/g, '').slice(0, 6) };
      const res = await fetch('/api/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let msg = 'Verification failed.';
        try {
          const body = (await res.json()) as { error?: { message?: string } | string };
          const err = body.error;
          if (typeof err === 'string') msg = err;
          else if (typeof err?.message === 'string') msg = err.message;
        } catch {
          /* ignore */
        }
        setError(msg);
        setBusy(false);
        return;
      }
      clearHqToken();
      window.location.reload();
    } catch {
      setError('Network error.');
      setBusy(false);
    }
  };

  if (totpRequired) {
    return (
      <>
        {error ? <p className="hq-token-error">{error}</p> : null}
        <label className="hq-token-label" htmlFor="hq-totp-code">
          Authenticator code
        </label>
        <input
          id="hq-totp-code"
          className="hq-token-input"
          type="text"
          autoComplete="one-time-code"
          autoFocus
          placeholder="000000 or recovery code"
          value={totpCode}
          onChange={(ev) => setTotpCode(ev.target.value.slice(0, 32))}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') void submitTotp();
          }}
        />
        <button
          type="button"
          className="hq-token-submit"
          onClick={() => void submitTotp()}
          disabled={totpCode.trim().length === 0 || busy}
        >
          {busy ? 'Verifying…' : 'Verify'}
        </button>
        <button
          type="button"
          className="hq-token-hint"
          onClick={() => {
            setTotpRequired(false);
            setTotpCode('');
            setError(null);
          }}
        >
          ← Back to password
        </button>
        <p className="hq-token-hint">
          Enter the 6-digit code from your authenticator app, or paste a recovery code.
        </p>
      </>
    );
  }

  return (
    <>
      <div className="hq-token-title">Password required</div>
      <p className="hq-token-text">
        This HQ server is protected by a password. Enter it to open the dashboard.
      </p>
      {error ? <p className="hq-token-error">{error}</p> : null}
      <input
        className="hq-token-input"
        type="password"
        placeholder="password"
        autoComplete="current-password"
        value={value}
        onChange={(ev) => setValue(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') void submit();
        }}
      />
      <button
        type="button"
        className="hq-token-submit"
        onClick={() => void submit()}
        disabled={value.length === 0 || busy}
      >
        {busy ? 'Logging in…' : 'Log in'}
      </button>
      <p className="hq-token-hint">
        Set or change the password with <code>wstack --hq --password &lt;secret&gt;</code>.
      </p>
    </>
  );
}
