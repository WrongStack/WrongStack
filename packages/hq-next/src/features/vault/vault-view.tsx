'use client';

/**
 * System → Keys: the HQ key vault.
 *
 * Provider keys live here encrypted and reach only the devices given them,
 * sealed to each device's own keys. The page reads metadata freely (admin
 * only); every change waits on the gate — a password must exist, the vault
 * must be unsealed, the connection must keep a pasted key off the wire, and
 * the operator must have confirmed their password in the last 10 minutes.
 * Every mutation re-reads the whole state; the page never assumes what it just
 * changed.
 */
import { HqHttpError } from '@hq/data/api';
import {
  fetchVaultAudit,
  fetchVaultDevices,
  fetchVaultGrants,
  fetchVaultSecrets,
  fetchVaultStatus,
  type HqVaultAuditEntry,
  type HqVaultDeviceRecord,
  type HqVaultGrantRecord,
  type HqVaultSecretMeta,
  type VaultStatus,
} from '@hq/data/vault-api';
import { KeySquare } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { relativeTime } from '@/features/attention/model';
import { errorText } from '@/lib/error-text';
import { DevicesPanel } from './devices-panel';
import { GatePanel } from './gate-panel';
import { GrantsPanel } from './grants-panel';
import { auditActor, auditSentence, vaultGate } from './model';
import { SecretsPanel } from './secrets-panel';
import { VaultSection } from './shared';

interface VaultData {
  secrets: HqVaultSecretMeta[];
  devices: HqVaultDeviceRecord[];
  grants: HqVaultGrantRecord[];
  audit: HqVaultAuditEntry[];
}

const EMPTY: VaultData = { secrets: [], devices: [], grants: [], audit: [] };

export function VaultView(): ReactNode {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [data, setData] = useState<VaultData>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const seqRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const seq = ++seqRef.current;
    try {
      const nextStatus = await fetchVaultStatus();
      if (seqRef.current !== seq) return;
      setStatus(nextStatus);
      setForbidden(false);
      setError(null);
      setNow(Date.now());
      if (nextStatus.state === 'unavailable') {
        setData(EMPTY);
        return;
      }
      const [secrets, devices, grants, audit] = await Promise.all([
        fetchVaultSecrets(),
        fetchVaultDevices(),
        fetchVaultGrants(),
        fetchVaultAudit(50),
      ]);
      if (seqRef.current !== seq) return;
      setData({
        secrets: secrets.secrets,
        devices: devices.devices,
        grants: grants.grants,
        audit: audit.entries,
      });
    } catch (cause) {
      if (seqRef.current !== seq) return;
      if (cause instanceof HqHttpError && cause.status === 403) setForbidden(true);
      else setError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    // The step-up countdown is shown in minutes; a 30 s tick keeps it honest.
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      seqRef.current += 1;
      window.clearInterval(timer);
      window.clearInterval(clock);
    };
  }, [load]);

  const gate = status ? vaultGate(status, now) : null;
  const grantCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const grant of data.grants)
      counts.set(grant.secretId, (counts.get(grant.secretId) ?? 0) + 1);
    return counts;
  }, [data.grants]);

  return (
    <div
      className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6"
      data-testid="vault-view"
    >
      <header className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <KeySquare className="size-5" aria-hidden />
          Keys
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Store provider keys once on HQ and give each machine exactly the keys it needs. Values are
          encrypted here and sealed to each device; this page never shows one again.
        </p>
      </header>

      {forbidden && (
        <p className="text-sm text-muted-foreground">
          The key vault needs an admin sign-in (the HQ password or a token with auth.admin).
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {status === null && !forbidden && error === null && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}

      {status !== null && gate !== null && (
        <>
          <GatePanel gate={gate} status={status} onChanged={load} />
          {gate.canRead && (
            <>
              <SecretsPanel
                secrets={data.secrets}
                grantCounts={grantCounts}
                canWrite={gate.canWrite}
                now={now}
                onChanged={load}
              />
              <DevicesPanel
                devices={data.devices}
                identity={status.identity}
                canWrite={gate.canWrite}
                now={now}
                onChanged={load}
              />
              <GrantsPanel
                secrets={data.secrets}
                devices={data.devices}
                grants={data.grants}
                canWrite={gate.canWrite}
                onChanged={load}
              />
              <AuditPanel data={data} now={now} />
            </>
          )}
        </>
      )}
    </div>
  );
}

function AuditPanel({ data, now }: { data: VaultData; now: number }): ReactNode {
  const secrets = useMemo(() => new Map(data.secrets.map((s) => [s.id, s])), [data.secrets]);
  const devices = useMemo(() => new Map(data.devices.map((d) => [d.id, d])), [data.devices]);
  return (
    <VaultSection
      title="Activity"
      description="Every store, replacement, grant, revocation and device fetch. The log never holds a key."
    >
      {data.audit.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet.</p>
      ) : (
        <ul className="flex flex-col border border-border text-sm" data-testid="vault-audit">
          {data.audit.map((entry, index) => (
            <li
              key={`${entry.at}-${entry.kind}-${index}`}
              className="flex flex-wrap gap-x-4 border-b border-border px-3 py-1.5 last:border-b-0"
            >
              <span className="min-w-48 flex-1">{auditSentence(entry, secrets, devices)}</span>
              <span className="text-xs text-muted-foreground">
                {auditActor(entry.actor, devices)} · {relativeTime(entry.at, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </VaultSection>
  );
}
