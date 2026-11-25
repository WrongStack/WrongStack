'use client';

/**
 * One saved provider profile, laid out like WebUI's provider card: logo,
 * alias, family and endpoint; its keys (masked, active one marked) with
 * set-active / replace / delete; an inline "add key" form; the devices it is
 * granted to as toggle chips; and edit / remove for the profile itself.
 * Every change re-reads the page's state through `onChanged`.
 */
import {
  deleteVaultKey,
  deleteVaultProfile,
  type HqVaultDeviceRecord,
  type HqVaultKeyMeta,
  type HqVaultProfileMeta,
  setVaultGrant,
  setVaultKey,
  updateVaultProfile,
} from '@hq/data/vault-api';
import { Check, KeyRound, Laptop, MemoryStick, Pencil, Plus, Server, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import { relativeTime } from '@/features/attention/model';
import { cn } from '@/lib/cn';
import { providerBrand } from './brand';
import {
  baseUrlError,
  deviceName,
  keyFormError,
  maskedKey,
  parseModelList,
  profileFamilyLabel,
  WIRE_FAMILIES,
} from './model';
import {
  dangerButton,
  field,
  label,
  MessageLine,
  primaryButton,
  smallButton,
  useVaultAction,
} from './shared';

export function ProviderLogo({
  id,
  type,
  baseUrl,
  size = 'md',
}: {
  id: string;
  type?: string;
  baseUrl?: string;
  size?: 'sm' | 'md';
}): ReactNode {
  const brand = providerBrand(id, {
    ...(type ? { type } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  });
  const box = size === 'sm' ? 'size-8' : 'size-10';
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center border border-border',
        brand?.name === 'Kimi' ? 'bg-neutral-900' : 'bg-white',
        box,
      )}
      aria-hidden
    >
      {brand ? (
        <img src={brand.src} alt="" className={size === 'sm' ? 'size-5' : 'size-6'} />
      ) : (
        <Server className="size-5 text-neutral-500" />
      )}
    </span>
  );
}

