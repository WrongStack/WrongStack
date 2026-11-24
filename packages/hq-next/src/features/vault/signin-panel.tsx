'use client';

/**
 * Sign in to a subscription account on HQ (ChatGPT, GitHub Copilot, xAI, …).
 * HQ keeps the account's refresh token and renews it; machines given the
 * profile receive only short-lived access tokens, renewed through HQ.
 *
 * A device-code sign-in shows the code to enter at the provider. A browser
 * sign-in opens the provider's page; when HQ is on another machine its
 * loopback callback cannot be reached, so the redirected URL is pasted here.
 */
import {
  cancelVaultSignIn,
  fetchVaultSignIn,
  type HqVaultProfileMeta,
  sendVaultSignInCode,
  startVaultSignIn,
  type VaultSignIn,
  type VaultSignInStrategy,
} from '@hq/data/vault-api';
import { ExternalLink, LogIn, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useId, useState } from 'react';
import { cn } from '@/lib/cn';
import { profileIdError } from './model';
import { ProviderLogo } from './profile-card';
import { field, label, MessageLine, primaryButton, smallButton, useVaultAction } from './shared';

/** Sign-ins of a personal subscription, where sharing across machines is a terms question. */
const PERSONAL_PLANS = new Set(['chatgpt', 'copilot', 'chatgpt-api']);

export function SignInPanel({
  strategies,
  strategiesError,
  profiles,
  canWrite,
  onSaved,
}: {
  strategies: readonly VaultSignInStrategy[] | null;
  strategiesError: string | null;
  profiles: readonly HqVaultProfileMeta[];
  canWrite: boolean;
  onSaved: () => Promise<void>;
}): ReactNode {
  const [active, setActive] = useState<string | null>(null);
  if (strategiesError !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {strategiesError}
      </p>
    );
  }
  if (strategies === null) {
    return <p className="text-sm text-muted-foreground">Loading sign-ins…</p>;
  }
  return (
    <div className="flex flex-col gap-4" data-testid="vault-signin">
      <p className="max-w-2xl text-sm text-muted-foreground">
        Sign in once here. HQ keeps the account's refresh token and renews it; machines you give the
        provider to receive only short-lived access tokens, renewed through HQ.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {strategies.map((strategy) => (
          <SignInCard
            key={strategy.id}
            strategy={strategy}
            profiles={profiles}
            canWrite={canWrite}
            open={active === strategy.id}
            onOpen={() => setActive(strategy.id)}
            onClose={() => setActive(null)}
            onSaved={onSaved}
          />
        ))}
      </div>
    </div>
  );
}

function SignInCard({
  strategy,
  profiles,
  canWrite,
  open,
  onOpen,
  onClose,
  onSaved,
}: {
  strategy: VaultSignInStrategy;
  profiles: readonly HqVaultProfileMeta[];
  canWrite: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
}): ReactNode {
  const existing = profiles.filter((p) => p.type === strategy.providerId);
  return (
    <div
      className={cn(
        'flex flex-col border border-border bg-card',
        open && 'border-primary md:col-span-2',
      )}
      data-testid="vault-signin-card"
    >
      <div className="flex items-start gap-3 p-4">
        <ProviderLogo id={strategy.providerId} />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{strategy.label}</p>
          {strategy.description && (
            <p className="text-sm text-muted-foreground">{strategy.description}</p>
          )}
          {existing.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Saved: {existing.map((p) => p.id).join(', ')}
            </p>
          )}
        </div>
        {canWrite && !open && (
          <button type="button" className={smallButton} onClick={onOpen}>
            <LogIn className="mr-1 size-3.5" aria-hidden />
            Sign in
          </button>
        )}
      </div>
      {open && (
        <SignInFlow strategy={strategy} profiles={profiles} onClose={onClose} onSaved={onSaved} />
      )}
    </div>
  );
}

