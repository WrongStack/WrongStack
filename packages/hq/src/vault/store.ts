/**
 * HqVaultStore — HQ's encrypted provider profiles, device registry and grants.
 *
 * File `<dataDir>/hq-vault.json` (owner-only). Every key is encrypted under
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
import * as fs from 'node:fs/promises';
import { toErrorMessage } from '@wrongstack/primitives';
import {
  generateHqVaultKeyPair,
  type HqVaultKeyPair,
  hqVaultDecrypt,
  hqVaultEncrypt,
  hqVaultEnrollmentMac,
  hqVaultEnrollmentMacMatches,
  hqVaultFingerprint,
  hqVaultKeyId,
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
  type HqVaultDeviceRecord,
  type HqVaultEnrollRequest,
  type HqVaultEnrollResponse,
  type HqVaultFetchMode,
  type HqVaultFetchRequest,
  type HqVaultGrantRecord,
  type HqVaultIdentity,
  type HqVaultKeyMeta,
  type HqVaultProfileMeta,
} from './protocol.js';
import { buildHqVaultBundleProfiles, signHqVaultRevocation } from './store-bundle.js';
import {
  HQ_VAULT_FETCH_SKEW_MS,
  HqVaultEnrollmentCodes,
  HqVaultNonceCache,
} from './store-guards.js';
import {
  emptyHqVaultFile,
  type HqVaultAuditEntry,
  HqVaultError,
  type HqVaultFile,
  HqVaultFileIO,
  type HqVaultState,
  type HqVaultStatus,
  hqVaultText,
} from './store-model.js';
import {
  applyHqVaultSignIn,
  createHqVaultProfile,
  deleteHqVaultKey,
  deleteHqVaultProfile,
  findHqVaultProfile,
  type HqVaultSignInResult,
  hqVaultKeyMeta,
  hqVaultProfileMeta,
  parseHqVaultKeyInput,
  setHqVaultGrant,
  updateHqVaultProfile,
  upsertHqVaultKey,
} from './store-profiles.js';
import { dueHqVaultKeys, type HqVaultRefresher, renewHqVaultKey } from './store-refresh.js';

export interface HqVaultStoreOptions {
  now?: () => number;
  /** After an operator change (never a token renewal) is saved: HQ sends `hq.vault_changed`. */
  onChange?: (revision: number) => void;
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
    private readonly options: HqVaultStoreOptions,
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
        profiles: this.file.profiles.length,
        keys: this.file.profiles.reduce((n, p) => n + p.keys.length, 0),
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

  // ── Provider profiles ─────────────────────────────────────────────────────

  listProfiles(): HqVaultProfileMeta[] {
    return this.file.profiles.map((p) => hqVaultProfileMeta(this.file, p));
  }

  getProfile(id: string): HqVaultProfileMeta {
    return hqVaultProfileMeta(this.file, findHqVaultProfile(this.file, id));
  }

  async createProfile(input: Record<string, unknown>, actor: string): Promise<HqVaultProfileMeta> {
    const master = this.requireUnsealed();
    // A key typed together with the profile is validated before anything is written.
    const key =
      input.apiKey !== undefined
        ? parseHqVaultKeyInput({ label: input.keyLabel ?? 'default', apiKey: input.apiKey })
        : undefined;
    return this.change(async (file) => {
      const at = this.isoNow();
      const profile = createHqVaultProfile(file, input, at);
      if (key) upsertHqVaultKey(file, master, profile.id, key, at);
      await this.audit({ kind: 'profile.create', actor, profileId: profile.id });
      if (key) {
        await this.audit({
          kind: 'key.set',
          actor,
          profileId: profile.id,
          keyLabel: key.label,
          version: 1,
        });
      }
      return hqVaultProfileMeta(file, profile);
    });
  }

  async updateProfile(
    id: string,
    input: Record<string, unknown>,
    actor: string,
  ): Promise<HqVaultProfileMeta> {
    this.requireUnsealed();
    return this.change(async (file) => {
      const profile = updateHqVaultProfile(file, id, input, this.isoNow());
      await this.audit({ kind: 'profile.update', actor, profileId: id, version: profile.version });
      return hqVaultProfileMeta(file, profile);
    });
  }

  /** Delete a profile, its keys and every grant of it. */
  async deleteProfile(id: string, actor: string): Promise<void> {
    this.requireUnsealed();
    await this.change(async (file) => {
      deleteHqVaultProfile(file, id);
      await this.audit({ kind: 'profile.delete', actor, profileId: id });
    });
  }

  /** Add a key to a profile, or replace the value of the key with that label. */
  async setKey(
    id: string,
    input: Record<string, unknown>,
    actor: string,
    kind: 'key.set' | 'key.refresh' | 'oauth.signin' = 'key.set',
  ): Promise<HqVaultKeyMeta> {
    const master = this.requireUnsealed();
    const parsed = parseHqVaultKeyInput(input);
    return this.change(async (file) => {
      const { key } = upsertHqVaultKey(file, master, id, parsed, this.isoNow());
      await this.audit({ kind, actor, profileId: id, keyLabel: key.label, version: key.version });
      return hqVaultKeyMeta(key);
    });
  }

  async deleteKey(id: string, keyId: string, actor: string): Promise<void> {
    this.requireUnsealed();
    await this.change(async (file) => {
      const key = deleteHqVaultKey(file, id, keyId, this.isoNow());
      await this.audit({ kind: 'key.delete', actor, profileId: id, keyLabel: key.label });
    });
  }

  /** Store a provider sign-in (see {@link applyHqVaultSignIn}). */
  async saveSignIn(
    input: { profileId?: string | undefined; strategyId: string; result: HqVaultSignInResult },
    actor: string,
  ): Promise<HqVaultProfileMeta> {
    const master = this.requireUnsealed();
    return this.change(async (file) => {
      const { profile, key } = applyHqVaultSignIn(file, master, input, this.isoNow());
      await this.audit({
        kind: 'oauth.signin',
        actor,
        profileId: profile.id,
        keyLabel: key.label,
        version: key.version,
        detail: input.strategyId,
      });
      return hqVaultProfileMeta(file, profile);
    });
  }

  /** Grant (or withdraw) a whole profile to a device. Idempotent. */
  async setGrant(id: string, deviceId: unknown, granted: boolean, actor: string): Promise<void> {
    this.requireUnsealed();
    await this.change(async (file) => {
      if (!setHqVaultGrant(file, id, deviceId, granted, this.isoNow())) return;
      await this.audit({
        kind: granted ? 'grant.create' : 'grant.revoke',
        actor,
        profileId: id,
        deviceId: String(deviceId),
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
    return this.change(async (file) => {
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
  /**
   * @param options.refresher renews OAuth keys that are about to expire, after
   * the device has authenticated and before the bundle is sealed — so a device
   * always gets a live access token and HQ alone ever spends the refresh token.
   */
  async fetch(
    request: HqVaultFetchRequest,
    options: { refresher?: HqVaultRefresher | undefined } = {},
  ): Promise<HqVaultBundle> {
    const master = this.requireUnsealed();
    if (request === null || typeof request !== 'object' || request.v !== 2) {
      throw new HqVaultError('VAULT_INVALID', 'Unsupported fetch request; update this machine.');
    }
    const mode: HqVaultFetchMode | undefined =
      request.mode === 'list' ? 'list' : request.mode === 'fetch' ? 'fetch' : undefined;
    if (mode === undefined)
      throw new HqVaultError('VAULT_INVALID', "mode must be 'list' or 'fetch'.");
    if (
      request.profileIds !== undefined &&
      (!Array.isArray(request.profileIds) ||
        request.profileIds.length > 256 ||
        request.profileIds.some((id) => typeof id !== 'string'))
    ) {
      throw new HqVaultError('VAULT_INVALID', 'profileIds must be an array of ids.');
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
    // Before the clock/replay checks on purpose: the statement is bound to this request's nonce.
    if (device.status === 'revoked') {
      const revocation = signHqVaultRevocation(this.identityKeys!, {
        hqId: this.file.identity!.hqId,
        deviceId: device.id,
        requestNonce: String(request.nonce),
        revokedAt: device.revokedAt ?? new Date(this.now()).toISOString(),
      });
      throw new HqVaultError('VAULT_DENIED', 'This device was revoked.', { revocation });
    }
    if (device.status !== 'approved') {
      throw new HqVaultError('VAULT_DENIED', 'This device is waiting for approval in HQ.');
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

    if (mode === 'fetch' && options.refresher) {
      await this.refreshDue(device.id, request.profileIds, options.refresher, now);
    }
    const issuedAt = new Date(now).toISOString();
    const profiles = buildHqVaultBundleProfiles(
      this.file,
      master,
      device,
      mode,
      request.profileIds,
    );
    if (mode === 'fetch') {
      await this.mutate(async (file) => {
        const live = file.devices.find((d) => d.id === device.id);
        if (live) live.lastFetchAt = issuedAt;
      });
      await this.audit({
        kind: 'fetch',
        actor: `device:${device.id}`,
        deviceId: device.id,
        profileIds: profiles.map((p) => p.id),
      });
    }
    const identity = this.identityKeys!;
    const body = {
      v: 2 as const,
      hqId: this.file.identity!.hqId,
      deviceId: device.id,
      issuedAt,
      requestNonce: request.nonce,
      mode,
      profiles,
      revision: this.file.revision ?? 0,
    };
    return { ...body, sig: hqVaultSign({ ...body, purpose: HQ_VAULT_BUNDLE_PURPOSE }, identity) };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private readonly refreshing = new Map<string, Promise<void>>();

  /** Renew the device's due OAuth keys; one renewal per key at a time, failures logged and skipped. */
  private async refreshDue(
    deviceId: string,
    profileIds: readonly string[] | undefined,
    refresher: HqVaultRefresher,
    now: number,
  ): Promise<void> {
    const master = this.requireUnsealed();
    const due = dueHqVaultKeys(this.file, deviceId, profileIds, now);
    await Promise.all(
      due.map(({ profile, key }) => {
        const flight = `${key.id}:${key.version}`;
        let pending = this.refreshing.get(flight);
        if (!pending) {
          pending = (async () => {
            const renewed = await renewHqVaultKey(master, profile, key, refresher);
            if (!renewed) return;
            await this.mutate(async (file) => {
              const live = file.profiles
                .find((p) => p.id === profile.id)
                ?.keys.find((k) => k.id === key.id);
              // Replaced or deleted meanwhile: the operator's change wins.
              if (!live || live.version !== key.version) return;
              upsertHqVaultKey(file, master, profile.id, renewed, this.isoNow());
              await this.audit({
                kind: 'key.refresh',
                actor: 'hq',
                profileId: profile.id,
                keyLabel: key.label,
                version: key.version + 1,
              });
            });
          })()
            .catch(async (error: unknown) => {
              await this.audit({
                kind: 'key.refresh',
                actor: 'hq',
                profileId: profile.id,
                keyLabel: key.label,
                detail: `failed: ${toErrorMessage(error)}`.slice(0, 300),
              });
            })
            .finally(() => this.refreshing.delete(flight));
          this.refreshing.set(flight, pending);
        }
        return pending;
      }),
    );
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

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

  /** HQ's change counter (see {@link HqVaultStoreOptions.onChange}). */
  revision(): number {
    return this.file.revision ?? 0;
  }

  /** {@link mutate} for an operator change: bumps the revision, then tells `onChange`. */
  private async change<T>(fn: (file: HqVaultFile) => Promise<T>): Promise<T> {
    const result = await this.mutate(async (file) => {
      const out = await fn(file);
      file.revision = (file.revision ?? 0) + 1;
      return out;
    });
    this.options.onChange?.(this.revision());
    return result;
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
