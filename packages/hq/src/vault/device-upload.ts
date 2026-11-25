/**
 * Moving a provider of this machine into HQ (`wstack hq keys push`), the
 * device half of `store-uploads.ts`.
 *
 * What moves is the whole provider: type, family, endpoint, env vars, model
 * list and every key. A provider that holds a key HQ could not take — an
 * OAuth sign-in (sign in on HQ instead, HQ then renews it) or a key that came
 * from HQ — is refused whole: once HQ owns the provider, a revoked grant
 * removes it from this machine, and a key left behind in it would go too.
 *
 * Nothing local changes when the upload is sent. After an operator approves
 * it, the next sync finds the profile's `uploadId` among this machine's
 * pending uploads and {@link adoptHqUpload} turns the original provider into
 * the HQ one — same id, the uploaded keys replaced by HQ's — instead of
 * adding an `-hq` copy beside it.
 */
import { createHash } from 'node:crypto';
import type { ProviderConfig } from '@wrongstack/contracts/types/config';
import { buildHqVaultUploadRequest } from './client.js';
import { normalizeKeys, writeKeysBack } from './device-keys.js';
import type { HqDeviceRecord, HqPendingUpload } from './device-store.js';
import type { HqVaultUploadPayload, HqVaultUploadRequest } from './protocol.js';

/** HQ keeps an unapproved upload this long (`HQ_VAULT_UPLOAD_TTL_MS`); so does the device. */
const UPLOAD_TTL_MS = 7 * 24 * 60 * 60_000;

/** What `push` did with each provider asked for. */
export interface HqPushReport {
  sent: { providerId: string; uploadId: string; keys: string[] }[];
  skipped: { providerId: string; reason: string }[];
}

/** How an uploaded key is recognised later without keeping its value. */
export function hqUploadKeyHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The upload of one local provider, or why it cannot be uploaded. */
export function buildHqUploadPayload(
  localId: string,
  provider: ProviderConfig | undefined,
): { payload: HqVaultUploadPayload } | { skip: string } {
  if (!provider) return { skip: 'no such provider in this profile' };
  if (provider.source?.kind === 'hq') return { skip: 'it already comes from HQ' };
  const keys = normalizeKeys(provider);
  if (keys.length === 0) return { skip: 'it has no key to upload' };
  const unfit = keys.find((k) => k.authMethod === 'oauth' || k.source !== undefined || !k.apiKey);
  if (unfit) {
    return {
      skip:
        unfit.authMethod === 'oauth'
          ? `"${unfit.label}" is a sign-in; sign in on HQ instead (HQ → Keys → Sign in), or remove it first`
          : `"${unfit.label}" did not come from this machine; remove it first`,
    };
  }
  const profile: HqVaultUploadPayload['profile'] = { id: localId, type: provider.type ?? localId };
  if (provider.family) profile.family = provider.family;
  if (provider.baseUrl) profile.baseUrl = provider.baseUrl;
  if (provider.envVars?.length) profile.envVars = [...provider.envVars];
  if (provider.models?.length) profile.models = [...provider.models];
  if (provider.activeKey) profile.activeKey = provider.activeKey;
  return {
    payload: {
      localId,
      profile,
      keys: keys.map((k) => ({ label: k.label, apiKey: k.apiKey })),
    },
  };
}

/**
 * Turn the provider an approved upload came from into the HQ profile's home:
 * mark it HQ-owned and drop the keys that were uploaded (HQ's copies replace
 * them in the mirror that follows). A key changed here since the upload stays
 * as a local key. False when there is nothing to adopt — the provider is gone,
 * already HQ's, or another provider already holds this HQ profile.
 */
export function adoptHqUpload(
  all: Record<string, ProviderConfig>,
  pending: HqPendingUpload,
  hqId: string,
  profileId: string,
): boolean {
  const provider = Object.hasOwn(all, pending.localId) ? all[pending.localId] : undefined;
  if (!provider || provider.source?.kind === 'hq') return false;
  const held = Object.values(all).some(
    (p) => p.source?.kind === 'hq' && p.source.hqId === hqId && p.source.profileId === profileId,
  );
  if (held) return false;
  const uploaded = new Set(pending.keyHashes);
  const adopted: ProviderConfig = { ...provider };
  writeKeysBack(
    adopted,
    normalizeKeys(provider).filter((k) => !uploaded.has(hqUploadKeyHash(k.apiKey))),
  );
  // Version 0: the mirror that follows always counts as a change.
  adopted.source = { kind: 'hq', hqId, profileId, version: 0 };
  all[pending.localId] = adopted;
  return true;
}

/**
 * Upload providers (`localIds`; every one that can move when `all`), each
 * sealed to HQ's identity key, and remember them as pending. Nothing in the
 * config changes. `again` sends a provider whose earlier upload is still
 * pending here (the operator rejected it, say).
 */
export async function sendHqUploads(
  io: {
    device: HqDeviceRecord;
    now: number;
    mutateProviders: (
      mutator: (providers: Record<string, ProviderConfig>) => void | Promise<void>,
    ) => Promise<void>;
    send: (request: HqVaultUploadRequest) => Promise<unknown>;
    save: (update: (pending: HqPendingUpload[]) => HqPendingUpload[]) => Promise<void>;
  },
  localIds: readonly string[],
  options: { all?: boolean | undefined; again?: boolean | undefined },
): Promise<HqPushReport> {
  const { device, now } = io;
  const report: HqPushReport = { sent: [], skipped: [] };
  const live = (u: HqPendingUpload) => Date.parse(u.expiresAt) > now;
  const waiting = new Set((device.pendingUploads ?? []).filter(live).map((u) => u.localId));
  const ready: { localId: string; built: ReturnType<typeof buildHqUploadPayload> }[] = [];
  // Read under the config lock (nothing is changed): the values as stored now.
  await io.mutateProviders((all) => {
    for (const localId of options.all ? Object.keys(all) : localIds) {
      const built = buildHqUploadPayload(
        localId,
        Object.hasOwn(all, localId) ? all[localId] : undefined,
      );
      if (!(options.all && 'skip' in built)) ready.push({ localId, built });
    }
  });
  const pending: HqPendingUpload[] = [];
  try {
    await sendEach();
  } finally {
    // What HQ took is remembered even when a later upload fails.
    if (pending.length > 0) {
      const sent = new Set(pending.map((u) => u.localId));
      await io.save((current) => [
        ...current.filter((u) => !sent.has(u.localId) && live(u)),
        ...pending,
      ]);
    }
  }
  return report;

  async function sendEach(): Promise<void> {
    for (const { localId, built } of ready) {
      if ('skip' in built) {
        report.skipped.push({ providerId: localId, reason: built.skip });
        continue;
      }
      if (waiting.has(localId) && !options.again) {
        report.skipped.push({
          providerId: localId,
          reason:
            'an upload of it is still waiting for approval in HQ (send it again with --again)',
        });
        continue;
      }
      const request = buildHqVaultUploadRequest(device.keys, device.hq, built.payload, { now });
      await io.send(request);
      const keys = built.payload.keys;
      pending.push({
        uploadId: request.uploadId,
        localId,
        keyHashes: keys.map((k) => hqUploadKeyHash(k.apiKey)),
        uploadedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + UPLOAD_TTL_MS).toISOString(),
      });
      report.sent.push({
        providerId: localId,
        uploadId: request.uploadId,
        keys: keys.map((k) => k.label),
      });
    }
  }
}