function SignInFlow({
  strategy,
  profiles,
  onClose,
  onSaved,
}: {
  strategy: VaultSignInStrategy;
  profiles: readonly HqVaultProfileMeta[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}): ReactNode {
  const id = useId();
  const [alias, setAlias] = useState('');
  const [attempt, setAttempt] = useState<VaultSignIn | null>(null);
  const [pasted, setPasted] = useState('');
  const { busy, message, setMessage, run } = useVaultAction();

  // Poll while HQ waits for the provider (device code, or its own callback).
  const waiting =
    attempt !== null &&
    (attempt.phase === 'awaiting_code' ||
      attempt.phase === 'exchanging' ||
      (attempt.phase === 'awaiting_browser' && attempt.bound === true));
  useEffect(() => {
    if (!waiting || attempt === null) return;
    const timer = window.setInterval(() => {
      void fetchVaultSignIn(attempt.attemptId)
        .then(setAttempt)
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [waiting, attempt]);

  const done = attempt?.phase === 'success';
  useEffect(() => {
    if (done) void onSaved();
  }, [done, onSaved]);

  if (attempt === null) {
    return (
      <form
        className="flex flex-col gap-3 border-t border-border bg-muted/20 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          const value = alias.trim();
          // An existing alias of this provider is signed in again; a new one must be free.
          const sameProvider = profiles.some(
            (p) => p.id === value && p.type === strategy.providerId,
          );
          const problem = value && !sameProvider ? profileIdError(value, profiles) : null;
          if (problem) {
            setMessage({ tone: 'error', text: problem });
            return;
          }
          void run(async () => {
            setAttempt(
              await startVaultSignIn({
                strategyId: strategy.id,
                ...(value ? { profileId: value } : {}),
              }),
            );
          });
        }}
      >
        {PERSONAL_PLANS.has(strategy.id) && (
          <p className="flex items-start gap-2 border border-warning/50 bg-warning/5 p-2 text-xs">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
            This is a personal subscription. Giving one account to several machines or people can
            break the provider's terms; check them before sharing it.
          </p>
        )}
        {strategy.notes?.map((note) => (
          <p key={note} className="text-xs text-muted-foreground">
            {note}
          </p>
        ))}
        <div className="flex max-w-sm flex-col gap-1.5">
          <label htmlFor={`${id}-alias`} className={label}>
            Save as (optional)
          </label>
          <input
            id={`${id}-alias`}
            className={field}
            placeholder={strategy.providerId}
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <button type="submit" disabled={busy} className={primaryButton}>
            {busy ? 'Starting…' : `Sign in to ${strategy.label}`}
          </button>
          <button type="button" className="h-10 px-3 text-sm" onClick={onClose}>
            Cancel
          </button>
        </div>
        <MessageLine message={message} />
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border bg-muted/20 p-4" aria-live="polite">
      {attempt.phase === 'awaiting_code' && attempt.verificationUri && (
        <div className="flex flex-col gap-2">
          <p className="text-sm">
            Open{' '}
            <a
              className="underline"
              href={attempt.verificationUri}
              target="_blank"
              rel="noreferrer"
            >
              {attempt.verificationUri}
            </a>{' '}
            and enter this code:
          </p>
          <p className="font-mono text-2xl font-semibold tracking-widest">{attempt.userCode}</p>
          <p className="text-xs text-muted-foreground">Waiting for the provider…</p>
        </div>
      )}
      {attempt.phase === 'awaiting_browser' && attempt.authorizeUrl && (
        <div className="flex flex-col gap-3">
          <a
            className={cn(smallButton, 'self-start')}
            href={attempt.authorizeUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink className="mr-1 size-3.5" aria-hidden />
            Open the {strategy.label} sign-in page
          </a>
          <p className="text-xs text-muted-foreground">
            {attempt.bound
              ? 'HQ receives the answer itself when this browser runs on the HQ machine. Otherwise the provider sends you to a page that does not load — copy that page’s address and paste it below.'
              : 'After signing in, the provider sends you to a page that does not load. Copy that page’s address and paste it below.'}
          </p>
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (pasted.trim() === '') return;
              void run(async () => {
                setAttempt(await sendVaultSignInCode(attempt.attemptId, pasted.trim()));
              });
            }}
          >
            <input
              aria-label="Redirected address or code"
              className={cn(field, 'font-mono')}
              placeholder="http://localhost:1455/auth/callback?code=…"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
            />
            <button type="submit" disabled={busy} className={cn(primaryButton, 'shrink-0')}>
              {busy ? 'Finishing…' : 'Finish sign-in'}
            </button>
          </form>
        </div>
      )}
      {attempt.phase === 'exchanging' && (
        <p className="text-sm text-muted-foreground">Finishing the sign-in…</p>
      )}
      {attempt.phase === 'success' && (
        <p role="status" className="text-sm text-success">
          {attempt.message ?? 'Signed in.'} Give it to machines from its card under Saved.
        </p>
      )}
      {attempt.phase === 'error' && (
        <p role="alert" className="text-sm text-destructive">
          {attempt.message ?? 'The sign-in failed.'}
        </p>
      )}
      <MessageLine message={message} />
      <div className="flex gap-2">
        {attempt.phase === 'success' || attempt.phase === 'error' ? (
          <button type="button" className={smallButton} onClick={onClose}>
            Close
          </button>
        ) : (
          <button
            type="button"
            className={smallButton}
            onClick={() =>
              void run(async () => {
                setAttempt(await cancelVaultSignIn(attempt.attemptId));
              })
            }
          >
            Cancel sign-in
          </button>
        )}
      </div>
    </div>
  );
}
