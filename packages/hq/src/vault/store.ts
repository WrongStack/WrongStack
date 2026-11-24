/**
 * HqVaultStore — HQ's encrypted credential store, device registry and grants.
 *
 * File `<dataDir>/hq-vault.json` (owner-only). Every secret is encrypted under
 * its own data key; the data key is wrapped under the master key
 * (`master-key.ts`). HQ's own identity keys are encrypted the same way. The
 * file therefore holds no credential in the clear, and with a passphrase-wrapped
 * master key a copy of the data directory opens nothing.
 *
 * Audit trail: `<dataDir>/hq-vault-audit.jsonl` — who stored, rotated, granted,
 * revoked, and which device fetched what and when. It never holds a value.
 *
 * Single writer: one HQ process owns its data directory; mutations are
 * serialised through one in-process queue and written atomically.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import {
  generateHqVaultKeyPair,
  type HqVaultKeyPair,
  hqVaultDecrypt,
  hqVaultEncrypt,
  hqVaultEnrollmentMac,
  hqVaultEnrollmentMacMatches,
  hqVaultFingerprint,
  hqVaultKeyId,
  hqVaultSeal,
  hqVaultSign,
  hqVaultVerify,
  isHqVaultKeyString,
} from './crypto.js';
import {
  decodeHqVaultMasterKey,
  hqVaultMasterKeyPath,
  loadOrCreateHqVaultMasterKey,
} from './master-key.js';
import {
  HQ_VAULT_BUNDLE_PURPOSE,
  HQ_VAULT_FETCH_PURPOSE,
  type HqVaultBundle,
  type HqVaultBundleItem,
  type HqVaultDeviceRecord,
  type HqVaultEnrollRequest,
  type HqVaultEnrollResponse,
  type HqVaultFetchMode,
  type HqVaultFetchRequest,
  type HqVaultGrantPolicy,
  type HqVaultGrantRecord,
  type HqVaultIdentity,
  type HqVaultSecretKind,
  type HqVaultSecretMeta,
  hqVaultItemAad,
} from './protocol.js';
import {
  HQ_VAULT_FETCH_SKEW_MS,
  HqVaultEnrollmentCodes,
  HqVaultNonceCache,
} from './store-guards.js';
import {
  decryptHqVaultValue,
  emptyHqVaultFile,
  encryptHqVaultValue,
  type HqVaultAuditEntry,
  HqVaultError,
  type HqVaultFile,
  HqVaultFileIO,
  type HqVaultState,
  type HqVaultStatus,
  type HqVaultStoredSecret,
  hqVaultText,
} from './store-model.js';

const DEFAULT_LEASE_TTL_SECONDS = 3600;
const MAX_LEASE_TTL_SECONDS = 7 * 86_400;
const MAX_API_KEY_LENGTH = 16_384;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface HqVaultStoreOptions {
  now?: () => number;
}

export class HqVaultStore {
  private readonly io: HqVaultFileIO;
  private readonly now: () => number;
  private masterKey: Buffer | undefined;
  private passphraseProtected = false;
  private file: HqVaultFile = emptyHqVaultFile();
  private identityKeys: HqVaultKeyPair | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly codes: HqVaultEnrollmentCodes;
  private readonly nonces = new HqVaultNonceCache();

  private constructor(
    private readonly dataDir: string,
    options: HqVaultStoreOptions,
  ) {
    this.io = new HqVaultFileIO(dataDir);
    this.now = options.now ?? Date.now;
    this.codes = new HqVaultEnrollmentCodes(this.now);
  }

  /**
   * Open the vault: create the master key and HQ identity on first use, read
   * the store file. With a passphrase-wrapped master key and no passphrase the
   * vault opens SEALED: metadata (labels, devices, grants) stays readable, but
   * every operation that needs a key fails until {@link unseal}.
   *
   * A store that already has an HQ identity never gets a NEW master key: a
   * restored `hq-vault.json` without its key file would otherwise be paired
   * with a fresh key that can never open it. That is reported instead.
   */
  static async open(
    dataDir: string,
    passphrase: string | undefined,
    options: HqVaultStoreOptions = {},
  ): Promise<HqVaultStore> {
    const store = new HqVaultStore(dataDir, options);
    store.file = (await store.io.read()) ?? emptyHqVaultFile();
    const master = await loadOrCreateHqVaultMasterKey(dataDir, passphrase, {
      create: store.file.identity === undefined,
    });
    if (master.state === 'unsealed') {
      await store.adoptMasterKey(master.key, master.wrapped);
    } else {
      store.passphraseProtected = true;
    }
    return store;
  }

  // ── State ─────────────────────────────────────────────────────────────────

  get state(): HqVaultState {
    return this.masterKey === undefined ? 'sealed' : 'unsealed';
  }

  status(): HqVaultStatus {
    const identity = this.identity();
    return {
      state: this.state,
      passphraseProtected: this.passphraseProtected,
      ...(identity ? { identity } : {}),
      counts: {
        secrets: this.file.secrets.length,
        devices: this.file.devices.filter((d) => d.status !== 'revoked').length,
        pendingDevices: this.file.devices.filter((d) => d.status === 'pending').length,
        grants: this.file.grants.length,
      },
    };
  }

  identity(): HqVaultIdentity | undefined {
    const id = this.file.identity;
    if (!id) return undefined;
    return {
      hqId: id.hqId,
      encPublic: id.encPublic,
      signPublic: id.signPublic,
      fingerprint: hqVaultFingerprint(id),
    };
  }

  /** Unseal a passphrase-protected vault. Throws on a wrong passphrase. */
  async unseal(passphrase: string, actor: string): Promise<void> {
    if (this.masterKey !== undefined) return;
    const buf = await fs.readFile(hqVaultMasterKeyPath(this.dataDir));
    const decoded = decodeHqVaultMasterKey(buf, passphrase);
    if (decoded.state !== 'unsealed') throw new HqVaultError('VAULT_SEALED', 'vault is sealed');
    await this.adoptMasterKey(decoded.key, decoded.wrapped);
    await this.audit({ kind: 'unseal', actor });
  }

  // ── Secrets ───────────────────────────────────────────────────────────────

  listSecrets(): HqVaultSecretMeta[] {
    return this.file.secrets.map(({ dek: _dek, payload: _payload, ...meta }) => meta);
  }

  async createSecret(
    input: { providerId: unknown; label: unknown; apiKey: unknown; kind?: HqVaultSecretKind },
    actor: string,
  ): Promise<HqVaultSecretMeta> {
    const master = this.requireUnsealed();
    const providerId = hqVaultText(input.providerId, 64);
    if (providerId === undefined || !PROVIDER_ID.test(providerId)) {
      throw new HqVaultError(
        'VAULT_INVALID',
        'providerId must be a provider id (letters, digits, . _ : -).',
      );
    }
    const label = hqVaultText(input.label, 80);
    if (label === undefined) throw new HqVaultError('VAULT_INVALID', 'Name the key (label).');
    const apiKey = hqVaultText(input.apiKey, MAX_API_KEY_LENGTH);
    if (apiKey === undefined) throw new HqVaultError('VAULT_INVALID', 'apiKey is required.');
    return this.mutate(async (file) => {
      if (file.secrets.some((s) => s.providerId === providerId && s.label === label)) {
        throw new HqVaultError(
          'VAULT_CONFLICT',
          `A key labelled "${label}" already exists for ${providerId}.`,
        );
      }
      const at = new Date(this.now()).toISOString();
      const id = randomUUID();
      const secret: HqVaultStoredSecret = {
        id,
        providerId,
        label,
        kind: input.kind ?? 'api_key',
        version: 1,
        createdAt: at,
        updatedAt: at,
        ...encryptHqVaultValue(master, id, 1, apiKey),
      };
      file.secrets.push(secret);
      await this.audit({ kind: 'secret.create', actor, secretId: id, providerId, version: 1 });
      const { dek: _d, payload: _p, ...meta } = secret;
      return meta;
    });
  }

  /** Replace a secret's value; its version advances, so devices re-fetch it. */
  async rotateSecret(id: string, apiKeyInput: unknown, actor: string): Promise<HqVaultSecretMeta> {
    const master = this.requireUnsealed();
    const apiKey = hqVaultText(apiKeyInput, MAX_API_KEY_LENGTH);
    if (apiKey === undefined) throw new HqVaultError('VAULT_INVALID', 'apiKey is required.');
    return this.mutate(async (file) => {
      const secret = file.secrets.find((s) => s.id === id);
      if (!secret) throw new HqVaultError('VAULT_NOT_FOUND', 'No such key.');
      const version = secret.version + 1;
      Object.assign(secret, encryptHqVaultValue(master, id, version, apiKey), {
        version,
        updatedAt: new Date(this.now()).toISOString(),
      });
      await this.audit({
        kind: 'secret.rotate',
        actor,
        secretId: id,
        providerId: secret.providerId,
        version,
      });
      const { dek: _d, payload: _p, ...meta } = secret;
      return meta;
    });
  }

  /** Delete a secret and every grant of it. */
  async deleteSecret(id: string, actor: string): Promise<void> {
    this.requireUnsealed();
    await this.mutate(async (file) => {
      const secret = file.secrets.find((s) => s.id === id);
      if (!secret) throw new HqVaultError('VAULT_NOT_FOUND', 'No such key.');
      file.secrets = file.secrets.filter((s) => s.id !== id);
      file.grants = file.grants.filter((g) => g.secretId !== id);
      await this.audit({
        kind: 'secret.delete',
        actor,
        secretId: id,
        providerId: secret.providerId,
      });
    });
  }

  // ── Devices ───────────────────────────────────────────────────────────────

  listDevices(): HqVaultDeviceRecord[] {
    return this.file.devices.map((d) => ({ ...d }));
  }

  async setDeviceStatus(
    id: string,
    status: 'approved' | 'revoked',
    actor: string,
  ): Promise<HqVaultDeviceRecord> {
    this.requireUnsealed();
    return this.mutate(async (file) => {
      const device = file.devices.find((d) => d.id === id);
      if (!device) throw new HqVaultError('VAULT_NOT_FOUND', 'No such device.');
      if (device.status === 'revoked') {
        throw new HqVaultError(
          'VAULT_CONFLICT',
          'A revoked device must enroll again with new keys.',
        );
      }
      const at = new Date(this.now()).toISOString();
      device.status = status;
      if (status === 'approved') device.approvedAt = at;
      else {
        device.revokedAt = at;
        file.grants = file.grants.filter((g) => g.deviceId !== id);
      }
      await this.audit({
        kind: status === 'approved' ? 'device.approve' : 'device.revoke',
        actor,
        deviceId: id,
      });
      return { ...device };
    });
  }

  // ── Grants ────────────────────────────────────────────────────────────────

  listGrants(): HqVaultGrantRecord[] {
    return this.file.grants.map((g) => ({ ...g }));
  }

  /** Newest audit entries first (at most 1000). Never holds a value. */
  readAudit(limit = 200): Promise<HqVaultAuditEntry[]> {
    return this.io.readAudit(Math.max(1, Math.min(1000, Math.trunc(limit))));
  }

  async createGrant(
    input: {
      secretId: unknown;
      deviceId: unknown;
      policy?: unknown;
      setActive?: unknown;
      leaseTtlSeconds?: unknown;
      expiresAt?: unknown;
    },
    actor: string,
  ): Promise<HqVaultGrantRecord> {
    this.requireUnsealed();
    const policy: HqVaultGrantPolicy = input.policy === 'lease' ? 'lease' : 'local';
    if (input.policy !== undefined && input.policy !== 'local' && input.policy !== 'lease') {
      throw new HqVaultError('VAULT_INVALID', "policy must be 'local' or 'lease'.");
    }
    let leaseTtlSeconds: number | undefined;
    if (policy === 'lease') {
      const ttl = input.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
      if (
        typeof ttl !== 'number' ||
        !Number.isInteger(ttl) ||
        ttl < 60 ||
        ttl > MAX_LEASE_TTL_SECONDS
      ) {
        throw new HqVaultError(
          'VAULT_INVALID',
          `leaseTtlSeconds must be a whole number from 60 to ${MAX_LEASE_TTL_SECONDS}.`,
        );
      }
      leaseTtlSeconds = ttl;
    }
    let expiresAt: string | undefined;
    if (input.expiresAt !== undefined) {
      const ms = typeof input.expiresAt === 'string' ? Date.parse(input.expiresAt) : Number.NaN;
      if (!Number.isFinite(ms) || ms <= this.now()) {
        throw new HqVaultError('VAULT_INVALID', 'expiresAt must be a future ISO date.');
      }
      expiresAt = new Date(ms).toISOString();
    }
    return this.mutate(async (file) => {
      const secret = file.secrets.find((s) => s.id === input.secretId);
      if (!secret) throw new HqVaultError('VAULT_NOT_FOUND', 'No such key.');
      const device = file.devices.find((d) => d.id === input.deviceId);
      if (!device || device.status === 'revoked') {
        throw new HqVaultError('VAULT_NOT_FOUND', 'No such device.');
      }
      if (file.grants.some((g) => g.secretId === secret.id && g.deviceId === device.id)) {
        throw new HqVaultError('VAULT_CONFLICT', 'That device already has this key.');
      }
      const grant: HqVaultGrantRecord = {
        id: randomUUID(),
        secretId: secret.id,
        deviceId: device.id,
        policy,
        setActive: input.setActive === true,
        ...(leaseTtlSeconds !== undefined ? { leaseTtlSeconds } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        createdAt: new Date(this.now()).toISOString(),
      };
      file.grants.push(grant);
      await this.audit({
        kind: 'grant.create',
        actor,
        grantId: grant.id,
        secretId: secret.id,
        deviceId: device.id,
        providerId: secret.providerId,
      });
      return { ...grant };
    });
  }

  async revokeGrant(id: string, actor: string): Promise<void> {
    this.requireUnsealed();
    await this.mutate(async (file) => {
      const grant = file.grants.find((g) => g.id === id);
      if (!grant) throw new HqVaultError('VAULT_NOT_FOUND', 'No such grant.');
      file.grants = file.grants.filter((g) => g.id !== id);
      await this.audit({
        kind: 'grant.revoke',
        actor,
        grantId: id,
        secretId: grant.secretId,
        deviceId: grant.deviceId,
      });
    });
  }

  // ── Enrollment ────────────────────────────────────────────────────────────

  /**
   * Mint a one-time enrollment code. In memory only: a code is meant to be
   * typed on another machine within minutes, and an HQ restart voiding the
   * outstanding ones is the conservative failure.
   */
  async mintEnrollmentCode(
    input: { autoApprove?: boolean; label?: unknown },
    actor: string,
  ): Promise<{ codeId: string; code: string; expiresAt: string; identity: HqVaultIdentity }> {
    this.requireUnsealed();
    const label = hqVaultText(input.label, 80);
    const entry = this.codes.mint({
      autoApprove: input.autoApprove !== false,
      ...(label ? { label } : {}),
    });
    if (!entry) {
      throw new HqVaultError(
        'VAULT_CONFLICT',
        'Too many outstanding enrollment codes; wait for some to expire.',
      );
    }
    await this.audit({ kind: 'enrollment.mint', actor });
    return {
      codeId: entry.codeId,
      code: entry.code,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      identity: this.identity()!,
    };
  }

  /**
   * Enroll a device. The MAC proves the request came from someone holding the
   * code, so a party in the middle cannot swap in its own keys; the code is
   * consumed only after the MAC checks out, so guessing at a code id cannot
   * burn someone else's code.
   */
  async enroll(request: HqVaultEnrollRequest): Promise<HqVaultEnrollResponse> {
    this.requireUnsealed();
    if (request === null || typeof request !== 'object' || request.v !== 1) {
      throw new HqVaultError('VAULT_INVALID', 'Unsupported enrollment request.');
    }
    const entry = this.codes.peek(request.codeId);
    const { mac, ...signed } = request;
    if (!entry || !hqVaultEnrollmentMacMatches(entry.code, signed, mac)) {
      throw new HqVaultError('VAULT_DENIED', 'Enrollment code is invalid or expired.');
    }
    const device = request.device;
    if (
      device === null ||
      typeof device !== 'object' ||
      !isHqVaultKeyString(device.encPublic) ||
      !isHqVaultKeyString(device.signPublic) ||
      typeof request.nonce !== 'string' ||
      request.nonce.length < 16 ||
      request.nonce.length > 128
    ) {
      throw new HqVaultError('VAULT_INVALID', 'Enrollment request is malformed.');
    }
    const hostname = hqVaultText(device.hostname, 255);
    if (hostname === undefined) throw new HqVaultError('VAULT_INVALID', 'hostname is required.');
    this.codes.consume(entry.codeId);
    const label = hqVaultText(device.label, 80) ?? entry.label;
    const record = await this.mutate(async (file) => {
      const id = hqVaultKeyId(device);
      const at = new Date(this.now()).toISOString();
      const existing = file.devices.find((d) => d.id === id);
      if (existing?.status === 'revoked') {
        throw new HqVaultError('VAULT_DENIED', 'This device was revoked; enroll with new keys.');
      }
      if (existing) {
        existing.hostname = hostname;
        if (label) existing.label = label;
        if (entry.autoApprove && existing.status === 'pending') {
          existing.status = 'approved';
          existing.approvedAt = at;
        }
        return { ...existing };
      }
      const created: HqVaultDeviceRecord = {
        id,
        encPublic: device.encPublic,
        signPublic: device.signPublic,
        fingerprint: hqVaultFingerprint(device),
        hostname,
        ...(label ? { label } : {}),
        status: entry.autoApprove ? 'approved' : 'pending',
        enrolledAt: at,
        ...(entry.autoApprove ? { approvedAt: at } : {}),
      };
      file.devices.push(created);
      return { ...created };
    });
    await this.audit({ kind: 'device.enroll', actor: `device:${record.id}`, deviceId: record.id });
    const body = {
      v: 1 as const,
      deviceId: record.id,
      status: record.status,
      hq: this.identity()!,
      nonce: request.nonce,
    };
    return { ...body, mac: hqVaultEnrollmentMac(entry.code, body) };
  }

  // ── Fetch ─────────────────────────────────────────────────────────────────

  /**
   * Answer a device's signed request with a bundle signed by HQ, each value
   * sealed to that device. A stolen client token gets nothing here: the
   * request must carry the device's signature and the values open only with
   * its private key.
   */
  async fetch(request: HqVaultFetchRequest): Promise<HqVaultBundle> {
    const master = this.requireUnsealed();
    if (request === null || typeof request !== 'object' || request.v !== 1) {
      throw new HqVaultError('VAULT_INVALID', 'Unsupported fetch request.');
    }
    const mode: HqVaultFetchMode | undefined =
      request.mode === 'list' ? 'list' : request.mode === 'fetch' ? 'fetch' : undefined;
    if (mode === undefined)
      throw new HqVaultError('VAULT_INVALID', "mode must be 'list' or 'fetch'.");
    if (
      request.secretIds !== undefined &&
      (!Array.isArray(request.secretIds) ||
        request.secretIds.length > 256 ||
        request.secretIds.some((id) => typeof id !== 'string'))
    ) {
      throw new HqVaultError('VAULT_INVALID', 'secretIds must be an array of ids.');
    }
    const device = this.file.devices.find((d) => d.id === request.deviceId);
    const { sig, ...rest } = request;
    // One answer for every authentication failure: an unknown device, a bad
    // signature and a pending device must not be distinguishable to a caller
    // who cannot sign.
    if (
      !device ||
      !hqVaultVerify({ ...rest, purpose: HQ_VAULT_FETCH_PURPOSE }, sig, device.signPublic)
    ) {
      throw new HqVaultError('VAULT_DENIED', 'Device authentication failed.');
    }
    if (device.status !== 'approved') {
      throw new HqVaultError(
        'VAULT_DENIED',
        device.status === 'pending'
          ? 'This device is waiting for approval in HQ.'
          : 'This device was revoked.',
      );
    }
    const ts = typeof request.ts === 'string' ? Date.parse(request.ts) : Number.NaN;
    const now = this.now();
    if (!Number.isFinite(ts) || Math.abs(now - ts) > HQ_VAULT_FETCH_SKEW_MS) {
      throw new HqVaultError(
        'VAULT_DENIED',
        'Request timestamp is outside the accepted window; check the clock.',
      );
    }
    if (
      typeof request.nonce !== 'string' ||
      request.nonce.length < 16 ||
      request.nonce.length > 128
    ) {
      throw new HqVaultError('VAULT_INVALID', 'nonce is malformed.');
    }
    if (!this.nonces.remember(`${device.id}:${request.nonce}`, ts, now)) {
      throw new HqVaultError('VAULT_DENIED', 'Request replayed.');
    }

    const wanted = request.secretIds ? new Set(request.secretIds) : undefined;
    const issuedAt = new Date(now).toISOString();
    const items: HqVaultBundleItem[] = [];
    for (const grant of this.file.grants) {
      if (grant.deviceId !== device.id) continue;
      if (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= now) continue;
      const secret = this.file.secrets.find((s) => s.id === grant.secretId);
      if (!secret) continue;
      if (wanted && !wanted.has(secret.id)) continue;
      const item: HqVaultBundleItem = {
        secretId: secret.id,
        providerId: secret.providerId,
        label: secret.label,
        kind: secret.kind,
        version: secret.version,
        grantId: grant.id,
        policy: grant.policy,
        setActive: grant.setActive,
        ...(grant.policy === 'lease'
          ? {
              leaseExpiresAt: new Date(
                now + (grant.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS) * 1000,
              ).toISOString(),
            }
          : {}),
      };
      if (mode === 'fetch') {
        const apiKey = decryptHqVaultValue(master, secret);
        item.sealed = hqVaultSeal(
          JSON.stringify({ apiKey }),
          device.encPublic,
          hqVaultItemAad({ deviceId: device.id, ...item }),
        );
      }
      items.push(item);
    }
    if (mode === 'fetch') {
      await this.mutate(async (file) => {
        const live = file.devices.find((d) => d.id === device.id);
        if (live) live.lastFetchAt = issuedAt;
      });
      await this.audit({
        kind: 'fetch',
        actor: `device:${device.id}`,
        deviceId: device.id,
        secretIds: items.map((i) => i.secretId),
      });
    }
    const identity = this.identityKeys!;
    const body = {
      v: 1 as const,
      hqId: this.file.identity!.hqId,
      deviceId: device.id,
      issuedAt,
      requestNonce: request.nonce,
      mode,
      items,
    };
    return { ...body, sig: hqVaultSign({ ...body, purpose: HQ_VAULT_BUNDLE_PURPOSE }, identity) };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private requireUnsealed(): Buffer {
    if (this.masterKey === undefined || this.identityKeys === undefined) {
      throw new HqVaultError(
        'VAULT_SEALED',
        'The HQ key vault is sealed. Unseal it with the vault passphrase.',
      );
    }
    return this.masterKey;
  }

  private async adoptMasterKey(key: Buffer, wrapped: boolean): Promise<void> {
    const identity = this.file.identity;
    if (identity) {
      // A wrong master key fails here, before the store is usable.
      const decoded = JSON.parse(
        hqVaultDecrypt(key, identity.privateKeys, `identity|${identity.hqId}`).toString('utf8'),
      ) as { encPrivate: string; signPrivate: string };
      this.identityKeys = {
        encPublic: identity.encPublic,
        signPublic: identity.signPublic,
        encPrivate: decoded.encPrivate,
        signPrivate: decoded.signPrivate,
      };
      this.masterKey = key;
      this.passphraseProtected = wrapped;
      return;
    }
    this.masterKey = key;
    this.passphraseProtected = wrapped;
    const keys = generateHqVaultKeyPair();
    const hqId = hqVaultKeyId(keys);
    await this.mutate(async (file) => {
      file.identity = {
        hqId,
        encPublic: keys.encPublic,
        signPublic: keys.signPublic,
        privateKeys: hqVaultEncrypt(
          key,
          Buffer.from(
            JSON.stringify({ encPrivate: keys.encPrivate, signPrivate: keys.signPrivate }),
          ),
          `identity|${hqId}`,
        ),
        createdAt: new Date(this.now()).toISOString(),
      };
    });
    this.identityKeys = keys;
  }

  /** Apply `fn` to a copy of the file, persist it, then make it current. */
  private mutate<T>(fn: (file: HqVaultFile) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.file);
      const result = await fn(draft);
      await this.io.write(draft);
      this.file = draft;
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async audit(entry: Omit<HqVaultAuditEntry, 'at'>): Promise<void> {
    await this.io.audit({ at: new Date(this.now()).toISOString(), ...entry });
  }
}
