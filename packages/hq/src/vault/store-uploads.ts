/**
 * Uploads — a device moving providers it holds into HQ (`wstack hq keys push`).
 *
 * A signed device request that created a profile directly would be a vault
 * write without the secure channel and the step-up every operator write
 * needs. So an upload only waits: still sealed to HQ's identity key, for at
 * most {@link HQ_VAULT_UPLOAD_TTL_MS}, until an operator approves it — HQ then
 * makes the profile and grants it back to the device, which takes it in place
 * of its own provider (the bundle names the `uploadId`) — or rejects it.
 */
import { type HqVaultKeyPair, hqVaultOpen } from './crypto.js';
import {
  HQ_VAULT_UPLOAD_PURPOSE,
  type HqVaultDeviceRecord,
  type HqVaultProfileMeta,
  type HqVaultUploadMeta,
  type HqVaultUploadPayload,
  type HqVaultUploadRequest,
  type HqVaultUploadResponse,
  hqVaultUploadAad,
} from './protocol.js';
import {
  type HqVaultAuditEntry,
  HqVaultError,
  type HqVaultFile,
  type HqVaultStoredUpload,
  hqVaultHint,
  hqVaultText,
} from './store-model.js';
import {
  createHqVaultProfile,
  hqVaultProfileMeta,
  parseHqVaultKeyInput,
  parseHqVaultProfileFields,
  parseHqVaultProfileId,
  setHqVaultGrant,
  upsertHqVaultKey,
} from './store-profiles.js';

/** A pending upload is dropped after this long. */
export const HQ_VAULT_UPLOAD_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_UPLOADS_PER_DEVICE = 8;
const MAX_UPLOADS = 64;
const MAX_SEALED_CHARS = 96 * 1024;
const MAX_UPLOAD_KEYS = 32;
const UPLOAD_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** What the store lends the uploads view: its file, keys, authentication and writers. */
export interface HqVaultUploadsHost {
  file(): HqVaultFile;
  /** The master key; throws while the vault is sealed. */
  master(): Buffer;
  identity(): HqVaultKeyPair;
  authenticate(request: HqVaultUploadRequest, purpose: string, now: number): HqVaultDeviceRecord;
  change<T>(fn: (file: HqVaultFile) => Promise<T>): Promise<T>;
  mutate<T>(fn: (file: HqVaultFile) => Promise<T>): Promise<T>;
  audit(entry: Omit<HqVaultAuditEntry, 'at'>): Promise<void>;
  now(): number;
}

function invalid(message: string): never {
  throw new HqVaultError('VAULT_INVALID', message);
}

/** Validate what a device sealed (it is checked again when the profile is made). */
export function parseHqVaultUploadPayload(value: unknown): HqVaultUploadPayload {
  if (!value || typeof value !== 'object') invalid('The upload is malformed.');
  const input = value as Record<string, unknown>;
  const localId = hqVaultText(input.localId, 64) ?? invalid('The upload names no provider.');
  const raw = input.profile;
  if (!raw || typeof raw !== 'object') invalid('The upload carries no provider.');
  const profileInput = raw as Record<string, unknown>;
  const id = parseHqVaultProfileId(profileInput.id);
  const fields = parseHqVaultProfileFields({ ...profileInput, activeKey: undefined });
  const keysInput = input.keys;
  if (!Array.isArray(keysInput) || keysInput.length === 0 || keysInput.length > MAX_UPLOAD_KEYS) {
    invalid(`An upload carries 1 to ${MAX_UPLOAD_KEYS} API keys.`);
  }
  const keys: HqVaultUploadPayload['keys'] = [];
  for (const item of keysInput) {
    const key = parseHqVaultKeyInput({
      label: (item as Record<string, unknown> | null)?.label,
      apiKey: (item as Record<string, unknown> | null)?.apiKey,
    });
    if (keys.some((k) => k.label === key.label)) invalid(`Two keys are labelled "${key.label}".`);
    keys.push({ label: key.label, apiKey: key.secrets.apiKey });
  }
  const activeKey = hqVaultText(profileInput.activeKey, 80);
  return {
    localId,
    profile: {
      id,
      type: fields.type ?? id,
      ...(fields.family ? { family: fields.family } : {}),
      ...(fields.baseUrl ? { baseUrl: fields.baseUrl } : {}),
      ...(fields.envVars ? { envVars: fields.envVars } : {}),
      ...(fields.models ? { models: fields.models } : {}),
      ...(activeKey && keys.some((k) => k.label === activeKey) ? { activeKey } : {}),
    },
    keys,
  };
}

