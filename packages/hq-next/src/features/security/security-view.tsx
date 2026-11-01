'use client';

/**
 * Security — how this HQ is protected, and who is signed in.
 *
 * The credential flows themselves (password, 2FA enrolment and removal, the
 * audit log) are the tested legacy components, reused unchanged: this page
 * only arranges them, says in words what the protection adds up to, and puts a
 * confirmation in front of every action that signs people out. Every mutation
 * re-reads `/api/auth/status`; the page never assumes what it just changed.
 */
import { PasswordInput } from '@hq/components/hq/password-input';
import { authorizedFetch } from '@hq/data/api';
import { clearHqToken } from '@hq/data/auth/index';
import { AuthAuditPanel } from '@hq/views/settings/auth-audit';
import {
  type AuthStatus,
  errorMessage,
  type PanelMessage,
  PasswordStrengthMeter,
  toMessage,
} from '@hq/views/settings/shared';
import { TotpDisable, TotpEnroll } from '@hq/views/settings/totp';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useId, useState } from 'react';
import { cn } from '@/lib/cn';
import { protectionSummary } from './model';
import { SessionsList } from './sessions-list';

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 1024;

/** The server's own error text, with the wait spelled out when it rate-limits. */
async function failure(response: Response): Promise<Error> {
  if (response.status === 429) {
    const seconds = Number(response.headers.get('Retry-After'));
    if (Number.isFinite(seconds) && seconds > 0) {
      return new Error(
        `Too many attempts from this address. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
      );
    }
  }
  return new Error(await errorMessage(response));
}

function Section({
  title,
  description,
  children,
  danger = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  danger?: boolean;
}): ReactNode {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={cn(
        'flex flex-col gap-4 border-t pt-6',
        danger ? 'border-destructive/40' : 'border-border',
      )}
    >
      <div className="flex flex-col gap-1">
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        {description !== undefined && (
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function Message({ message }: { message: PanelMessage | null }): ReactNode {
  if (message === null) return null;
  return (
    <p
      role={message.tone === 'error' ? 'alert' : 'status'}
      className={cn('text-sm', message.tone === 'ok' ? 'text-success' : 'text-destructive')}
    >
      {message.text}
    </p>
  );
}

export function SecurityView(): ReactNode {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<PanelMessage | null>(null);
  const [totpMessage, setTotpMessage] = useState<PanelMessage | null>(null);

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      const response = await authorizedFetch('/api/auth/status');
      if (!response.ok) throw new Error(await errorMessage(response));
      setStatus((await response.json()) as AuthStatus);
      setLoadError(null);
    } catch (cause) {
      setLoadError(toMessage(cause).text);
    }
  }, []);
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // The 2FA components report through a message; a success means the
  // protection changed, so the page re-reads it instead of trusting itself.
  const onTotpMessage = useCallback(
    (message: PanelMessage | null): void => {
      setTotpMessage(message);
      if (message?.tone === 'ok') void loadStatus();
    },
    [loadStatus],
  );

  if (status === null) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <p
          className={cn(
            'text-base',
            loadError !== null ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {loadError ?? 'Reading how this HQ is protected…'}
        </p>
      </div>
    );
  }

  const summary = protectionSummary(status);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-6">
      <header
        className={cn(
          'flex items-start gap-3 border p-5',
          summary.level === 'exposed'
            ? 'border-destructive/60 bg-destructive/5'
            : summary.level === 'weak'
              ? 'border-warning/60 bg-warning/5'
              : 'border-border bg-card',
        )}
      >
        {summary.level === 'strong' ? (
          <ShieldCheck className="mt-1 size-6 shrink-0 text-success" />
        ) : (
          <ShieldAlert
            className={cn(
              'mt-1 size-6 shrink-0',
              summary.level === 'exposed' ? 'text-destructive' : 'text-warning',
            )}
          />
        )}
        <div className="flex flex-col gap-2">
          <h2 className="font-display text-xl font-semibold">{summary.headline}</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {summary.facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
          {summary.advice !== null && <p className="text-sm font-medium">{summary.advice}</p>}
          {status.publicOrigin !== undefined && status.passwordMode && (
            <PublicUrl origin={status.publicOrigin} />
          )}
        </div>
      </header>

      <PasswordSection
        status={status}
        busy={busy}
        setBusy={setBusy}
        message={passwordMessage}
        setMessage={setPasswordMessage}
        onChanged={loadStatus}
      />

      <Section
        title={status.totpEnabled === true ? 'Two-factor sign-in is on' : 'Two-factor sign-in'}
        description={
          status.totpEnabled === true
            ? `Password sign-in also asks for an authenticator code. ${status.recoveryCodesRemaining ?? 0} recovery codes left.`
            : status.passwordMode
              ? 'Add an authenticator app as a second factor for password sign-in. Strongly advised before using the public tunnel.'
              : 'Set a password first; two-factor protects password sign-in.'
        }
      >
        {status.totpEnabled === true ? (
          <TotpDisable
            busy={busy}
            setBusy={setBusy}
            setMessage={onTotpMessage}
            hasPassword={status.passwordMode}
          />
        ) : status.passwordMode ? (
          <div className="max-w-sm">
            <TotpEnroll busy={busy} setBusy={setBusy} setMessage={onTotpMessage} />
          </div>
        ) : null}
        <Message message={totpMessage} />
      </Section>

      <Section
        title="Signed-in browsers"
        description="A browser session ends after 30 minutes without activity, or after 7 days at the latest."
      >
        <SessionsList />
      </Section>

      <Section
        title="Recent sign-in activity"
        description="Token, password and two-factor events from the audit log."
      >
        <AuthAuditPanel />
      </Section>

      <Section title="This browser">
        <SignOut />
        {status.publicRelay === true && <LostPassword />}
      </Section>
    </div>
  );
}

function PublicUrl({ origin }: { origin: string }): ReactNode {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'error'>('idle');
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">Public address:</span>
      <span className="break-all font-mono">{origin}</span>
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard.writeText(origin).then(
            () => setCopied('ok'),
            () => setCopied('error'),
          )
        }
        className="h-8 border border-border px-3 text-sm hover:bg-muted"
      >
        {copied === 'ok' ? 'Copied' : copied === 'error' ? 'Copy failed' : 'Copy'}
      </button>
    </p>
  );
}

function PasswordSection({
  status,
  busy,
  setBusy,
  message,
  setMessage,
  onChanged,
}: {
  status: AuthStatus;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  message: PanelMessage | null;
  setMessage: (message: PanelMessage | null) => void;
  onChanged: () => Promise<void>;
}): ReactNode {
  const id = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [removing, setRemoving] = useState(false);
  const [removeCurrent, setRemoveCurrent] = useState('');
  const has = status.passwordMode;
  const valid = next.length >= MIN_PASSWORD && next.length <= MAX_PASSWORD;
  const matches = next === again;
  const canSave = valid && matches && (!has || current !== '') && !busy;

  const save = async (): Promise<void> => {
    if (!canSave) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await authorizedFetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(has ? { currentPassword: current } : {}), newPassword: next }),
      });
      if (!response.ok) throw await failure(response);
      setCurrent('');
      setNext('');
      setAgain('');
      setMessage({
        tone: 'ok',
        text: has
          ? 'Password changed. Other password sessions were signed out.'
          : 'Password protection is on.',
      });
      await onChanged();
    } catch (cause) {
      setMessage(toMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (removeCurrent === '' || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await authorizedFetch('/api/auth/password', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: removeCurrent }),
      });
      if (!response.ok) throw await failure(response);
      setRemoveCurrent('');
      setRemoving(false);
      setMessage({ tone: 'ok', text: 'Password protection removed.' });
      await onChanged();
    } catch (cause) {
      setMessage(toMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const label = 'text-sm font-medium';
  return (
    <Section
      title={has ? 'Change the password' : 'Protect HQ with a password'}
      description="Stored as a salted scrypt hash. Changing it signs out every other password session."
    >
      <form
        className="flex max-w-sm flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {/* Lets password managers file the credential under the right account. */}
        <input type="text" name="username" autoComplete="username" value="hq" readOnly hidden />
        {has && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-current`} className={label}>
              Current password
            </label>
            <PasswordInput
              id={`${id}-current`}
              value={current}
              onChange={setCurrent}
              autoComplete="current-password"
            />
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-new`} className={label}>
            New password
          </label>
          <PasswordInput
            id={`${id}-new`}
            value={next}
            onChange={setNext}
            autoComplete="new-password"
          />
          <span className="text-xs text-muted-foreground">At least {MIN_PASSWORD} characters.</span>
          <PasswordStrengthMeter password={next} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-again`} className={label}>
            New password again
          </label>
          <PasswordInput
            id={`${id}-again`}
            value={again}
            onChange={setAgain}
            autoComplete="new-password"
          />
          {again !== '' && !matches && (
            <span className="text-xs text-destructive">The two passwords differ.</span>
          )}
        </div>
        <button
          type="submit"
          disabled={!canSave}
          className="h-10 self-start bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? 'Saving…' : has ? 'Change password' : 'Turn on password'}
        </button>
      </form>
      <Message message={message} />

      {has &&
        (removing ? (
          <form
            className="flex max-w-xl flex-col gap-3 border border-destructive/50 bg-destructive/5 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void remove();
            }}
          >
            <p className="text-sm">
              Without a password, anyone who can reach this HQ with a browser token is let in.
              {status.publicRelay === true &&
                ' The public tunnel is on: HQ refuses to remove the last sign-in method.'}
            </p>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-remove`} className={label}>
                Current password, to confirm
              </label>
              <PasswordInput
                id={`${id}-remove`}
                value={removeCurrent}
                onChange={setRemoveCurrent}
                autoComplete="current-password"
                className="max-w-sm"
              />
            </div>
            <div className="flex gap-3">
              <button
                type="submit"
                disabled={removeCurrent === '' || busy}
                className="h-10 bg-destructive px-4 text-sm font-medium text-white hover:bg-destructive/90 disabled:opacity-50"
              >
                Remove password
              </button>
              <button
                type="button"
                onClick={() => {
                  setRemoving(false);
                  setRemoveCurrent('');
                }}
                className="h-10 border border-border px-4 text-sm hover:bg-muted"
              >
                Keep it
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setRemoving(true)}
            className="self-start text-sm text-destructive underline-offset-4 hover:underline"
          >
            Remove password protection…
          </button>
        ))}
    </Section>
  );
}

function SignOut(): ReactNode {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void authorizedFetch('/api/logout', { method: 'POST' }).finally(() => {
          clearHqToken();
          window.location.reload();
        });
      }}
      className="h-10 self-start border border-border px-4 text-sm hover:bg-muted disabled:opacity-50"
    >
      {busy ? 'Signing out…' : 'Sign out of this browser'}
    </button>
  );
}

function LostPassword(): ReactNode {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        Lost the password?
      </summary>
      <div className="mt-2 flex flex-col gap-2 text-muted-foreground">
        <p>
          It can only be reset on the machine that runs <code className="font-mono">wstack hq</code>
          :
        </p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            Stop HQ (<code className="font-mono">Ctrl+C</code> or{' '}
            <code className="font-mono">wstack hq stop</code>).
          </li>
          <li>
            In <code className="font-mono">~/.wrongstack/hq/auth.json</code>, remove{' '}
            <code className="font-mono">passwordHash</code> and{' '}
            <code className="font-mono">cookieSecret</code> — and{' '}
            <code className="font-mono">totpSecret</code> /{' '}
            <code className="font-mono">totpRecoveryCodes</code> if two-factor is on.
          </li>
          <li>
            Start again with{' '}
            <code className="font-mono">wstack hq --password &lt;new-password&gt;</code>.
          </li>
        </ol>
      </div>
    </details>
  );
}
