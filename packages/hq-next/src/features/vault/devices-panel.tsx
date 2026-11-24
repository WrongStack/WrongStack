'use client';

/**
 * Devices that may receive keys: each enrolled with a one-time code from this
 * page, identified by its own key pair (the fingerprint), approved or revoked
 * here. Revoking stops delivery at once; it cannot recall a key the device
 * already imported.
 */
import {
  type HqVaultDeviceRecord,
  type HqVaultIdentity,
  mintVaultEnrollment,
  setVaultDeviceStatus,
  type VaultEnrollment,
} from '@hq/data/vault-api';
import { Copy } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import { relativeTime } from '@/features/attention/model';
import { cn } from '@/lib/cn';
import { deviceName } from './model';
import {
  dangerButton,
  Fingerprint,
  field,
  label,
  MessageLine,
  primaryButton,
  smallButton,
  useVaultAction,
  VaultSection,
} from './shared';

export function DevicesPanel({
  devices,
  identity,
  canWrite,
  now,
  onChanged,
}: {
  devices: readonly HqVaultDeviceRecord[];
  identity: HqVaultIdentity | undefined;
  canWrite: boolean;
  now: number;
  onChanged: () => Promise<void>;
}): ReactNode {
  const [enrolling, setEnrolling] = useState(false);
  const live = devices.filter((d) => d.status !== 'revoked');
  const revoked = devices.length - live.length;
  return (
    <VaultSection
      title="Devices"
      description="Machines that can receive keys. A device enrolls with a one-time code and proves itself with its own keys on every request."
      actions={
        canWrite && !enrolling ? (
          <button type="button" className={smallButton} onClick={() => setEnrolling(true)}>
            Enroll a device
          </button>
        ) : null
      }
    >
      {identity !== undefined && (
        <p className="text-xs text-muted-foreground">
          This HQ's fingerprint: <Fingerprint value={identity.fingerprint} />
        </p>
      )}
      {enrolling && canWrite && (
        <EnrollForm onClose={() => setEnrolling(false)} onChanged={onChanged} />
      )}
      {live.length === 0 ? (
        <p className="text-sm text-muted-foreground">No device enrolled yet.</p>
      ) : (
        <ul className="flex flex-col border border-border" data-testid="vault-devices">
          {live.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              canWrite={canWrite}
              now={now}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
      {revoked > 0 && (
        <p className="text-xs text-muted-foreground">
          {revoked} revoked device{revoked === 1 ? '' : 's'} hidden; a revoked device must enroll
          again with new keys.
        </p>
      )}
    </VaultSection>
  );
}

function EnrollForm({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => Promise<void>;
}): ReactNode {
  const id = useId();
  const [name, setName] = useState('');
  const [autoApprove, setAutoApprove] = useState(true);
  const [minted, setMinted] = useState<VaultEnrollment | null>(null);
  const [copied, setCopied] = useState(false);
  const { busy, message, run } = useVaultAction();
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const command = minted ? `wstack hq enroll ${origin} ${minted.enrollmentToken}` : '';

  if (minted) {
    return (
      <div
        className="flex max-w-2xl flex-col gap-3 border border-border p-4"
        data-testid="vault-enrollment"
      >
        <p className="text-sm">
          Run this on the device within 10 minutes. The code works once and is not shown again.
        </p>
        <div className="flex items-start gap-2">
          <code className="min-w-0 flex-1 break-all border border-border bg-muted/40 p-2 font-mono text-xs">
            {command}
          </code>
          <button
            type="button"
            className={smallButton}
            onClick={() => {
              void navigator.clipboard?.writeText(command).then(() => setCopied(true));
            }}
          >
            <Copy className="mr-1 size-3.5" aria-hidden />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          The device prints HQ's fingerprint; it must read{' '}
          <Fingerprint value={minted.hq.fingerprint} />
        </p>
        <button
          type="button"
          className={smallButton}
          onClick={() => {
            onClose();
            void onChanged();
          }}
        >
          Done
        </button>
      </div>
    );
  }
  return (
    <form
      className="flex max-w-xl flex-col gap-3 border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          setMinted(
            await mintVaultEnrollment({
              ...(name.trim() ? { label: name.trim() } : {}),
              autoApprove,
            }),
          );
        });
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-name`} className={label}>
          Device name (optional)
        </label>
        <input
          id={`${id}-name`}
          className={field}
          placeholder="LAB-02"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={autoApprove}
          onChange={(event) => setAutoApprove(event.target.checked)}
        />
        Approve it as soon as it enrolls
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? 'Creating…' : 'Create enrollment code'}
        </button>
        <button type="button" className="h-10 px-3 text-sm" onClick={onClose}>
          Cancel
        </button>
      </div>
      <MessageLine message={message} />
    </form>
  );
}

function DeviceRow({
  device,
  canWrite,
  now,
  onChanged,
}: {
  device: HqVaultDeviceRecord;
  canWrite: boolean;
  now: number;
  onChanged: () => Promise<void>;
}): ReactNode {
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const { busy, message, run } = useVaultAction();
  const act = (action: 'approve' | 'revoke'): void => {
    void run(async () => {
      await setVaultDeviceStatus(device.id, action);
      await onChanged();
    });
  };
  return (
    <li className="flex flex-col gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="min-w-48 flex-1 break-words">
          <span className="font-medium">{deviceName(device)}</span>
          {device.label !== undefined && (
            <span className="ml-2 text-xs text-muted-foreground">{device.hostname}</span>
          )}
          <span
            className={cn(
              'ml-2 text-xs',
              device.status === 'pending' ? 'text-warning' : 'text-muted-foreground',
            )}
          >
            {device.status === 'pending' ? 'waiting for approval' : 'approved'}
          </span>
          <span className="block">
            <Fingerprint value={device.fingerprint} />
          </span>
        </span>
        <span className="text-xs text-muted-foreground">
          enrolled {relativeTime(device.enrolledAt, now)} ·{' '}
          {device.lastFetchAt
            ? `fetched ${relativeTime(device.lastFetchAt, now)}`
            : 'never fetched'}
        </span>
        {canWrite && (
          <span className="flex gap-2">
            {device.status === 'pending' && (
              <button
                type="button"
                disabled={busy}
                className={smallButton}
                onClick={() => act('approve')}
              >
                Approve
              </button>
            )}
            {!confirmRevoke && (
              <button type="button" className={dangerButton} onClick={() => setConfirmRevoke(true)}>
                Revoke
              </button>
            )}
          </span>
        )}
      </div>
      {confirmRevoke && (
        <div className="flex flex-wrap items-center gap-2 border border-destructive/40 bg-destructive/5 p-2">
          <span className="flex-1 text-xs">
            The device loses every key grant and cannot fetch again with these keys. Keys it already
            imported stay on it until removed there.
          </span>
          <button
            type="button"
            disabled={busy}
            className={dangerButton}
            onClick={() => act('revoke')}
          >
            {busy ? 'Revoking…' : 'Revoke device'}
          </button>
          <button type="button" className={smallButton} onClick={() => setConfirmRevoke(false)}>
            Keep
          </button>
        </div>
      )}
      <MessageLine message={message} />
    </li>
  );
}
