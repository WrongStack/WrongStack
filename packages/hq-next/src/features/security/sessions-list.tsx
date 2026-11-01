'use client';

/**
 * Signed-in browsers. This browser's own session is marked (the server reads
 * it from the signed cookie), so revoking it — or signing out everywhere —
 * says plainly that this browser goes too, and asks first.
 */
import { authorizedFetch } from '@hq/data/api';
import { errorMessage, toMessage } from '@hq/views/settings/shared';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

interface SessionInfo {
  id: string;
  shortId: string;
  kind: string;
  ageMinutes: number;
  idleMinutes: number;
  current?: boolean;
}

function minutes(value: number): string {
  if (value < 1) return 'just now';
  if (value < 60) return `${value} min ago`;
  if (value < 48 * 60) return `${Math.round(value / 60)} h ago`;
  return `${Math.round(value / (24 * 60))} days ago`;
}

type Pending = { kind: 'one'; session: SessionInfo } | { kind: 'all' } | null;

export function SessionsList(): ReactNode {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await authorizedFetch('/api/auth/sessions');
      if (!response.ok) throw new Error(await errorMessage(response));
      const body = (await response.json()) as { sessions?: SessionInfo[] };
      setSessions(
        [...(body.sessions ?? [])].sort(
          (left, right) =>
            Number(right.current === true) - Number(left.current === true) ||
            left.idleMinutes - right.idleMinutes,
        ),
      );
      setError(null);
    } catch (cause) {
      setError(toMessage(cause).text);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (target: Pending): Promise<void> => {
    if (target === null || busy) return;
    setBusy(true);
    try {
      const path =
        target.kind === 'all'
          ? '/api/auth/sessions'
          : `/api/auth/sessions/${encodeURIComponent(target.session.id)}`;
      const response = await authorizedFetch(path, { method: 'DELETE' });
      if (!response.ok) throw new Error(await errorMessage(response));
      if (target.kind === 'all' || target.session.current === true) {
        // This browser's session is gone: back to the sign-in gate.
        window.location.reload();
        return;
      }
      setPending(null);
      await load();
    } catch (cause) {
      setError(toMessage(cause).text);
    } finally {
      setBusy(false);
    }
  };

  if (sessions === null) {
    return (
      <p className={cn('text-sm', error !== null ? 'text-destructive' : 'text-muted-foreground')}>
        {error ?? 'Loading sessions…'}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No browser session — this browser uses a token.
        </p>
      ) : (
        <ul className="flex flex-col">
          {sessions.map((session) => (
            <li
              key={session.id}
              data-session={session.shortId}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border py-3 text-sm"
            >
              <span className="font-medium">
                {session.current === true ? 'This browser' : `Browser ${session.shortId}`}
              </span>
              <span className="text-muted-foreground">{session.kind} sign-in</span>
              <span className="text-muted-foreground">started {minutes(session.ageMinutes)}</span>
              <span className={session.idleMinutes < 1 ? 'text-success' : 'text-muted-foreground'}>
                {session.idleMinutes < 1
                  ? 'active now'
                  : `last seen ${minutes(session.idleMinutes)}`}
              </span>
              <button
                type="button"
                onClick={() => setPending({ kind: 'one', session })}
                className="ml-auto h-8 border border-border px-3 text-sm text-destructive hover:bg-destructive/10"
              >
                {session.current === true ? 'Sign out' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {pending !== null ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm"
        >
          <span className="basis-full">
            {pending.kind === 'all'
              ? 'Every browser is signed out, this one included. Each will need the password or a token again.'
              : pending.session.current === true
                ? 'This is the browser you are using: it will be signed out.'
                : `Browser ${pending.session.shortId} will be signed out at its next request.`}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void revoke(pending)}
            className="h-9 bg-destructive px-4 font-medium text-white hover:bg-destructive/90 disabled:opacity-50"
          >
            {pending.kind === 'all'
              ? 'Sign out everywhere'
              : pending.session.current === true
                ? 'Sign me out'
                : 'Revoke'}
          </button>
          <button
            type="button"
            onClick={() => setPending(null)}
            className="h-9 border border-border px-4 hover:bg-muted"
          >
            Cancel
          </button>
        </div>
      ) : (
        sessions.length > 1 && (
          <button
            type="button"
            onClick={() => setPending({ kind: 'all' })}
            className="self-start text-sm text-destructive underline-offset-4 hover:underline"
          >
            Sign out everywhere…
          </button>
        )
      )}
    </div>
  );
}
