'use client';

/**
 * System → Providers: every model provider, its keys and which machines get
 * them, managed once on HQ.
 *
 * Laid out like WebUI's provider screen — Saved providers as cards, a
 * searchable catalog to add from (or a custom endpoint), Devices, Activity —
 * over HQ's key vault: keys are encrypted here and sealed to each device; the
 * page shows only their last four characters. Reads are free for an admin;
 * every change waits on the gate (a password exists, the vault is unsealed,
 * the connection keeps a pasted key off the wire, and the operator unlocked in
 * the last 10 minutes). Every mutation re-reads the whole state.
 */
import { HqHttpError } from '@hq/data/api';
import {
  fetchVaultAudit,
  fetchVaultCatalog,
  fetchVaultDevices,
  fetchVaultProfiles,
  fetchVaultSignInStrategies,
  fetchVaultStatus,
  type HqVaultAuditEntry,
  type HqVaultDeviceRecord,
  type HqVaultProfileMeta,
  type VaultCatalogProvider,
  type VaultSignInStrategy,
  type VaultStatus,
} from '@hq/data/vault-api';
import { KeySquare, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { relativeTime } from '@/features/attention/model';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/error-text';
import { CatalogPanel } from './catalog-panel';
import { DevicesPanel } from './devices-panel';
import { GateBanner, LockControl } from './gate-panel';
import { auditActor, auditSentence, vaultGate } from './model';
import { ProfileCard } from './profile-card';
import { smallButton } from './shared';
import { SignInPanel } from './signin-panel';

type Tab = 'saved' | 'add' | 'signin' | 'devices' | 'activity';

interface VaultData {
  profiles: HqVaultProfileMeta[];
  devices: HqVaultDeviceRecord[];
  audit: HqVaultAuditEntry[];
}

const EMPTY: VaultData = { profiles: [], devices: [], audit: [] };

export function VaultView(): ReactNode {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [data, setData] = useState<VaultData>(EMPTY);
  const [catalog, setCatalog] = useState<VaultCatalogProvider[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [strategies, setStrategies] = useState<VaultSignInStrategy[] | null>(null);
  const [strategiesError, setStrategiesError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('saved');
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
      const [profiles, devices, audit] = await Promise.all([
        fetchVaultProfiles(),
        fetchVaultDevices(),
        fetchVaultAudit(80),
      ]);
      if (seqRef.current !== seq) return;
      setData({ profiles: profiles.profiles, devices: devices.devices, audit: audit.entries });
    } catch (cause) {
      if (seqRef.current !== seq) return;
      if (cause instanceof HqHttpError && cause.status === 403) setForbidden(true);
      else setError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    // The unlock countdown is shown in minutes; a 30 s tick keeps it honest.
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      seqRef.current += 1;
      window.clearInterval(timer);
      window.clearInterval(clock);
    };
  }, [load]);

  // The catalog is large and changes rarely: fetched once, when first needed.
  const wantCatalog = tab === 'add';
  useEffect(() => {
    if (!wantCatalog || catalog !== null) return;
    let live = true;
    fetchVaultCatalog()
      .then((result) => live && setCatalog(result.providers))
      .catch((cause) => {
        if (!live) return;
        setCatalog([]);
        setCatalogError(errorText(cause));
      });
    return () => {
      live = false;
    };
  }, [wantCatalog, catalog]);

  const wantStrategies = tab === 'signin';
  useEffect(() => {
    if (!wantStrategies || strategies !== null) return;
    let live = true;
    fetchVaultSignInStrategies()
      .then((result) => live && setStrategies(result.strategies))
      .catch((cause) => live && setStrategiesError(errorText(cause)));
    return () => {
      live = false;
    };
  }, [wantStrategies, strategies]);

  const gate = status ? vaultGate(status, now) : null;
  const pending = data.devices.filter((d) => d.status === 'pending').length;
  const liveDevices = data.devices.filter((d) => d.status !== 'revoked').length;
  const tabs: { id: Tab; label: string; count?: number; alert?: boolean }[] = [
    { id: 'saved', label: 'Saved', count: data.profiles.length },
    { id: 'add', label: 'Add provider' },
    { id: 'signin', label: 'Sign in' },
    { id: 'devices', label: 'Devices', count: liveDevices, alert: pending > 0 },
    { id: 'activity', label: 'Activity' },
  ];

  return (
    <div
      className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6"
      data-testid="vault-view"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <KeySquare className="size-5" aria-hidden />
            Providers
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Every model provider, its API keys and which machines get them — set up once here. Keys
            are encrypted on HQ and sealed to each device; this page never shows one again.
          </p>
        </div>
        {status !== null && gate !== null && (
          <LockControl gate={gate} status={status} onChanged={load} />
        )}
      </header>

      {forbidden && (
        <p className="text-sm text-muted-foreground">
          Providers need an admin sign-in (the HQ password or a token with auth.admin).
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
          <GateBanner gate={gate} onChanged={load} />
          {gate.canRead && (
            <>
              <div
                role="tablist"
                aria-label="Providers"
                className="flex gap-1 overflow-x-auto border-b border-border"
              >
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.id}
                    onClick={() => setTab(t.id)}
                    className={cn(
                      '-mb-px flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm',
                      tab === t.id
                        ? 'border-primary font-medium text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t.label}
                    {t.count !== undefined && (
                      <span className="bg-muted px-1.5 text-xs tabular-nums">{t.count}</span>
                    )}
                    {t.alert && (
                      <span
                        className="size-2 rounded-full bg-warning"
                        title="A device is waiting for approval"
                        aria-hidden
                      />
                    )}
                    {t.alert && <span className="sr-only">, a device is waiting for approval</span>}
                  </button>
                ))}
              </div>

              {tab === 'saved' && (
                <SavedPanel
                  profiles={data.profiles}
                  devices={data.devices}
                  canWrite={gate.canWrite}
                  now={now}
                  onChanged={load}
                  onAdd={() => setTab('add')}
                />
              )}
              {tab === 'add' && (
                <CatalogPanel
                  catalog={catalog}
                  catalogError={catalogError}
                  profiles={data.profiles}
                  canWrite={gate.canWrite}
                  onSaved={async () => {
                    await load();
                    setTab('saved');
                  }}
                  onSignIn={() => setTab('signin')}
                />
              )}
              {tab === 'signin' && (
                <SignInPanel
                  strategies={strategies}
                  strategiesError={strategiesError}
                  profiles={data.profiles}
                  canWrite={gate.canWrite}
                  onSaved={load}
                />
              )}
              {tab === 'devices' && (
                <DevicesPanel
                  devices={data.devices}
                  profiles={data.profiles}
                  identity={status.identity}
                  canWrite={gate.canWrite}
                  now={now}
                  onChanged={load}
                />
              )}
              {tab === 'activity' && <AuditPanel data={data} now={now} />}
            </>
          )}
        </>
      )}
    </div>
  );
}

