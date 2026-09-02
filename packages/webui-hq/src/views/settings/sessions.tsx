/** Active browser sessions, with per-session revoke and a sign-out-everywhere. */
import { LogOut } from 'lucide-react';
import type * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Mono } from '../../components/hq/primitives.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { authorizedFetch } from '../../data/api.js';
import { errorMessage, StatusMessage, toMessage } from './shared.js';

interface SessionInfo {
  id: string;
  shortId: string;
  kind: string;
  createdAt: string;
  lastSeenAt: string;
  ageMinutes: number;
  idleMinutes: number;
}

function ageLabel(minutes: number): string {
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

export function SessionsPanel(): React.ReactElement {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await authorizedFetch('/api/auth/sessions');
      if (!response.ok) throw new Error(await errorMessage(response));
      const body = (await response.json()) as { sessions: SessionInfo[] };
      setSessions(body.sessions ?? []);
      setError(null);
    } catch (cause) {
      setError(toMessage(cause).text);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (id: string): Promise<void> => {
    try {
      const response = await authorizedFetch(`/api/auth/sessions/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(await errorMessage(response));
      await load();
    } catch (cause) {
      setError(toMessage(cause).text);
    }
  };

  const revokeAll = async (): Promise<void> => {
    try {
      const response = await authorizedFetch('/api/auth/sessions', { method: 'DELETE' });
      if (!response.ok) throw new Error(await errorMessage(response));
      // Revoking everything logs this tab out too — reload into the gate.
      window.location.reload();
    } catch (cause) {
      setError(toMessage(cause).text);
    }
  };

  if (loading) return <p className="text-[11px] text-muted-foreground">Loading sessions…</p>;
  if (error !== null) return <StatusMessage message={{ tone: 'error', text: error }} />;
  if (sessions.length === 0) {
    return <p className="text-[11px] text-muted-foreground">No active sessions.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="divide-y divide-border border border-border">
        {sessions.map((session) => (
          <div
            key={session.id}
            data-testid="session-row"
            className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-xs"
          >
            <Mono>{session.shortId}</Mono>
            <Badge tone="info">{session.kind}</Badge>
            <span className="text-muted-foreground">{ageLabel(session.ageMinutes)}</span>
            <Badge tone={session.idleMinutes < 1 ? 'active' : 'idle'}>
              {session.idleMinutes < 1 ? 'active now' : `idle ${session.idleMinutes}m`}
            </Badge>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void revoke(session.id)}
              className="ml-auto"
            >
              Revoke
            </Button>
          </div>
        ))}
      </div>
      <Button variant="destructive" onClick={() => void revokeAll()}>
        <LogOut />
        Sign out everywhere
      </Button>
    </div>
  );
}