function openUpload(upload: HqVaultStoredUpload, identity: HqVaultKeyPair): HqVaultUploadPayload {
  let text: string;
  try {
    text = hqVaultOpen(
      upload.sealed,
      identity,
      hqVaultUploadAad({ deviceId: upload.deviceId, uploadId: upload.id, nonce: upload.nonce }),
    );
  } catch {
    invalid("The upload does not open with this HQ's key.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalid('The upload is malformed.');
  }
  return parseHqVaultUploadPayload(parsed);
}

function sweep(file: HqVaultFile, now: number): void {
  if (!file.uploads) return;
  file.uploads = file.uploads.filter((u) => Date.parse(u.expiresAt) > now);
}

function findUpload(file: HqVaultFile, id: string): HqVaultStoredUpload {
  const upload = file.uploads?.find((u) => u.id === id);
  if (!upload) throw new HqVaultError('VAULT_NOT_FOUND', 'No such upload (it may have expired).');
  return upload;
}

export class HqVaultUploads {
  constructor(private readonly host: HqVaultUploadsHost) {}

  /** A device's signed upload: authenticated, opened once to validate, kept sealed. */
  async receive(request: HqVaultUploadRequest): Promise<HqVaultUploadResponse> {
    this.host.master();
    if (request === null || typeof request !== 'object' || request.v !== 2) {
      invalid('Unsupported upload request; update this machine.');
    }
    const now = this.host.now();
    const device = this.host.authenticate(request, HQ_VAULT_UPLOAD_PURPOSE, now);
    const uploadId = typeof request.uploadId === 'string' ? request.uploadId : '';
    if (!UPLOAD_ID.test(uploadId)) invalid('uploadId is malformed.');
    const sealed = request.sealed;
    if (!sealed || typeof sealed !== 'object' || JSON.stringify(sealed).length > MAX_SEALED_CHARS) {
      invalid('The upload is missing or too large.');
    }
    const upload: HqVaultStoredUpload = {
      id: uploadId,
      deviceId: device.id,
      nonce: request.nonce,
      receivedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + HQ_VAULT_UPLOAD_TTL_MS).toISOString(),
      sealed,
    };
    // Junk is refused at the door, not shown to an operator.
    const payload = openUpload(upload, this.host.identity());
    await this.host.mutate(async (file) => {
      sweep(file, now);
      file.uploads ??= [];
      const uploads = file.uploads;
      if (uploads.some((u) => u.id === uploadId)) {
        throw new HqVaultError('VAULT_CONFLICT', 'This upload was received already.');
      }
      if (
        uploads.filter((u) => u.deviceId === device.id).length >= MAX_UPLOADS_PER_DEVICE ||
        uploads.length >= MAX_UPLOADS
      ) {
        throw new HqVaultError(
          'VAULT_CONFLICT',
          'Too many uploads are waiting in HQ; approve or reject some first.',
        );
      }
      uploads.push(upload);
    });
    await this.host.audit({
      kind: 'upload.receive',
      actor: `device:${device.id}`,
      deviceId: device.id,
      profileId: payload.profile.id,
      detail: uploadId,
    });
    return { v: 2, uploadId, status: 'pending', expiresAt: upload.expiresAt };
  }

  /** Pending uploads, newest first — labels and the last characters of each key, never a value. */
  list(): HqVaultUploadMeta[] {
    this.host.master();
    const file = this.host.file();
    const now = this.host.now();
    const out: HqVaultUploadMeta[] = [];
    for (const upload of file.uploads ?? []) {
      if (Date.parse(upload.expiresAt) <= now) continue;
      const payload = openUpload(upload, this.host.identity());
      const device = file.devices.find((d) => d.id === upload.deviceId);
      out.push({
        id: upload.id,
        deviceId: upload.deviceId,
        device: device?.label ?? device?.hostname ?? upload.deviceId,
        receivedAt: upload.receivedAt,
        expiresAt: upload.expiresAt,
        localId: payload.localId,
        profile: payload.profile,
        keys: payload.keys.map((k) => ({ label: k.label, hint: hqVaultHint(k.apiKey) })),
        conflict: file.profiles.some((p) => p.id === payload.profile.id),
      });
    }
    return out.reverse();
  }

  /**
   * Make the profile (under `input.profileId` when given — the way past an id
   * that exists) with the uploaded keys, and grant it back to the device:
   * stored, or memory-only with `input.lease`.
   */
  async approve(
    id: string,
    input: { profileId?: unknown; lease?: unknown },
    actor: string,
  ): Promise<HqVaultProfileMeta> {
    const master = this.host.master();
    return this.host.change(async (file) => {
      const upload = findUpload(file, id);
      const device = file.devices.find((d) => d.id === upload.deviceId);
      if (device?.status !== 'approved') {
        throw new HqVaultError(
          'VAULT_CONFLICT',
          'The device that sent this upload is no longer approved.',
        );
      }
      const payload = openUpload(upload, this.host.identity());
      const at = new Date(this.host.now()).toISOString();
      const profile = createHqVaultProfile(
        file,
        { ...payload.profile, id: input.profileId ?? payload.profile.id },
        at,
      );
      for (const key of payload.keys) {
        upsertHqVaultKey(file, master, profile.id, parseHqVaultKeyInput(key), at);
      }
      if (payload.profile.activeKey) profile.activeKey = payload.profile.activeKey;
      profile.origin = { deviceId: upload.deviceId, uploadId: upload.id };
      setHqVaultGrant(file, profile.id, upload.deviceId, true, at, input.lease === true);
      file.uploads = file.uploads!.filter((u) => u.id !== id);
      await this.host.audit({
        kind: 'upload.approve',
        actor,
        profileId: profile.id,
        deviceId: upload.deviceId,
        detail: input.lease === true ? `${upload.id} memory-only` : upload.id,
      });
      return hqVaultProfileMeta(file, profile);
    });
  }

  async reject(id: string, actor: string): Promise<void> {
    this.host.master();
    await this.host.mutate(async (file) => {
      const upload = findUpload(file, id);
      file.uploads = file.uploads!.filter((u) => u.id !== id);
      await this.host.audit({
        kind: 'upload.reject',
        actor,
        deviceId: upload.deviceId,
        detail: upload.id,
      });
    });
  }
}