export function ProfileCard({
  profile,
  devices,
  canWrite,
  now,
  onChanged,
}: {
  profile: HqVaultProfileMeta;
  devices: readonly HqVaultDeviceRecord[];
  canWrite: boolean;
  now: number;
  onChanged: () => Promise<void>;
}): ReactNode {
  const [mode, setMode] = useState<'view' | 'add-key' | 'edit' | 'remove'>('view');
  const { busy, message, run } = useVaultAction();
  const live = devices.filter((d) => d.status !== 'revoked');
  const granted = new Set(profile.deviceIds);
  const leased = new Set(profile.leaseDeviceIds ?? []);
  const typeNote = profile.type !== profile.id ? profile.type : null;
  const familyLabel = profileFamilyLabel(profile);

  return (
    <article
      className="flex flex-col border border-border bg-card"
      data-testid="vault-profile"
      aria-label={profile.id}
    >
      <header className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-3">
        <ProviderLogo id={profile.id} type={profile.type} baseUrl={profile.baseUrl} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{profile.id}</h3>
            {familyLabel && (
              <span className="border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {familyLabel}
              </span>
            )}
            {typeNote && <span className="text-xs text-muted-foreground">from {typeNote}</span>}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground" title={profile.baseUrl}>
            {profile.baseUrl ?? 'catalog endpoint'}
            {profile.models?.length
              ? ` · ${profile.models.length} model${profile.models.length === 1 ? '' : 's'}`
              : ''}
          </p>
        </div>
        {canWrite && mode === 'view' && (
          <div className="flex gap-1.5">
            <button type="button" className={smallButton} onClick={() => setMode('edit')}>
              <Pencil className="mr-1 size-3.5" aria-hidden />
              Edit
            </button>
            <button
              type="button"
              className={dangerButton}
              onClick={() => setMode('remove')}
              aria-label={`Remove ${profile.id}`}
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </div>
        )}
      </header>

      {mode === 'remove' && (
        <div className="flex flex-wrap items-center gap-2 border-b border-destructive/40 bg-destructive/5 px-4 py-2">
          <span className="flex-1 text-xs">
            Remove {profile.id} and its {profile.keys.length} key
            {profile.keys.length === 1 ? '' : 's'} from HQ? Devices drop it on their next sync.
          </span>
          <button
            type="button"
            disabled={busy}
            className={dangerButton}
            onClick={() =>
              void run(async () => {
                await deleteVaultProfile(profile.id);
                await onChanged();
              })
            }
          >
            {busy ? 'Removing…' : 'Remove provider'}
          </button>
          <button type="button" className={smallButton} onClick={() => setMode('view')}>
            Keep
          </button>
        </div>
      )}

      {mode === 'edit' && (
        <EditProfileForm
          profile={profile}
          onDone={async (changed) => {
            setMode('view');
            if (changed) await onChanged();
          }}
        />
      )}

      <ul className="flex flex-col" aria-label={`${profile.id} keys`}>
        {profile.keys.length === 0 && (
          <li className="px-4 py-3 text-sm text-muted-foreground">
            No key yet — devices get the endpoint but cannot call it.
          </li>
        )}
        {profile.keys.map((key) => (
          <KeyRow
            key={key.id}
            profile={profile}
            vaultKey={key}
            active={profile.activeKey === key.label}
            canWrite={canWrite}
            now={now}
            onChanged={onChanged}
          />
        ))}
      </ul>

      {mode === 'add-key' ? (
        <KeyForm
          profileId={profile.id}
          suggestedLabel={profile.keys.length === 0 ? 'default' : ''}
          onDone={async (saved) => {
            setMode('view');
            if (saved) await onChanged();
          }}
        />
      ) : (
        canWrite &&
        mode === 'view' && (
          <div className="border-t border-border px-4 py-2">
            <button type="button" className={smallButton} onClick={() => setMode('add-key')}>
              <Plus className="mr-1 size-3.5" aria-hidden />
              Add key
            </button>
          </div>
        )
      )}

      <footer className="flex flex-wrap items-center gap-1.5 border-t border-border bg-muted/20 px-4 py-2">
        <span className="mr-1 flex items-center gap-1 text-xs text-muted-foreground">
          <Laptop className="size-3.5" aria-hidden />
          Devices
        </span>
        {live.length === 0 && (
          <span className="text-xs text-muted-foreground">none enrolled — see the Devices tab</span>
        )}
        {live.map((device) => {
          const on = granted.has(device.id);
          const lease = leased.has(device.id);
          const pending = device.status === 'pending';
          return (
            <span key={device.id} className="inline-flex">
              <button
                type="button"
                role="switch"
                aria-checked={on}
                disabled={!canWrite || busy || (pending && !on)}
                title={pending ? 'Approve this device first' : on ? 'Take it back' : 'Give it'}
                className={cn(
                  'inline-flex h-7 items-center gap-1 border px-2 text-xs disabled:opacity-50',
                  on
                    ? 'border-success/60 bg-success/10 text-foreground'
                    : 'border-border text-muted-foreground hover:bg-muted',
                )}
                onClick={() =>
                  void run(async () => {
                    await setVaultGrant(profile.id, device.id, !on);
                    await onChanged();
                  })
                }
              >
                {on && <Check className="size-3" aria-hidden />}
                {deviceName(device)}
              </button>
              {on && (
                <button
                  type="button"
                  role="switch"
                  aria-checked={lease}
                  aria-label={`Memory only on ${deviceName(device)}`}
                  disabled={!canWrite || busy}
                  title={
                    lease
                      ? 'Memory only: the device never writes these keys to disk and loses them without HQ. Click to let it store them.'
                      : 'Stored on the device (encrypted). Click to keep them in memory only — a copy already stored there stays until you rotate the key.'
                  }
                  className={cn(
                    'inline-flex h-7 items-center border border-l-0 px-1.5 disabled:opacity-50',
                    lease
                      ? 'border-success/60 bg-success/10 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted',
                  )}
                  onClick={() =>
                    void run(async () => {
                      await setVaultGrant(profile.id, device.id, true, !lease);
                      await onChanged();
                    })
                  }
                >
                  <MemoryStick className="size-3" aria-hidden />
                </button>
              )}
            </span>
          );
        })}
      </footer>
      {message && (
        <div className="px-4 pb-2">
          <MessageLine message={message} />
        </div>
      )}
    </article>
  );
}

function KeyRow({
  profile,
  vaultKey,
  active,
  canWrite,
  now,
  onChanged,
}: {
  profile: HqVaultProfileMeta;
  vaultKey: HqVaultKeyMeta;
  active: boolean;
  canWrite: boolean;
  now: number;
  onChanged: () => Promise<void>;
}): ReactNode {
  const [mode, setMode] = useState<'view' | 'replace' | 'delete'>('view');
  const { busy, message, run } = useVaultAction();
  const oauth = vaultKey.authMethod === 'oauth';
  return (
    <li className="flex flex-col gap-2 border-t border-border px-4 py-2 first:border-t-0 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <KeyRound
          className={cn('size-4 shrink-0', active ? 'text-success' : 'text-muted-foreground')}
          aria-hidden
        />
        <span className="font-medium">{vaultKey.label}</span>
        {active && (
          <span className="bg-success/15 px-1.5 py-0.5 text-[11px] font-medium text-success">
            active
          </span>
        )}
        <span className="font-mono text-xs text-muted-foreground">{maskedKey(vaultKey.hint)}</span>
        <span className="border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {oauth
            ? `sign-in${vaultKey.oauthStrategyId ? ` · ${vaultKey.oauthStrategyId}` : ''}`
            : 'API key'}
        </span>
        <span className="flex-1 text-xs text-muted-foreground">
          v{vaultKey.version} · {relativeTime(vaultKey.updatedAt, now)}
          {vaultKey.accountId ? ` · ${vaultKey.accountId}` : ''}
        </span>
        {canWrite && mode === 'view' && (
          <span className="flex gap-1.5">
            {!active && (
              <button
                type="button"
                disabled={busy}
                className={smallButton}
                onClick={() =>
                  void run(async () => {
                    await updateVaultProfile(profile.id, { activeKey: vaultKey.label });
                    await onChanged();
                  })
                }
              >
                Use this
              </button>
            )}
            {!oauth && (
              <button type="button" className={smallButton} onClick={() => setMode('replace')}>
                Replace
              </button>
            )}
            <button
              type="button"
              className={dangerButton}
              aria-label={`Delete key ${vaultKey.label}`}
              onClick={() => setMode('delete')}
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </span>
        )}
      </div>
      {mode === 'replace' && (
        <KeyForm
          profileId={profile.id}
          fixedLabel={vaultKey.label}
          onDone={async (saved) => {
            setMode('view');
            if (saved) await onChanged();
          }}
        />
      )}
      {mode === 'delete' && (
        <div className="flex flex-wrap items-center gap-2 border border-destructive/40 bg-destructive/5 p-2">
          <span className="flex-1 text-xs">
            Delete {vaultKey.label}? Devices drop it on their next sync.
          </span>
          <button
            type="button"
            disabled={busy}
            className={dangerButton}
            onClick={() =>
              void run(async () => {
                await deleteVaultKey(profile.id, vaultKey.id);
                await onChanged();
              })
            }
          >
            {busy ? 'Deleting…' : 'Delete key'}
          </button>
          <button type="button" className={smallButton} onClick={() => setMode('view')}>
            Keep
          </button>
        </div>
      )}
      <MessageLine message={message} />
    </li>
  );
}

