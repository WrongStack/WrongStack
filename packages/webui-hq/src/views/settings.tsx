import {
  Copy,
  KeyRound,
  LockKeyhole,
  LogOut,
  Monitor,
  RadioTower,
  ShieldCheck,
  ShieldOff,
  Smartphone,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { authorizedFetch, clearHqToken } from '../lib/auth.js';

interface AuthStatus {
  tokenMode: boolean;
  passwordMode: boolean;
  totpEnabled?: boolean | undefined;
  recoveryCodesRemaining?: number | undefined;
  loggedIn: boolean;
  authKind?: 'token' | 'password' | 'open' | undefined;
  publicRelay?: boolean | undefined;
  publicOrigin?: string | undefined;
  secureCookies?: boolean | undefined;
}

interface ApiErrorBody {
  error?: { message?: string } | string | undefined;
}

async function errorMessage(response: Response): Promise<string> {
  const fallback = response.statusText || `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as ApiErrorBody;
    if (typeof body.error === 'string') return body.error;
    return body.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

// ── Password strength scoring (zero-dependency) ────────────────────────────

type StrengthLevel = 'empty' | 'weak' | 'fair' | 'good' | 'strong';

interface StrengthResult {
  level: StrengthLevel;
  score: number; // 0–100
  label: string;
}

const COMMON_PASSWORDS = new Set([
  'password', '12345678', '123456789', 'qwerty123', 'abc12345',
  'letmein1', 'welcome1', 'admin123', 'monkey123', 'iloveyou1',
]);

function scorePassword(pw: string): StrengthResult {
  if (pw.length === 0) return { level: 'empty', score: 0, label: '' };

  let score = 0;

  // Length tiers
  if (pw.length >= 8) score += 20;
  if (pw.length >= 12) score += 15;
  if (pw.length >= 16) score += 15;

  // Character variety
  if (/[a-z]/.test(pw)) score += 10;
  if (/[A-Z]/.test(pw)) score += 10;
  if (/\d/.test(pw)) score += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) score += 15;

  // Pattern penalties
  if (/(.)\1{2,}/.test(pw)) score -= 10; // repeated chars (aaa, 111)
  if (/(?:0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf)/i.test(pw)) score -= 10; // sequential
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) score = 0; // dictionary hit

  score = Math.max(0, Math.min(100, score));

  let level: StrengthLevel;
  let label: string;
  if (score < 30) { level = 'weak'; label = 'Weak'; }
  else if (score < 55) { level = 'fair'; label = 'Fair'; }
  else if (score < 80) { level = 'good'; label = 'Good'; }
  else { level = 'strong'; label = 'Strong'; }

  return { level, score, label };
}

function PasswordStrengthMeter({ password }: { password: string }): React.ReactElement | null {
  const { level, score, label } = scorePassword(password);
  if (level === 'empty') return null;

  return (
    <div className="hq-password-strength" data-level={level}>
      <div className="hq-password-strength-bar">
        <div className="hq-password-strength-fill" style={{ width: `${score}%` }} />
      </div>
      <span className="hq-password-strength-label">{label}</span>
    </div>
  );
}

export function SettingsView(): React.ReactElement {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const loadStatus = async (): Promise<void> => {
    const response = await authorizedFetch('/api/auth/status');
    if (!response.ok) throw new Error(await errorMessage(response));
    setStatus((await response.json()) as AuthStatus);
  };

  useEffect(() => {
    void loadStatus().catch((error: unknown) => {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    });
  }, []);

  const requiresCurrentPassword = status?.passwordMode === true;
  const passwordValid = newPassword.length >= 8 && newPassword.length <= 1024;
  const passwordsMatch = newPassword === confirmPassword;
  const canSave =
    passwordValid &&
    passwordsMatch &&
    (!requiresCurrentPassword || currentPassword.length > 0) &&
    !busy;

  const savePassword = async (): Promise<void> => {
    if (!canSave) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await authorizedFetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(requiresCurrentPassword ? { currentPassword } : {}),
          newPassword,
        }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      setStatus((await response.json()) as AuthStatus);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setMessage({
        tone: 'ok',
        text: status?.passwordMode ? 'Password changed.' : 'Password enabled.',
      });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const removePassword = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await authorizedFetch('/api/auth/password', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(requiresCurrentPassword ? { currentPassword } : {}) }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      setStatus((await response.json()) as AuthStatus);
      setCurrentPassword('');
      setConfirmRemove(false);
      setMessage({ tone: 'ok', text: 'Password protection removed.' });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const logout = async (): Promise<void> => {
    setBusy(true);
    try {
      await authorizedFetch('/api/logout', { method: 'POST' });
    } finally {
      clearHqToken();
      window.location.reload();
    }
  };

  const copyPublicUrl = async (): Promise<void> => {
    if (!status?.publicOrigin || !status.passwordMode) return;
    try {
      await navigator.clipboard.writeText(status.publicOrigin);
      setMessage({ tone: 'ok', text: 'Public tunnel URL copied.' });
    } catch {
      setMessage({ tone: 'error', text: 'Could not copy the public tunnel URL.' });
    }
  };

  return (
    <div className="hq-security-page">
      <section className="hq-security-summary" aria-label="Authentication status">
        <div className="hq-security-card">
          <ShieldCheck size={18} />
          <span>Browser access</span>
          <strong>{status?.loggedIn ? 'Authenticated' : 'Checking…'}</strong>
        </div>
        <div className="hq-security-card">
          <KeyRound size={18} />
          <span>Browser tokens</span>
          <strong>{status?.tokenMode ? 'Enabled' : 'Disabled'}</strong>
        </div>
        <div className="hq-security-card">
          <LockKeyhole size={18} />
          <span>Password login</span>
          <strong>{status?.passwordMode ? 'Enabled' : 'Disabled'}</strong>
        </div>
        <div className="hq-security-card">
          <RadioTower size={18} />
          <span>Public tunnel</span>
          <strong>{status?.publicRelay ? 'Active' : 'Disabled'}</strong>
          {status?.publicOrigin && status.passwordMode ? (
            <button
              type="button"
              className="hq-security-copy"
              aria-label="Copy public tunnel URL"
              title={status.publicOrigin}
              onClick={() => void copyPublicUrl()}
            >
              <Copy size={12} />
              Copy URL
            </button>
          ) : null}
        </div>
      </section>

      <section className="hq-security-panel">
        <div className="hq-security-panel-head">
          <div>
            <span>Browser credential</span>
            <h2>{status?.passwordMode ? 'Change HQ password' : 'Enable HQ password'}</h2>
            <p>
              Passwords are stored as salted scrypt hashes. Changing the password invalidates older
              password sessions.
            </p>
          </div>
          <LockKeyhole size={22} />
        </div>

        {message ? (
          <div className="hq-security-message" data-tone={message.tone} role="status">
            {message.text}
          </div>
        ) : null}

        <div className="hq-security-form">
          {requiresCurrentPassword ? (
            <label>
              <span>Current password</span>
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </label>
          ) : null}
          <label>
            <span>New password</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={1024}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <small>Minimum 8 characters.</small>
          </label>
          <PasswordStrengthMeter password={newPassword} />
          <label>
            <span>Confirm new password</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={1024}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void savePassword();
              }}
            />
            {confirmPassword && !passwordsMatch ? (
              <small data-error>Passwords do not match.</small>
            ) : null}
          </label>
          <div className="hq-security-actions">
            <button
              type="button"
              className="hq-btn"
              disabled={!canSave}
              onClick={() => void savePassword()}
            >
              <ShieldCheck size={14} />
              {busy ? 'Saving…' : status?.passwordMode ? 'Change password' : 'Enable password'}
            </button>
          </div>
        </div>
      </section>

      <section className="hq-security-panel">
        <div className="hq-security-panel-head">
          <div>
            <span>Two-factor authentication</span>
            <h2>{status?.totpEnabled ? '2FA is active' : 'Enable 2FA (TOTP)'}</h2>
            <p>
              {status?.totpEnabled
                ? `Authenticator required for password login. ${status.recoveryCodesRemaining ?? 0} recovery codes remaining.`
                : 'Add a TOTP authenticator as a second factor for password login. Recommended for public tunnel deployments.'}
            </p>
          </div>
          <Smartphone size={22} />
        </div>

        {message ? (
          <div className="hq-security-message" data-tone={message.tone} role="status">
            {message.text}
          </div>
        ) : null}

        {status?.totpEnabled ? (
          <TotpDisableSection busy={busy} setBusy={setBusy} setMessage={setMessage} hasPassword={status?.passwordMode === true} />
        ) : (
          <TotpEnrollSection busy={busy} setBusy={setBusy} setMessage={setMessage} />
        )}
      </section>

      <section className="hq-security-panel">
        <div className="hq-security-panel-head">
          <div>
            <span>Active sessions</span>
            <h2>Session management</h2>
            <p>
              Browser sessions expire after 30 min of inactivity or 7 days absolute.
              Revoke individual sessions or sign out everywhere.
            </p>
          </div>
          <Monitor size={22} />
        </div>
        <SessionsSection />
      </section>

      <section className="hq-security-panel danger-zone">
        <div className="hq-security-panel-head">
          <div>
            <span>Session and recovery</span>
            <h2>Access controls</h2>
            <p>
              Browser tokens remain available as a recovery path. Public tunnel mode will refuse to
              remove the last browser authentication method.
            </p>
          </div>
          <ShieldOff size={22} />
        </div>
        <div className="hq-security-actions split">
          <button
            type="button"
            className="hq-btn secondary"
            disabled={busy}
            onClick={() => void logout()}
          >
            <LogOut size={14} />
            Log out this browser
          </button>
          {status?.passwordMode ? (
            confirmRemove ? (
              <div className="hq-security-confirm-remove">
                <span>Remove password protection?</span>
                <button
                  type="button"
                  className="hq-btn secondary"
                  disabled={busy}
                  onClick={() => setConfirmRemove(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="hq-btn danger"
                  disabled={busy || (requiresCurrentPassword && !currentPassword)}
                  onClick={() => void removePassword()}
                >
                  Remove password
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="hq-btn danger"
                disabled={busy}
                onClick={() => setConfirmRemove(true)}
              >
                <ShieldOff size={14} />
                Remove password
              </button>
            )
          ) : null}
        </div>
      </section>
    </div>
  );
}

// ── 2FA enrollment and disable components ──────────────────────────────────

type MessageSetter = (msg: { tone: 'ok' | 'error'; text: string }) => void;
type BusySetter = (b: boolean) => void;

function TotpEnrollSection({
  busy,
  setBusy,
  setMessage,
}: {
  busy: boolean;
  setBusy: BusySetter;
  setMessage: MessageSetter;
}): React.ReactElement {
  const [phase, setPhase] = useState<'idle' | 'pending' | 'recovery'>('idle');
  const [secret, setSecret] = useState('');
  const [uri, setUri] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  // Generate QR code data URL when the otpauth URI becomes available.
  useEffect(() => {
    if (!uri) {
      setQrDataUrl('');
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(uri, { width: 200, margin: 1, errorCorrectionLevel: 'M' })
      .then((url: string) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        // QR generation failed (e.g. invalid URI) — the manual secret
        // entry path still works. Clear so stale QR doesn't linger.
        if (!cancelled) setQrDataUrl('');
      });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  const setup = async (): Promise<void> => {
    setBusy(true);
    setMessage({ tone: 'ok', text: '' });
    try {
      const res = await authorizedFetch('/api/auth/totp/setup', { method: 'POST' });
      if (!res.ok) throw new Error(await errorMessage(res));
      const body = (await res.json()) as { secret: string; uri: string };
      setSecret(body.secret);
      setUri(body.uri);
      setPhase('pending');
      setMessage({ tone: 'ok', text: 'Enter this secret in your authenticator app, then provide the 6-digit code below.' });
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const enable = async (): Promise<void> => {
    if (verifyCode.length !== 6) return;
    setBusy(true);
    setMessage({ tone: 'ok', text: '' });
    try {
      const res = await authorizedFetch('/api/auth/totp/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: verifyCode }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      const body = (await res.json()) as { enabled: boolean; recoveryCodes: string[] };
      setRecoveryCodes(body.recoveryCodes);
      setPhase('recovery');
      setMessage({ tone: 'ok', text: '2FA enabled. Save your recovery codes — they are shown only once.' });
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const done = (): void => {
    window.location.reload();
  };

  if (phase === 'idle') {
    return (
      <div className="hq-security-actions">
        <button type="button" className="hq-btn" disabled={busy} onClick={() => void setup()}>
          <Smartphone size={14} />
          {busy ? 'Setting up…' : 'Start 2FA enrollment'}
        </button>
      </div>
    );
  }

  if (phase === 'pending') {
    return (
      <div className="hq-security-form">
        {qrDataUrl ? (
          <div className="hq-totp-qr">
            <img src={qrDataUrl} alt="Scan this QR code with your authenticator app" width={200} height={200} />
          </div>
        ) : null}
        <div className="hq-totp-secret">
          <span>Secret (manual entry):</span>
          <code>{secret}</code>
        </div>
        <p className="hq-totp-uri-hint">
          <small>Scan the QR code or enter the secret manually, then provide the 6-digit code below.</small>
        </p>
        <label>
          <span>Verification code</span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            placeholder="000000"
            autoComplete="one-time-code"
            value={verifyCode}
            onChange={(ev) => setVerifyCode(ev.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') void enable();
            }}
          />
        </label>
        <div className="hq-security-actions">
          <button
            type="button"
            className="hq-btn"
            disabled={verifyCode.length !== 6 || busy}
            onClick={() => void enable()}
          >
            <ShieldCheck size={14} />
            {busy ? 'Enabling…' : 'Confirm and enable 2FA'}
          </button>
        </div>
      </div>
    );
  }

  // phase === 'recovery'
  return (
    <div className="hq-security-form">
      <div className="hq-totp-recovery">
        <p className="hq-totp-recovery-title">Recovery codes</p>
        <ul className="hq-totp-recovery-list">
          {recoveryCodes.map((code) => (
            <li key={code}>
              <code>{code}</code>
            </li>
          ))}
        </ul>
        <p className="hq-totp-recovery-hint">
          Store these in a safe place. Each can be used once instead of a TOTP code if you lose your device.
        </p>
      </div>
      <div className="hq-security-actions">
        <button type="button" className="hq-btn" onClick={done}>
          <ShieldCheck size={14} />
          I&apos;ve saved my recovery codes
        </button>
      </div>
    </div>
  );
}

function TotpDisableSection({
  busy,
  setBusy,
  setMessage,
  hasPassword,
}: {
  busy: boolean;
  setBusy: BusySetter;
  setMessage: MessageSetter;
  hasPassword: boolean;
}): React.ReactElement {
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [confirm, setConfirm] = useState(false);

  const disable = async (): Promise<void> => {
    setBusy(true);
    setMessage({ tone: 'ok', text: '' });
    try {
      const payload: Record<string, string> = {};
      if (password) payload.password = password;
      if (totpCode) payload.code = totpCode;
      const res = await authorizedFetch('/api/auth/totp/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setMessage({ tone: 'ok', text: '2FA disabled.' });
      setPassword('');
      setTotpCode('');
      setConfirm(false);
      window.location.reload();
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const canDisable = hasPassword ? password.length > 0 : totpCode.length === 6;

  if (!confirm) {
    return (
      <div className="hq-security-actions">
        <button type="button" className="hq-btn danger" disabled={busy} onClick={() => setConfirm(true)}>
          <ShieldOff size={14} />
          Disable 2FA
        </button>
      </div>
    );
  }

  return (
    <div className="hq-security-form">
      {hasPassword ? (
        <label>
          <span>Current password</span>
          <input
            type="password"
            autoComplete="current-password"
            placeholder="confirm with password"
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' && canDisable) void disable();
            }}
          />
        </label>
      ) : (
        <label>
          <span>Authenticator code</span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            placeholder="000000"
            autoComplete="one-time-code"
            autoFocus
            value={totpCode}
            onChange={(ev) => setTotpCode(ev.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' && canDisable) void disable();
            }}
          />
        </label>
      )}
      <div className="hq-security-actions">
        <button type="button" className="hq-btn secondary" disabled={busy} onClick={() => setConfirm(false)}>
          Cancel
        </button>
        <button type="button" className="hq-btn danger" disabled={!canDisable || busy} onClick={() => void disable()}>
          <ShieldOff size={14} />
          Confirm disable
        </button>
      </div>
    </div>
  );
}

// ── Session management ─────────────────────────────────────────────────────

interface SessionInfo {
  id: string;
  shortId: string;
  kind: string;
  createdAt: string;
  lastSeenAt: string;
  ageMinutes: number;
  idleMinutes: number;
}

function SessionsSection(): React.ReactElement {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      const res = await authorizedFetch('/api/auth/sessions');
      if (!res.ok) throw new Error(await errorMessage(res));
      const body = (await res.json()) as { sessions: SessionInfo[] };
      setSessions(body.sessions ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const revoke = async (id: string): Promise<void> => {
    try {
      const res = await authorizedFetch(`/api/auth/sessions/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await errorMessage(res));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const revokeAll = async (): Promise<void> => {
    try {
      const res = await authorizedFetch('/api/auth/sessions', { method: 'DELETE' });
      if (!res.ok) throw new Error(await errorMessage(res));
      // Revoking all sessions logs us out too — reload to the token gate.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) {
    return <p className="hq-security-hint">Loading sessions…</p>;
  }

  if (error) {
    return <p className="hq-security-message" data-tone="error">{error}</p>;
  }

  if (sessions.length === 0) {
    return <p className="hq-security-hint">No active sessions.</p>;
  }

  return (
    <div className="hq-sessions-list">
      {sessions.map((s) => (
        <div key={s.id} className="hq-session-row">
          <div className="hq-session-info">
            <span className="hq-session-id">{s.shortId}</span>
            <span className="hq-session-kind">{s.kind}</span>
            <span className="hq-session-age">
              {s.ageMinutes < 60 ? `${s.ageMinutes}m ago` : `${Math.round(s.ageMinutes / 60)}h ago`}
            </span>
            <span className="hq-session-idle">
              {s.idleMinutes < 1 ? 'active now' : `idle ${s.idleMinutes}m`}
            </span>
          </div>
          <button
            type="button"
            className="hq-btn small danger"
            onClick={() => void revoke(s.id)}
          >
            Revoke
          </button>
        </div>
      ))}
      <div className="hq-security-actions" style={{ marginTop: '0.75rem' }}>
        <button type="button" className="hq-btn danger" onClick={() => void revokeAll()}>
          <LogOut size={14} />
          Sign out everywhere
        </button>
      </div>
    </div>
  );
}
