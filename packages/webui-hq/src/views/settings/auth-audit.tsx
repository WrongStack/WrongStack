/** Token lifecycle, password changes and 2FA events from the auth audit trail. */
import type * as React from 'react';
import { useEffect, useState } from 'react';
import { Mono } from '../../components/hq/primitives.js';
import { Badge } from '../../components/ui/badge.js';
import { authorizedFetch } from '../../data/api.js';
import { errorMessage, StatusMessage, toMessage } from './shared.js';

interface AuditEntry {
  at: number;
  kind: string;
  scope: string;
  tokenId: string;
  label?: string;
  actor?: string;
}

const KIND_LABEL: Record<string, string> = {
  create: 'Token created',
  revoke: 'Token revoked',
  'first-run': 'First-run bootstrap',
  'expired-prune': 'Expired tokens pruned',
  'password-rotate': 'Password rotated',
};

/** A password rotation has no token; the server marks it with this sentinel. */
const PASSWORD_ROTATION_TOKEN = '(password-rotation)';

function agoLabel(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export function AuthAuditPanel(): React.ReactElement {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await authorizedFetch('/api/auth/audit');
        if (!response.ok) throw new Error(await errorMessage(response));
        const body = (await response.json()) as { entries: AuditEntry[] };
        if (cancelled) return;
        setEntries(body.entries ?? []);
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(toMessage(cause).text);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <p className="text-[11px] text-muted-foreground">Loading audit log…</p>;
  if (error !== null) return <StatusMessage message={{ tone: 'error', text: error }} />;
  if (entries.length === 0) {
    return <p className="text-[11px] text-muted-foreground">No auth events recorded.</p>;
  }

  return (
    <div className="divide-y divide-border border border-border">
      {entries.map((entry, index) => (
        <div
          // Audit entries carry no id; timestamp plus position is their identity.
          key={`${entry.at}-${index}`}
          data-testid="auth-audit-row"
          className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-xs"
        >
          <span className="font-medium">{KIND_LABEL[entry.kind] ?? entry.kind}</span>
          <Badge tone="idle">{entry.scope}</Badge>
          <Mono>
            {entry.tokenId === PASSWORD_ROTATION_TOKEN ? '—' : entry.tokenId.slice(0, 8)}
          </Mono>
          {entry.actor !== undefined && <Mono>{entry.actor}</Mono>}
          <span className="tabular ml-auto text-[10px] text-muted-foreground">
            {agoLabel(entry.at)}
          </span>
        </div>
      ))}
    </div>
  );
}
