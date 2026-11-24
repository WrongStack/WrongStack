'use client';

/**
 * The keys HQ holds: provider, name, version and age — never the value. A key
 * is pasted once to store it and once more to replace it; nothing reads it back.
 */
import { PasswordInput } from '@hq/components/hq/password-input';
import {
  createVaultSecret,
  deleteVaultSecret,
  type HqVaultSecretMeta,
  rotateVaultSecret,
} from '@hq/data/vault-api';
import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import { relativeTime } from '@/features/attention/model';
import { secretFormError } from './model';
import {
  dangerButton,
  field,
  label,
  MessageLine,
  primaryButton,
  smallButton,
  useVaultAction,
  VaultSection,
} from './shared';

export function SecretsPanel({
  secrets,
  grantCounts,
  canWrite,
  now,
  onChanged,
}: {
  secrets: readonly HqVaultSecretMeta[];
  grantCounts: ReadonlyMap<string, number>;
  canWrite: boolean;
  now: number;
  onChanged: () => Promise<void>;
}): ReactNode {
  const [adding, setAdding] = useState(false);
  return (
    <VaultSection
      title="Keys"
      description="Provider keys HQ stores encrypted. Each one reaches only the devices you give it to."
      actions={
        canWrite && !adding ? (
          <button type="button" className={smallButton} onClick={() => setAdding(true)}>
            Add a key
          </button>
        ) : null
      }
    >
      {adding && canWrite && (
        <AddSecretForm
          onDone={async (stored) => {
            setAdding(false);
            if (stored) await onChanged();
          }}
        />
      )}
      {secrets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No key stored yet.</p>
      ) : (
        <ul className="flex flex-col border border-border" data-testid="vault-secrets">
          {[...secrets]
            .sort(
              (a, b) => a.providerId.localeCompare(b.providerId) || a.label.localeCompare(b.label),
            )
            .map((secret) => (
              <SecretRow
                key={secret.id}
                secret={secret}
                devices={grantCounts.get(secret.id) ?? 0}
                canWrite={canWrite}
                now={now}
                onChanged={onChanged}
              />
            ))}
        </ul>
      )}
    </VaultSection>
  );
}

function AddSecretForm({ onDone }: { onDone: (stored: boolean) => Promise<void> }): ReactNode {
  const id = useId();
  const [providerId, setProviderId] = useState('');
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const { busy, message, setMessage, run } = useVaultAction();
  return (
    <form
      className="flex max-w-xl flex-col gap-3 border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const problem = secretFormError({ providerId, label: name, apiKey });
        if (problem) {
          setMessage({ tone: 'error', text: problem });
          return;
        }
        void run(async () => {
          await createVaultSecret({ providerId: providerId.trim(), label: name.trim(), apiKey });
          setApiKey('');
          await onDone(true);
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-provider`} className={label}>
            Provider id
          </label>
          <input
            id={`${id}-provider`}
            className={field}
            placeholder="openai"
            autoComplete="off"
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-name`} className={label}>
            Name
          </label>
          <input
            id={`${id}-name`}
            className={field}
            placeholder="team"
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-key`} className={label}>
          API key
        </label>
        <PasswordInput id={`${id}-key`} value={apiKey} onChange={setApiKey} autoComplete="off" />
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? 'Storing…' : 'Store key'}
        </button>
        <button type="button" className="h-10 px-3 text-sm" onClick={() => void onDone(false)}>
          Cancel
        </button>
      </div>
      <MessageLine message={message} />
    </form>
  );
}

function SecretRow({
  secret,
  devices,
  canWrite,
  now,
  onChanged,
}: {
  secret: HqVaultSecretMeta;
  devices: number;
  canWrite: boolean;
  now: number;
  onChanged: () => Promise<void>;
}): ReactNode {
  const [mode, setMode] = useState<'idle' | 'rotate' | 'delete'>('idle');
  const [apiKey, setApiKey] = useState('');
  const { busy, message, run } = useVaultAction();
  return (
    <li className="flex flex-col gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="min-w-40 flex-1 break-words">
          <span className="font-medium">{secret.label}</span>{' '}
          <span className="text-muted-foreground">{secret.providerId}</span>
        </span>
        <span className="text-xs text-muted-foreground">
          v{secret.version} · updated {relativeTime(secret.updatedAt, now)} · {devices} device
          {devices === 1 ? '' : 's'}
        </span>
        {canWrite && mode === 'idle' && (
          <span className="flex gap-2">
            <button type="button" className={smallButton} onClick={() => setMode('rotate')}>
              Replace
            </button>
            <button type="button" className={dangerButton} onClick={() => setMode('delete')}>
              Delete
            </button>
          </span>
        )}
      </div>
      {mode === 'rotate' && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (apiKey.trim() === '' || busy) return;
            void run(async () => {
              await rotateVaultSecret(secret.id, apiKey);
              setApiKey('');
              setMode('idle');
              await onChanged();
            });
          }}
        >
          <PasswordInput
            className="min-w-64 flex-1"
            value={apiKey}
            onChange={setApiKey}
            placeholder="New key value"
            autoComplete="off"
          />
          <button type="submit" disabled={busy || apiKey.trim() === ''} className={smallButton}>
            {busy ? 'Saving…' : 'Save new value'}
          </button>
          <button type="button" className={smallButton} onClick={() => setMode('idle')}>
            Cancel
          </button>
        </form>
      )}
      {mode === 'delete' && (
        <div className="flex flex-wrap items-center gap-2 border border-destructive/40 bg-destructive/5 p-2">
          <span className="flex-1 text-xs">
            Devices stop receiving it. Copies they already imported stay until they are removed
            there — rotate the key at the provider to make those useless.
          </span>
          <button
            type="button"
            disabled={busy}
            className={dangerButton}
            onClick={() =>
              void run(async () => {
                await deleteVaultSecret(secret.id);
                await onChanged();
              })
            }
          >
            {busy ? 'Deleting…' : 'Delete key'}
          </button>
          <button type="button" className={smallButton} onClick={() => setMode('idle')}>
            Keep
          </button>
        </div>
      )}
      <MessageLine message={message} />
    </li>
  );
}
