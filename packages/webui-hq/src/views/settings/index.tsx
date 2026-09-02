/**
 * Security — the HQ browser credential, 2FA, sessions and the auth audit.
 *
 * Every mutation here goes through `/api/auth/*` and the server re-projects
 * its own auth state in the response, so this page never derives what is
 * enabled from what it just did: it re-reads the projection.
 */
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
import type * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { PasswordInput } from '../../components/hq/password-input.js';
import { StatTile } from '../../components/hq/primitives.js';
import { ViewShell } from '../../components/hq/view-chrome.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { Label } from '../../components/ui/label.js';
import { authorizedFetch } from '../../data/api.js';
import { clearHqToken } from '../../data/auth/index.js';
import { AuthAuditPanel } from './auth-audit.js';
import { SessionsPanel } from './sessions.js';
import {
  type AuthStatus,
  errorMessage,
  type PanelMessage,
  PasswordStrengthMeter,
  SecurityPanel,
  StatusMessage,
  toMessage,
} from './shared.js';
import { TotpDisable, TotpEnroll } from './totp.js';

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;

export function SettingsView(): React.ReactElement {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<PanelMessage | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const loadStatus = useCallback(async (): Promise<void> => {
    const response = await authorizedFetch('/api/auth/status');
    if (!response.ok) throw new Error(await errorMessage(response));
    setStatus((await response.json()) as AuthStatus);
  }, []);

  useEffect(() => {
    void loadStatus().catch((cause: unknown) => setMessage(toMessage(cause)));
  }, [loadStatus]);

  const requiresCurrentPassword = status?.passwordMode === true;
  const passwordValid =
    newPassword.length >= MIN_PASSWORD_LENGTH && newPassword.length <= MAX_PASSWORD_LENGTH;
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
    const wasEnabled = status?.passwordMode === true;
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
      setMessage({ tone: 'ok', text: wasEnabled ? 'Password changed.' : 'Password enabled.' });
    } catch (cause) {
      setMessage(toMessage(cause));
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
    } catch (cause) {
      setMessage(toMessage(cause));
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
    // Only offered with a password set: handing out a tunnel URL to an
    // unprotected HQ would be publishing the fleet.
    if (status?.publicOrigin === undefined || !status.passwordMode) return;
    try {
      await navigator.clipboard.writeText(status.publicOrigin);
      setMessage({ tone: 'ok', text: 'Public tunnel URL copied.' });
    } catch {
      setMessage({ tone: 'error', text: 'Could not copy the public tunnel URL.' });
    }
  };

  return (
    <ViewShell>
      <Card>
        <CardContent className="flex flex-wrap items-start gap-x-8 gap-y-4">
          <StatTile
            label="Browser access"
            value={status?.loggedIn === true ? 'Authenticated' : 'Checking…'}
            tone={status?.loggedIn === true ? 'active' : 'idle'}
          />
          <StatTile
            label="Browser tokens"
            value={status?.tokenMode === true ? 'Enabled' : 'Disabled'}
            tone={status?.tokenMode === true ? 'active' : 'idle'}
          />
          <StatTile
            label="Password login"
            value={status?.passwordMode === true ? 'Enabled' : 'Disabled'}
            tone={status?.passwordMode === true ? 'active' : 'idle'}
          />
          <StatTile
            label="Two-factor"
            value={status?.totpEnabled === true ? 'Active' : 'Off'}
            tone={status?.totpEnabled === true ? 'active' : 'idle'}
          />
          <div className="flex flex-col gap-1">
            <StatTile
              label="Public tunnel"
              value={status?.publicRelay === true ? 'Active' : 'Disabled'}
              tone={status?.publicRelay === true ? 'warn' : 'idle'}
            />
            {status?.publicOrigin !== undefined && status.passwordMode && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copyPublicUrl()}
                aria-label="Copy public tunnel URL"
                title={status.publicOrigin}
              >
                <Copy />
                Copy URL
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <StatusMessage message={message} />

      <SecurityPanel
        eyebrow="Browser credential"
        title={status?.passwordMode === true ? 'Change HQ password' : 'Enable HQ password'}
        description="Passwords are stored as salted scrypt hashes. Changing the password invalidates older password sessions."
        icon={LockKeyhole}
      >
        <div className="max-w-sm space-y-3">
          {requiresCurrentPassword && (
            <div className="space-y-1">
              <Label htmlFor="hq-current-password">Current password</Label>
              <PasswordInput
                id="hq-current-password"
                value={currentPassword}
                onChange={setCurrentPassword}
                autoComplete="current-password"
              />
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="hq-new-password">New password</Label>
            <PasswordInput
              id="hq-new-password"
              value={newPassword}
              onChange={setNewPassword}
              autoComplete="new-password"
            />
            <p className="text-[10px] text-muted-foreground">
              Minimum {MIN_PASSWORD_LENGTH} characters.
            </p>
            <PasswordStrengthMeter password={newPassword} />
          </div>

          <div className="space-y-1">
            <Label htmlFor="hq-confirm-password">Confirm new password</Label>
            <PasswordInput
              id="hq-confirm-password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              autoComplete="new-password"
              onKeyDown={(event) => {
                if (event.key === 'Enter') void savePassword();
              }}
            />
            {confirmPassword !== '' && !passwordsMatch && (
              <p className="text-[10px] text-destructive">Passwords do not match.</p>
            )}
          </div>

          <Button disabled={!canSave} onClick={() => void savePassword()}>
            <ShieldCheck />
            {busy
              ? 'Saving…'
              : status?.passwordMode === true
                ? 'Change password'
                : 'Enable password'}
          </Button>
        </div>
      </SecurityPanel>

      <SecurityPanel
        eyebrow="Two-factor authentication"
        title={status?.totpEnabled === true ? '2FA is active' : 'Enable 2FA (TOTP)'}
        description={
          status?.totpEnabled === true
            ? `Authenticator required for password login. ${status.recoveryCodesRemaining ?? 0} recovery codes remaining.`
            : 'Add a TOTP authenticator as a second factor for password login. Recommended for public tunnel deployments.'
        }
        icon={Smartphone}
      >
        {status?.totpEnabled === true ? (
          <TotpDisable
            busy={busy}
            setBusy={setBusy}
            setMessage={setMessage}
            hasPassword={status.passwordMode}
          />
        ) : (
          <TotpEnroll busy={busy} setBusy={setBusy} setMessage={setMessage} />
        )}
      </SecurityPanel>

      <SecurityPanel
        eyebrow="Active sessions"
        title="Session management"
        description="Browser sessions expire after 30 minutes of inactivity, or 7 days absolute. Revoke one, or sign out everywhere."
        icon={Monitor}
      >
        <SessionsPanel />
      </SecurityPanel>

      <SecurityPanel
        eyebrow="Security audit log"
        title="Recent auth events"
        description="Token lifecycle, password changes and 2FA events from the audit trail."
        icon={RadioTower}
      >
        <AuthAuditPanel />
      </SecurityPanel>

      <SecurityPanel
        eyebrow="Session and recovery"
        title="Access controls"
        description="Browser tokens remain available as a recovery path. Public tunnel mode refuses to remove the last browser authentication method."
        icon={ShieldOff}
        danger
      >
        {status?.publicRelay === true && (
          <div className="space-y-1.5 border border-border bg-muted/30 p-3 text-[11px]">
            <strong className="text-xs">Lost your password?</strong>
            <p className="text-muted-foreground">
              Reset it from the machine running <code className="font-mono">wstack hq</code>:
            </p>
            <ol className="list-decimal space-y-0.5 pl-4 text-muted-foreground">
              <li>
                Stop the HQ server (<code className="font-mono">Ctrl+C</code> or{' '}
                <code className="font-mono">wstack hq stop</code>).
              </li>
              <li>
                Edit <code className="font-mono">~/.wrongstack/hq/auth.json</code> and remove{' '}
                <code className="font-mono">passwordHash</code> and{' '}
                <code className="font-mono">cookieSecret</code> — plus{' '}
                <code className="font-mono">totpSecret</code> /{' '}
                <code className="font-mono">totpRecoveryCodes</code> if 2FA is on.
              </li>
              <li>
                Restart with{' '}
                <code className="font-mono">wstack hq --password &lt;new-password&gt;</code>.
              </li>
            </ol>
            <p className="text-muted-foreground">
              This needs shell access to the host. If the machine itself is lost, every credential
              lives in <code className="font-mono">~/.wrongstack/hq/</code>.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void logout()}>
            <LogOut />
            Log out this browser
          </Button>

          {status?.passwordMode === true &&
            (confirmRemove ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-muted-foreground">
                  Remove password protection?
                </span>
                <Button variant="outline" disabled={busy} onClick={() => setConfirmRemove(false)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy || (requiresCurrentPassword && currentPassword === '')}
                  onClick={() => void removePassword()}
                  title={
                    requiresCurrentPassword && currentPassword === ''
                      ? 'Enter the current password above first'
                      : undefined
                  }
                >
                  Remove password
                </Button>
              </div>
            ) : (
              <Button variant="destructive" disabled={busy} onClick={() => setConfirmRemove(true)}>
                <ShieldOff />
                Remove password
              </Button>
            ))}

          {status?.tokenMode === true && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <KeyRound className="size-3" />
              Browser tokens are enabled as a recovery path.
            </span>
          )}
        </div>
      </SecurityPanel>
    </ViewShell>
  );
}
