'use client';

/**
 * What stands between the operator and a change — and the form that removes
 * it: unseal a passphrase-protected vault (banner), or confirm the HQ password
 * (and authenticator code) for a 10-minute window (header lock + dialog).
 */
import { PasswordInput } from '@hq/components/hq/password-input';
import { elevateVault, unsealVault, type VaultStatus } from '@hq/data/vault-api';
import { Lock, LockOpen, ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import type { VaultGate } from './model';
import { field, label, MessageLine, primaryButton, useVaultAction } from './shared';

/**
 * The states that block the whole screen's writes for a reason the operator
 * fixes elsewhere (no password, plain HTTP) or here (sealed vault). Locked and
 * unlocked are shown by {@link LockControl} in the header instead.
 */
export function GateBanner({
  gate,
  onChanged,
}: {
  gate: VaultGate;
  onChanged: () => Promise<void>;
}): ReactNode {
  if (gate.kind === 'ready' || gate.kind === 'locked') return null;
  return (
    <div
      className="flex flex-col gap-3 border border-warning/50 bg-warning/5 p-4"
      data-testid="vault-gate"
    >
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
        <div className="flex flex-col gap-1">
          <p className="font-medium">{gate.title}</p>
          <p className="max-w-2xl text-sm text-muted-foreground">{gate.detail}</p>
        </div>
      </div>
      {gate.kind === 'sealed' && <UnsealForm onChanged={onChanged} />}
    </div>
  );
}

/** Header control: "Unlocked · n min" or a Lock button that opens the password dialog. */
export function LockControl({
  gate,
  status,
  onChanged,
}: {
  gate: VaultGate;
  status: VaultStatus;
  onChanged: () => Promise<void>;
}): ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  if (gate.kind === 'ready') {
    return (
      <span
        className="inline-flex h-9 items-center gap-1.5 border border-success/40 bg-success/10 px-3 text-sm text-success"
        title="Changes are allowed until the confirmation expires"
        data-testid="vault-lock"
      >
        <LockOpen className="size-4" aria-hidden />
        Unlocked · {gate.detail}
      </span>
    );
  }
  if (gate.kind !== 'locked') return null;
  return (
    <>
      <button
        type="button"
        className={cn(
          'inline-flex h-9 items-center gap-1.5 border border-border px-3 text-sm hover:bg-muted',
        )}
        onClick={() => dialogRef.current?.showModal()}
        data-testid="vault-lock"
      >
        <Lock className="size-4" aria-hidden />
        Unlock to edit
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        className="m-auto w-[min(26rem,calc(100vw-2rem))] border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/50"
      >
        <div className="flex flex-col gap-4 p-5">
          <div className="flex flex-col gap-1">
            <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold">
              <Lock className="size-4" aria-hidden />
              Unlock provider changes
            </h2>
            <p className="text-sm text-muted-foreground">{gate.detail}</p>
          </div>
          <ElevateForm
            totp={status.totpEnabled === true}
            onChanged={async () => {
              dialogRef.current?.close();
              await onChanged();
            }}
            onCancel={() => dialogRef.current?.close()}
          />
        </div>
      </dialog>
    </>
  );
}

function ElevateForm({
  totp,
  onChanged,
  onCancel,
}: {
  totp: boolean;
  onChanged: () => Promise<void>;
  onCancel: () => void;
}): ReactNode {
  const id = useId();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const { busy, message, run } = useVaultAction();
  const canSend = password !== '' && (!totp || /^\d{6}$/.test(code)) && !busy;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSend) return;
        void run(async () => {
          await elevateVault({ password, ...(totp ? { code } : {}) });
          setPassword('');
          setCode('');
          await onChanged();
        });
      }}
    >
      <input type="text" name="username" autoComplete="username" value="hq" readOnly hidden />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-pw`} className={label}>
          HQ password
        </label>
        <PasswordInput
          id={`${id}-pw`}
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
      </div>
      {totp && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-code`} className={label}>
            Authenticator code
          </label>
          <input
            id={`${id}-code`}
            className={field}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          />
        </div>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={!canSend} className={primaryButton}>
          {busy ? 'Checking…' : 'Unlock for 10 minutes'}
        </button>
        <button type="button" className="h-10 px-3 text-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <MessageLine message={message} />
    </form>
  );
}

function UnsealForm({ onChanged }: { onChanged: () => Promise<void> }): ReactNode {
  const id = useId();
  const [passphrase, setPassphrase] = useState('');
  const { busy, message, run } = useVaultAction();
  return (
    <form
      className="flex max-w-sm flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (passphrase === '' || busy) return;
        void run(async () => {
          await unsealVault(passphrase);
          setPassphrase('');
          await onChanged();
        });
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-pp`} className={label}>
          Vault passphrase
        </label>
        <PasswordInput
          id={`${id}-pp`}
          value={passphrase}
          onChange={setPassphrase}
          autoComplete="off"
        />
        <span className="text-xs text-muted-foreground">
          The value of WRONGSTACK_HQ_VAULT_PASSPHRASE when the vault was created.
        </span>
      </div>
      <button type="submit" disabled={passphrase === '' || busy} className={primaryButton}>
        {busy ? 'Unsealing…' : 'Unseal'}
      </button>
      <MessageLine message={message} />
    </form>
  );
}
