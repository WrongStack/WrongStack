'use client';

/**
 * What stands between the operator and a change — and the form that removes
 * it: unseal a passphrase-protected vault, or confirm the HQ password (and
 * authenticator code) for a 10-minute window.
 */
import { PasswordInput } from '@hq/components/hq/password-input';
import { elevateVault, unsealVault, type VaultStatus } from '@hq/data/vault-api';
import { Lock, LockOpen, ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import { cn } from '@/lib/cn';
import type { VaultGate } from './model';
import { field, label, MessageLine, primaryButton, useVaultAction } from './shared';

export function GatePanel({
  gate,
  status,
  onChanged,
}: {
  gate: VaultGate;
  status: VaultStatus;
  onChanged: () => Promise<void>;
}): ReactNode {
  const tone =
    gate.kind === 'ready'
      ? 'border-success/40 bg-success/5'
      : gate.kind === 'locked'
        ? 'border-border bg-muted/30'
        : 'border-warning/50 bg-warning/5';
  const Icon = gate.kind === 'ready' ? LockOpen : gate.kind === 'locked' ? Lock : ShieldAlert;
  return (
    <div className={cn('flex flex-col gap-3 border p-4', tone)} data-testid="vault-gate">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
        <div className="flex flex-col gap-1">
          <p className="font-medium">{gate.title}</p>
          <p className="max-w-2xl text-sm text-muted-foreground">{gate.detail}</p>
        </div>
      </div>
      {gate.kind === 'sealed' && <UnsealForm onChanged={onChanged} />}
      {gate.kind === 'locked' && (
        <ElevateForm totp={status.totpEnabled === true} onChanged={onChanged} />
      )}
    </div>
  );
}

function ElevateForm({
  totp,
  onChanged,
}: {
  totp: boolean;
  onChanged: () => Promise<void>;
}): ReactNode {
  const id = useId();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const { busy, message, run } = useVaultAction();
  const canSend = password !== '' && (!totp || /^\d{6}$/.test(code)) && !busy;
  return (
    <form
      className="flex max-w-sm flex-col gap-3"
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
      <button type="submit" disabled={!canSend} className={primaryButton}>
        {busy ? 'Checking…' : 'Unlock for 10 minutes'}
      </button>
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