function SavedPanel({
  profiles,
  devices,
  canWrite,
  now,
  onChanged,
  onAdd,
}: {
  profiles: readonly HqVaultProfileMeta[];
  devices: readonly HqVaultDeviceRecord[];
  canWrite: boolean;
  now: number;
  onChanged: () => Promise<void>;
  onAdd: () => void;
}): ReactNode {
  const sorted = useMemo(() => [...profiles].sort((a, b) => a.id.localeCompare(b.id)), [profiles]);
  if (sorted.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 border border-dashed border-border p-6">
        <p className="font-medium">No provider on HQ yet</p>
        <p className="max-w-xl text-sm text-muted-foreground">
          Add one from the catalog (OpenAI, Anthropic, Google, OpenRouter, …) or a custom endpoint,
          then give it to the machines that should use it.
        </p>
        <button type="button" className={smallButton} onClick={onAdd}>
          <Plus className="mr-1 size-3.5" aria-hidden />
          Add provider
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="vault-profiles">
      {sorted.map((profile) => (
        <ProfileCard
          key={profile.id}
          profile={profile}
          devices={devices}
          canWrite={canWrite}
          now={now}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

function AuditPanel({ data, now }: { data: VaultData; now: number }): ReactNode {
  const devices = useMemo(() => new Map(data.devices.map((d) => [d.id, d])), [data.devices]);
  if (data.audit.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing yet.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        Every change, grant and device fetch, newest first. The log never holds a key.
      </p>
      <ul className="flex flex-col border border-border text-sm" data-testid="vault-audit">
        {data.audit.map((entry, index) => (
          <li
            key={`${entry.at}-${entry.kind}-${index}`}
            className="flex flex-wrap gap-x-4 border-b border-border px-3 py-1.5 last:border-b-0"
          >
            <span className="min-w-48 flex-1">{auditSentence(entry, devices)}</span>
            <span className="text-xs text-muted-foreground">
              {auditActor(entry.actor, devices)} · {relativeTime(entry.at, now)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
