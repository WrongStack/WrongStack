'use client';

/**
 * Who gets which key: a key × device matrix. A grant is delivered the next
 * time the device syncs; taking it back stops further delivery.
 */
import {
  createVaultGrant,
  type HqVaultDeviceRecord,
  type HqVaultGrantRecord,
  type HqVaultSecretMeta,
  revokeVaultGrant,
} from '@hq/data/vault-api';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId, useMemo, useState } from 'react';
import { deviceName, grantMatrix } from './model';
import { field, label, MessageLine, primaryButton, useVaultAction, VaultSection } from './shared';

export function GrantsPanel({
  secrets,
  devices,
  grants,
  canWrite,
  onChanged,
}: {
  secrets: readonly HqVaultSecretMeta[];
  devices: readonly HqVaultDeviceRecord[];
  grants: readonly HqVaultGrantRecord[];
  canWrite: boolean;
  onChanged: () => Promise<void>;
}): ReactNode {
  const matrix = useMemo(() => grantMatrix(secrets, devices, grants), [secrets, devices, grants]);
  const { busy, message, run } = useVaultAction();
  if (secrets.length === 0 || matrix.devices.length === 0) {
    return (
      <VaultSection title="Access" description="Which device receives which key.">
        <p className="text-sm text-muted-foreground">
          Store a key and enroll a device first; then choose here who gets what.
        </p>
      </VaultSection>
    );
  }
  return (
    <VaultSection
      title="Access"
      description="Which device receives which key. 'kept' devices store it in their own encrypted config; 'lease' devices hold it in memory only, for the lease time."
    >
      {canWrite && (
        <GrantForm
          secrets={matrix.rows.map((r) => r.secret)}
          devices={matrix.devices}
          grants={grants}
          onChanged={onChanged}
        />
      )}
      <div className="overflow-x-auto">
        <table className="min-w-full border border-border text-sm" data-testid="vault-grants">
          <thead>
            <tr className="bg-muted/40">
              <th className="px-3 py-2 text-left font-medium">Key</th>
              {matrix.devices.map((device) => (
                <th key={device.id} className="px-3 py-2 text-left font-medium">
                  {deviceName(device)}
                  {device.status === 'pending' && (
                    <span className="block text-xs font-normal text-warning">not approved</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => (
              <tr key={row.secret.id} className="border-t border-border">
                <td className="px-3 py-2">
                  <span className="font-medium">{row.secret.label}</span>{' '}
                  <span className="text-muted-foreground">{row.secret.providerId}</span>
                </td>
                {row.cells.map((cell) => (
                  <td key={cell.deviceId} className="px-3 py-2">
                    {cell.grant === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <span>
                          {cell.grant.policy === 'lease' ? 'lease' : 'kept'}
                          {cell.grant.setActive ? ', active' : ''}
                        </span>
                        {canWrite && (
                          <button
                            type="button"
                            disabled={busy}
                            aria-label={`Take ${row.secret.label} back from this device`}
                            className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                            onClick={() => {
                              const grantId = cell.grant?.id;
                              if (grantId === undefined) return;
                              void run(async () => {
                                await revokeVaultGrant(grantId);
                                await onChanged();
                              });
                            }}
                          >
                            <X className="size-3.5" />
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <MessageLine message={message} />
    </VaultSection>
  );
}

function GrantForm({
  secrets,
  devices,
  grants,
  onChanged,
}: {
  secrets: readonly HqVaultSecretMeta[];
  devices: readonly HqVaultDeviceRecord[];
  grants: readonly HqVaultGrantRecord[];
  onChanged: () => Promise<void>;
}): ReactNode {
  const id = useId();
  const [secretId, setSecretId] = useState(secrets[0]?.id ?? '');
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? '');
  const [policy, setPolicy] = useState<'local' | 'lease'>('local');
  const [leaseHours, setLeaseHours] = useState(1);
  const [setActive, setSetActive] = useState(false);
  const { busy, message, run } = useVaultAction();
  const already = grants.some((g) => g.secretId === secretId && g.deviceId === deviceId);
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (already || busy || secretId === '' || deviceId === '') return;
        void run(async () => {
          await createVaultGrant({
            secretId,
            deviceId,
            policy,
            setActive,
            ...(policy === 'lease' ? { leaseTtlSeconds: Math.round(leaseHours * 3600) } : {}),
          });
          await onChanged();
        }, 'Granted. The device picks it up on its next sync.');
      }}
    >
      <div className="flex min-w-48 flex-col gap-1.5">
        <label htmlFor={`${id}-key`} className={label}>
          Key
        </label>
        <select
          id={`${id}-key`}
          className={field}
          value={secretId}
          onChange={(e) => setSecretId(e.target.value)}
        >
          {secrets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label} ({s.providerId})
            </option>
          ))}
        </select>
      </div>
      <div className="flex min-w-48 flex-col gap-1.5">
        <label htmlFor={`${id}-device`} className={label}>
          Device
        </label>
        <select
          id={`${id}-device`}
          className={field}
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
        >
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {deviceName(d)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-policy`} className={label}>
          Keep it
        </label>
        <select
          id={`${id}-policy`}
          className={field}
          value={policy}
          onChange={(e) => setPolicy(e.target.value === 'lease' ? 'lease' : 'local')}
        >
          <option value="local">in the device's config</option>
          <option value="lease">in memory only (lease)</option>
        </select>
      </div>
      {policy === 'lease' && (
        <div className="flex w-28 flex-col gap-1.5">
          <label htmlFor={`${id}-hours`} className={label}>
            Lease hours
          </label>
          <input
            id={`${id}-hours`}
            type="number"
            min={1}
            max={168}
            className={field}
            value={leaseHours}
            onChange={(e) => setLeaseHours(Math.min(168, Math.max(1, Number(e.target.value) || 1)))}
          />
        </div>
      )}
      <label className="flex h-10 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={setActive}
          onChange={(e) => setSetActive(e.target.checked)}
        />
        Make it the active key
      </label>
      <button
        type="submit"
        disabled={busy || already}
        className={primaryButton.replace('self-start', 'self-end')}
      >
        {already ? 'Already granted' : busy ? 'Granting…' : 'Grant'}
      </button>
      <div className="basis-full">
        <MessageLine message={message} />
      </div>
    </form>
  );
}