/** Add a key, or (with `fixedLabel`) replace that key's value. */
export function KeyForm({
  profileId,
  fixedLabel,
  suggestedLabel = '',
  onDone,
}: {
  profileId: string;
  fixedLabel?: string;
  suggestedLabel?: string;
  onDone: (saved: boolean) => Promise<void>;
}): ReactNode {
  const id = useId();
  const [keyLabel, setKeyLabel] = useState(fixedLabel ?? suggestedLabel);
  const [apiKey, setApiKey] = useState('');
  const { busy, message, setMessage, run } = useVaultAction();
  return (
    <form
      className="flex flex-col gap-3 border-t border-border bg-muted/20 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        const problem = keyFormError({ label: keyLabel, apiKey });
        if (problem) {
          setMessage({ tone: 'error', text: problem });
          return;
        }
        void run(async () => {
          await setVaultKey(profileId, { label: keyLabel.trim(), apiKey: apiKey.trim() });
          setApiKey('');
          await onDone(true);
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
        {fixedLabel === undefined && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-label`} className={label}>
              Key name
            </label>
            <input
              id={`${id}-label`}
              className={field}
              placeholder="team"
              value={keyLabel}
              onChange={(event) => setKeyLabel(event.target.value)}
            />
          </div>
        )}
        <div className={cn('flex flex-col gap-1.5', fixedLabel !== undefined && 'sm:col-span-2')}>
          <label htmlFor={`${id}-key`} className={label}>
            {fixedLabel !== undefined ? `New value for ${fixedLabel}` : 'API key'}
          </label>
          <input
            id={`${id}-key`}
            className={cn(field, 'font-mono')}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-…"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </div>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? 'Saving…' : fixedLabel !== undefined ? 'Replace key' : 'Save key'}
        </button>
        <button type="button" className="h-10 px-3 text-sm" onClick={() => void onDone(false)}>
          Cancel
        </button>
      </div>
      <MessageLine message={message} />
    </form>
  );
}

function EditProfileForm({
  profile,
  onDone,
}: {
  profile: HqVaultProfileMeta;
  onDone: (changed: boolean) => Promise<void>;
}): ReactNode {
  const id = useId();
  const [baseUrl, setBaseUrl] = useState(profile.baseUrl ?? '');
  const [family, setFamily] = useState(profile.family ?? '');
  const [models, setModels] = useState((profile.models ?? []).join(', '));
  const { busy, message, setMessage, run } = useVaultAction();
  return (
    <form
      className="flex flex-col gap-3 border-b border-border bg-muted/20 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        const problem = baseUrlError(baseUrl, false);
        if (problem) {
          setMessage({ tone: 'error', text: problem });
          return;
        }
        void run(async () => {
          await updateVaultProfile(profile.id, {
            baseUrl: baseUrl.trim() || null,
            family: family || null,
            models: parseModelList(models) ?? null,
          });
          await onDone(true);
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <label htmlFor={`${id}-url`} className={label}>
            Endpoint
          </label>
          <input
            id={`${id}-url`}
            className={cn(field, 'font-mono')}
            placeholder="empty = the catalog's endpoint"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-family`} className={label}>
            Speaks
          </label>
          <select
            id={`${id}-family`}
            className={field}
            value={family}
            onChange={(event) => setFamily(event.target.value)}
          >
            <option value="">The catalog's choice</option>
            {WIRE_FAMILIES.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-models`} className={label}>
            Models (optional)
          </label>
          <input
            id={`${id}-models`}
            className={field}
            placeholder="empty = every catalog model"
            value={models}
            onChange={(event) => setModels(event.target.value)}
          />
        </div>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" className="h-10 px-3 text-sm" onClick={() => void onDone(false)}>
          Cancel
        </button>
      </div>
      <MessageLine message={message} />
    </form>
  );
}
