'use client';

/**
 * Uploads: providers a device moved into HQ (`wstack hq keys push`), waiting
 * for an operator. Approving makes the provider here — under another id when
 * its own is taken — and gives it back to that device, which then holds it as
 * an HQ provider in place of its own; rejecting drops it. The page shows the
 * endpoint, models and each key's last characters, never a value. An upload
 * nobody decides on is dropped after seven days.
 */
import { approveVaultUpload, type HqVaultUploadMeta, rejectVaultUpload } from '@hq/data/vault-api';
import { MemoryStick } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import { relativeTime } from '@/features/attention/model';
import { cn } from '@/lib/cn';
import {
  dangerButton,
  field,
  MessageLine,
  smallButton,
  useVaultAction,
  VaultSection,
} from './shared';

export function UploadsPanel({
  uploads,
  canWrite,
  now,
  onChanged,
}: {
  uploads: readonly HqVaultUploadMeta[];
  canWrite: boolean;
  now: number;
  onChanged: () => Promise<void>;
}): ReactNode {
  return (
    <VaultSection
      title="Uploads"
      description="Providers a machine sent with wstack hq keys push. Approve one to keep it here and give it back to that machine, which then gets its keys from HQ; reject it to drop it. Undecided uploads go away after seven days."
    >
      {uploads.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is waiting.</p>
      ) : (
        <ul className="flex flex-col border border-border" data-testid="vault-uploads">
          {uploads.map((upload) => (
            <UploadRow
              key={upload.id}
              upload={upload}
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

function UploadRow({
  upload,
  canWrite,
  now,
  onChanged,
}: {
  upload: HqVaultUploadMeta;
  canWrite: boolean;
  now: number;
  onChanged: () => Promise<void>;
}): ReactNode {
  const { busy, message, run } = useVaultAction();
  const [profileId, setProfileId] = useState(upload.conflict ? `${upload.profile.id}-2` : '');
  const [lease, setLease] = useState(false);
  const idField = useId();
  const { profile } = upload;
  const models = profile.models?.length ?? 0;
  return (
    <li className="flex flex-col gap-2 border-b border-border px-3 py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">
          {profile.id}
          {profile.type !== profile.id && (
            <span className="ml-2 text-xs text-muted-foreground">{profile.type}</span>
          )}
        </span>
        <span className="text-xs text-muted-foreground">
          from {upload.device} · {relativeTime(upload.receivedAt, now)}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {profile.baseUrl ?? 'Default endpoint'} · {models} model{models === 1 ? '' : 's'}
        {upload.localId !== profile.id ? ` · "${upload.localId}" on that machine` : ''}
      </p>
      <ul className="flex flex-wrap gap-1.5 text-xs">
        {upload.keys.map((key) => (
          <li key={key.label} className="border border-border px-1.5 py-0.5">
            {key.label} <span className="font-mono text-muted-foreground">{key.hint}</span>
          </li>
        ))}
      </ul>
      {upload.conflict && (
        <div className="flex flex-col gap-1">
          <label htmlFor={idField} className="text-xs text-warning">
            A provider "{profile.id}" exists on HQ already. Approve it under another id:
          </label>
          <input
            id={idField}
            className={cn(field, 'h-8 max-w-xs')}
            value={profileId}
            onChange={(event) => setProfileId(event.target.value)}
            disabled={!canWrite || busy}
          />
        </div>
      )}
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={smallButton}
            disabled={busy || (upload.conflict && profileId.trim() === '')}
            onClick={() =>
              void run(async () => {
                await approveVaultUpload(upload.id, {
                  ...(upload.conflict ? { profileId: profileId.trim() } : {}),
                  lease,
                });
                await onChanged();
              })
            }
          >
            Approve
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={lease}
            className={cn(smallButton, lease && 'border-primary text-primary')}
            title="That machine then keeps the keys in memory only. Its config stops holding them, but an older config backup may still — rotate the key to be sure."
            onClick={() => setLease((v) => !v)}
            disabled={busy}
          >
            <MemoryStick className="mr-1 size-3.5" aria-hidden />
            Memory only
          </button>
          <button
            type="button"
            className={dangerButton}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await rejectVaultUpload(upload.id);
                await onChanged();
              })
            }
          >
            Reject
          </button>
        </div>
      )}
      <MessageLine message={message} />
    </li>
  );
}
