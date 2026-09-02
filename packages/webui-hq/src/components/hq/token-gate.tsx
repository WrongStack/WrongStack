/**
 * The gate — full-screen credential entry when this tab has no valid one.
 *
 * The shell itself is served publicly; every byte of telemetry still flows
 * through the gated `/api/*` and `/ws/*` channels. Before this screen existed
 * a credential-less navigation got a bare JSON 401 and an expired one looked
 * like an endless "reconnecting…".
 *
 * Both flows end at the same place: an HttpOnly session cookie for THIS tab,
 * so storage-disabled and embedded browsers work without a `?token=` URL.
 */
import { KeyRound, ShieldCheck, TriangleAlert } from 'lucide-react';
import type * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { clearHqToken, loginWithHqToken } from '../../data/auth/index.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs.js';
import { PasswordInput } from './password-input.js';

interface AuthStatus {
  tokenMode: boolean;
  passwordMode: boolean;
  loggedIn: boolean;
}

/** Pull a server-supplied message out of an error body, else a default. */
async function errorText(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } | string };
    const error = body.error;
    if (typeof error === 'string') return error;
    if (typeof error?.message === 'string') return error.message;
  } catch {
    // Fall through to the caller's wording.
  }
  return fallback;
}

function GateShell({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center bg-background p-6">
      <div className="w-full max-w-md border border-border bg-card">
        <div className="brand-rule h-0.5 w-full" />
        <div className="flex flex-col gap-3 p-6">
          <div className="flex items-center gap-2">
            <img src="/wrongstack.svg" alt="" aria-hidden="true" className="size-5" />
            <span className="font-display text-sm font-semibold">WrongStack HQ</span>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

function GateError({ message }: { message: string }): React.ReactElement {
  return (
    <p
      role="alert"
      data-testid="gate-error"
      className="flex items-start gap-1.5 border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive"
    >
      <TriangleAlert className="mt-px size-3 shrink-0" />
      {message}
    </p>
  );
}

function TokenForm({
  hadToken,
  onAuthenticated,
}: {
  hadToken: boolean;
  onAuthenticated: () => void;
}): React.ReactElement {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // A ref, not just `busy`: two Enter keystrokes in the same tick would both
  // read the pre-render `busy === false` and fire two logins.
  const inFlight = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async (): Promise<void> => {
    if (busy || inFlight.current || value.trim().length === 0) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const result = await loginWithHqToken(value);
    if (result.ok) {
      onAuthenticated();
      return;
    }
    setError(result.message ?? 'The browser token was rejected.');
    inFlight.current = false;
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-xs text-muted-foreground">
        {hadToken
          ? 'The saved token was rejected — it may have been revoked, or the server was reset. Paste a current browser token.'
          : 'This HQ server runs in token mode. Paste a browser token below; a complete ?token= URL also works.'}
      </p>
      {error !== null && <GateError message={error} />}
      <Label htmlFor="hq-token-input">Browser token</Label>
      <PasswordInput
        id="hq-token-input"
        inputRef={inputRef}
        value={value}
        onChange={setValue}
        placeholder="browser token"
        autoComplete="off"
        onKeyDown={(event) => {
          if (event.key === 'Enter') void submit();
        }}
      />
      <Button
        type="button"
        data-testid="token-submit"
        onClick={() => void submit()}
        disabled={value.trim().length === 0 || busy}
      >
        <KeyRound />
        {busy ? 'Connecting…' : 'Connect'}
      </Button>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Mint one with <code className="font-mono">wstack hq token create</code> and paste the{' '}
        <code className="font-mono">token:</code> value. The secret is shown once — it cannot be
        recovered from <code className="font-mono">~/.wrongstack/hq/auth.json</code>, which stores
        only its hash.
      </p>
    </div>
  );
}

function PasswordForm(): React.ReactElement {
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const totpRef = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (totpRequired) totpRef.current?.focus();
    else passwordRef.current?.focus();
  }, [totpRequired]);

  const submitPassword = async (): Promise<void> => {
    if (busy || inFlight.current || password.length === 0) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        setError(await errorText(response, 'Login failed.'));
        return;
      }
      const body = (await response.json()) as { loggedIn?: boolean; totpRequired?: boolean };
      if (body.totpRequired === true) {
        setTotpRequired(true);
        return;
      }
      // Logged in on the cookie — a stale token would shadow it on every
      // request, because the server authenticates Bearer before the cookie.
      clearHqToken();
      window.location.reload();
    } catch {
      setError('Network error.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const submitTotp = async (): Promise<void> => {
    const raw = totpCode.trim();
    if (busy || inFlight.current || raw.length === 0) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      // Recovery codes contain a hyphen; authenticator codes are pure digits.
      const payload = raw.includes('-')
        ? { recoveryCode: raw }
        : { code: raw.replace(/\D/g, '').slice(0, 6) };
      const response = await fetch('/api/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        setError(await errorText(response, 'Verification failed.'));
        return;
      }
      clearHqToken();
      window.location.reload();
    } catch {
      setError('Network error.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (totpRequired) {
    return (
      <div className="flex flex-col gap-2.5">
        {error !== null && <GateError message={error} />}
        <Label htmlFor="hq-totp-code">Authenticator code</Label>
        <Input
          ref={totpRef}
          id="hq-totp-code"
          type="text"
          autoComplete="one-time-code"
          placeholder="000000 or recovery code"
          value={totpCode}
          onChange={(event) => setTotpCode(event.target.value.slice(0, 32))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submitTotp();
          }}
          className="font-mono"
        />
        <Button
          type="button"
          onClick={() => void submitTotp()}
          disabled={totpCode.trim().length === 0 || busy}
        >
          {busy ? 'Verifying…' : 'Verify'}
        </Button>
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={() => {
            setTotpRequired(false);
            setTotpCode('');
            setError(null);
          }}
        >
          ← Back to password
        </Button>
        <p className="text-[11px] text-muted-foreground">
          Enter the 6-digit code from your authenticator app, or paste a recovery code.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-xs text-muted-foreground">
        This HQ server is protected by a password.
      </p>
      {error !== null && <GateError message={error} />}
      <Label htmlFor="hq-password-input">Password</Label>
      <PasswordInput
        id="hq-password-input"
        inputRef={passwordRef}
        value={password}
        onChange={setPassword}
        placeholder="password"
        autoComplete="current-password"
        onKeyDown={(event) => {
          if (event.key === 'Enter') void submitPassword();
        }}
      />
      <Button
        type="button"
        data-testid="password-submit"
        onClick={() => void submitPassword()}
        disabled={password.length === 0 || busy}
      >
        <ShieldCheck />
        {busy ? 'Logging in…' : 'Log in'}
      </Button>
      <p className="text-[11px] text-muted-foreground">
        Set or change it with <code className="font-mono">wstack --hq --password &lt;secret&gt;</code>.
      </p>
    </div>
  );
}

export function TokenGate({
  hadToken,
  onAuthenticated = () => window.location.reload(),
}: {
  hadToken: boolean;
  onAuthenticated?: () => void;
}): React.ReactElement {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/status')
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as AuthStatus;
      })
      .then((value) => {
        if (!cancelled) setStatus(value);
      })
      .catch(() => {
        if (!cancelled) setStatusError('Could not load HQ auth status.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (statusError !== null) {
    return (
      <GateShell>
        <p className="font-display text-sm font-semibold">Auth status unavailable</p>
        <GateError message={statusError} />
      </GateShell>
    );
  }

  if (status === null) {
    return (
      <GateShell>
        <p className="text-xs text-muted-foreground">Checking auth mode…</p>
      </GateShell>
    );
  }

  const showToken = status.tokenMode;
  const showPassword = status.passwordMode;

  // Default tab: someone who arrived WITH a token was clearly trying to use
  // one, and pasting a token into the password field produces a confusing
  // "login failed". With no token signal, prefer the human-friendly flow.
  const defaultTab = hadToken && showToken ? 'token' : showPassword ? 'password' : 'token';

  if (!showToken || !showPassword) {
    return (
      <GateShell>
        {showPassword ? <PasswordForm /> : <TokenForm hadToken={hadToken} onAuthenticated={onAuthenticated} />}
      </GateShell>
    );
  }

  return (
    <GateShell>
      <Tabs defaultValue={defaultTab}>
        <TabsList className="w-full">
          <TabsTrigger value="token">Browser token</TabsTrigger>
          <TabsTrigger value="password">Password</TabsTrigger>
        </TabsList>
        <TabsContent value="token" className="pt-3">
          <TokenForm hadToken={hadToken} onAuthenticated={onAuthenticated} />
        </TabsContent>
        <TabsContent value="password" className="pt-3">
          <PasswordForm />
        </TabsContent>
      </Tabs>
    </GateShell>
  );
}
