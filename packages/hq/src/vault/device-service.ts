/**
 * HqCredentialService — the client half of the HQ key vault.
 *
 * Every surface that offers "Import from HQ" (`wstack hq enroll|sync`,
 * `wstack auth import --from hq`, the `/auth` menu, the TUI auth panel) calls
 * this one service, and the service writes keys only through the host's
 * locked provider-config writer (`mutateProviders`) — the same single writer
 * every other key entry uses.
 *
 * Rules it keeps:
 *  - Values arrive sealed to this device and signed by the HQ pinned at
 *    enrollment; a bundle that does not verify is discarded whole.
 *  - The unit is a provider profile: HQ's type, family, endpoint, model list
 *    and keys are mirrored together (`mirror.ts`). A provider entered on this
 *    machine is never overwritten — a clashing HQ profile is stored as
 *    `<id>-hq` — and the entry carries `source: { kind: 'hq', … }`.
 *  - `sync` mirrors HQ's changes and removes profiles HQ stopped granting,
 *    and touches nothing it did not create.
 *  - OAuth keys arrive as access tokens only; HQ alone holds the refresh token.
 *  - `push` moves a provider of this machine into HQ (`device-upload.ts`): it
 *    waits there for an operator, and the sync after the approval makes the
 *    original provider HQ's instead of adding a copy.
 */
import * as os from 'node:os';
import type { ProviderApiKey, ProviderConfig } from '@wrongstack/contracts/types/config';
import type { SecretVault } from '@wrongstack/contracts/types/secret-vault';
import {
  buildHqVaultEnrollRequest,
  buildHqVaultFetchRequest,
  type HqVaultOpenedProfile,
  openHqVaultBundle,
  verifyHqVaultEnrollResponse,
  verifyHqVaultRevocation,
} from './client.js';
import { generateHqVaultKeyPair } from './crypto.js';
import { normalizeKeys, writeKeysBack } from './device-keys.js';
import { hqBundleKeyToApiKey, mirrorHqProfile, resolveHqLocalId } from './device-mirror.js';
import {
  type HqDeviceRecord,
  hqDeviceFingerprint,
  readHqDevice,
  removeHqDevice,
  writeHqDevice,
} from './device-store.js';
import { adoptHqUpload, type HqPushReport, sendHqUploads } from './device-upload.js';
import type { HqVaultBundle, HqVaultEnrollResponse } from './protocol.js';

export type { HqPushReport } from './device-upload.js';

export interface HqCredentialServiceDeps {
  globalRoot: string;
  vault: SecretVault;
  /**
   * The host's single, locked provider-config writer (the CLI's
   * `mutateConfigProviders`, the WebUI host's file-locked mutate). Never a
   * plain load/save: a sync must not write back a map another process just
   * rotated a token in.
   */
  mutateProviders: (
    mutator: (providers: Record<string, ProviderConfig>) => void | Promise<void>,
  ) => Promise<void>;
  fetchImpl?: typeof fetch | undefined;
  hostname?: string | undefined;
  now?: (() => number) | undefined;
  /** Upper bound on one HQ request (default {@link HQ_REQUEST_TIMEOUT_MS}). */
  requestTimeoutMs?: number | undefined;
  /**
   * Where memory-only (lease) values go: the process's lease store
   * (`setLeasedCredentials` in `@wrongstack/providers`). Without it, lease
   * profiles are mirrored but their keys never resolve.
   */
  onLeases?: HqLeaseSink | undefined;
}

/** A leased value as the process holds it (the providers lease store's shape). */
export interface HqLeasedValue {
  apiKey: string;
  tokenType?: string | undefined;
  scope?: string | undefined;
  project?: string | undefined;
  expiresAt?: string | undefined;
  leaseUntil: number;
}

/** Replace this HQ's leases (all, or only `profileIds`'). Ids: `hqId|profileId|keyId`. */
export type HqLeaseSink = (
  hqId: string,
  leases: Array<[string, HqLeasedValue]>,
  scope: { profileIds?: readonly string[] | undefined },
) => void;

/** Renew a lease when this much of it is left, or before its token expires. */
const LEASE_RENEW_FRACTION = 0.2;
const LEASE_TOKEN_MARGIN_MS = 2 * 60_000;
const LEASE_MIN_RENEW_MS = 30_000;

/** One HQ request may take this long, the response body included. */
export const HQ_REQUEST_TIMEOUT_MS = 15_000;

export interface HqImportChange {
  /** The config id on this machine (the HQ id, or `<id>-hq` on a clash). */
  providerId: string;
  /** The profile id in HQ. */
  profileId: string;
  /** Set when a single key (not a whole profile) changed. */
  key?: string;
}

export interface HqImportReport {
  added: HqImportChange[];
  updated: HqImportChange[];
  removed: HqImportChange[];
  unchanged: HqImportChange[];
  /** Keys entered here that moved aside because HQ started using their label. */
  renamed: Array<HqImportChange & { key: string; to: string }>;
}

export class HqVaultClientRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** The parsed error answer (a revoked device's signed revocation rides here). */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'HqVaultClientRequestError';
  }
}

/** HQ revoked this device (verified); what HQ gave it has been removed. */
export class HqVaultDeviceRevokedError extends Error {
  constructor(
    readonly hqUrl: string,
    readonly removed: HqImportChange[],
  ) {
    super(
      removed.length > 0
        ? `HQ (${hqUrl}) revoked this machine; the ${removed.length} provider(s) and key(s) it had given were removed.`
        : `HQ (${hqUrl}) revoked this machine. Disconnect it here, or enroll it again.`,
    );
    this.name = 'HqVaultDeviceRevokedError';
  }
}

/** Normalise an HQ address to its origin; only http(s). */
export function normalizeHqOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim().includes('://') ? input.trim() : `http://${input.trim()}`);
  } catch {
    throw new Error(`Not an HQ address: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`HQ address must be http(s): ${input}`);
  }
  return url.origin;
}

function emptyReport(): HqImportReport {
  return { added: [], updated: [], removed: [], unchanged: [], renamed: [] };
}

export class HqCredentialService {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: HqCredentialServiceDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  device(): Promise<HqDeviceRecord | undefined> {
    return readHqDevice(this.deps.globalRoot, this.deps.vault);
  }

  /**
   * Enroll this machine with the token copied from HQ → System → Providers. Fresh
   * keys every time: an enrollment never reuses keys a previous HQ knew.
   */
  async enroll(
    hqUrl: string,
    enrollmentToken: string,
    options: { label?: string | undefined; replace?: boolean | undefined } = {},
  ): Promise<{ device: HqDeviceRecord; fingerprint: string }> {
    const origin = normalizeHqOrigin(hqUrl);
    const existing = await this.device().catch(() => undefined);
    if (existing && !options.replace) {
      throw new Error(
        `This machine is already enrolled with ${existing.hqUrl}. Run \`wstack hq unenroll\` first, or pass --replace.`,
      );
    }
    const keys = generateHqVaultKeyPair();
    const { request, code } = buildHqVaultEnrollRequest(keys, enrollmentToken, {
      hostname: this.deps.hostname ?? os.hostname(),
      ...(options.label ? { label: options.label } : {}),
    });
    const response = await this.request<HqVaultEnrollResponse>(
      origin,
      '/api/vault/enroll',
      request,
    );
    const hq = verifyHqVaultEnrollResponse(response, request, code);
    const device: HqDeviceRecord = {
      hqUrl: origin,
      hq,
      deviceId: response.deviceId,
      status: response.status,
      enrolledAt: new Date(this.now()).toISOString(),
      keys,
    };
    await writeHqDevice(this.deps.globalRoot, this.deps.vault, device);
    return { device, fingerprint: hqDeviceFingerprint(device) };
  }

  /** What HQ grants this device, without values. */
  async list(): Promise<HqVaultOpenedProfile[]> {
    const device = await this.requireDevice();
    return this.fetchBundle(device, 'list');
  }

  /** Import granted profiles (all, or the given HQ profile ids) into the active profile. */
  async importKeys(options: { profileIds?: string[] | undefined } = {}): Promise<HqImportReport> {
    const device = await this.requireDevice();
    const profiles = await this.fetchBundle(device, 'fetch', { profileIds: options.profileIds });
    const report = await this.apply(device, profiles, { removeUngranted: false });
    await this.deliverLeases(device, profiles, options.profileIds);
    return report;
  }

  /**
   * Fetch the memory-only (lease) values again, without touching config —
   * what each process does at start and before its leases run out. Resolves
   * to when the next renewal is due (undefined: no leases).
   */
  async refreshLeases(): Promise<number | undefined> {
    const device = await this.requireDevice();
    await this.deliverLeases(device, await this.fetchBundle(device, 'fetch'));
    return this.leaseRenewalAt;
  }

  /** When the leases this service delivered last are due for renewal. */
  nextLeaseRenewal(): number | undefined {
    return this.leaseRenewalAt;
  }

  /**
   * Upload providers of this machine (`localIds`; every one that can move
   * when `all`) to HQ, each sealed to HQ's identity key. Nothing local
   * changes now. `again` sends a provider whose earlier upload is still
   * pending here (the operator rejected it, say).
   */
  async push(
    localIds: readonly string[],
    options: { all?: boolean | undefined; again?: boolean | undefined } = {},
  ): Promise<HqPushReport> {
    const device = await this.requireDevice();
    return sendHqUploads(
      {
        device,
        now: this.now(),
        mutateProviders: this.deps.mutateProviders,
        send: (request) => this.request(device.hqUrl, '/api/vault/upload', request),
        save: async (update) => {
          const current = (await this.device()) ?? device;
          await writeHqDevice(this.deps.globalRoot, this.deps.vault, {
            ...current,
            pendingUploads: update(current.pendingUploads ?? []),
          });
        },
      },
      localIds,
      options,
    );
  }

  /** Bring HQ profiles in step with HQ: changes mirrored, ungranted ones removed. */
  async sync(): Promise<HqImportReport> {
    const device = await this.requireDevice();
    const fetched: { revision?: number } = {};
    const profiles = await this.fetchBundle(device, 'fetch', { out: fetched });
    const report = await this.apply(device, profiles, { removeUngranted: true });
    await this.deliverLeases(device, profiles, undefined, fetched.revision);
    return report;
  }

  /**
   * HQ's current change counter, from its unauthenticated revision endpoint:
   * cheap enough to poll, and it carries no ids or values. A sync is needed
   * when it is above `device.syncedRevision`.
   */
  async revision(signal?: AbortSignal): Promise<{ hqId: string; revision: number }> {
    const device = await this.requireDevice();
    const answer = await this.request<{ hqId?: unknown; revision?: unknown }>(
      device.hqUrl,
      '/api/vault/revision',
      undefined,
      signal,
    );
    if (typeof answer.hqId !== 'string' || !Number.isSafeInteger(answer.revision)) {
      throw new HqVaultClientRequestError('HQ answered the revision check malformed.', 200);
    }
    return { hqId: answer.hqId, revision: answer.revision as number };
  }

  /**
   * A fresh copy of one HQ-held OAuth key, for the provider runtime's renewal
   * (`setExternalCredentialRefresher`). HQ renews the token with the refresh
   * token it alone holds; this machine gets the new access token. Writes
   * nothing — the caller's refresh transaction or persister stores it.
   */
  async renewKey(credential: ProviderApiKey, signal?: AbortSignal): Promise<ProviderApiKey> {
    const source = credential.source;
    const device = await this.requireDevice();
    if (source?.kind !== 'hq' || source.hqId !== device.hq.hqId) {
      throw new Error(`"${credential.label}" did not come from ${device.hqUrl}.`);
    }
    // A renewal runs inside the config lock (the refresh transaction), so a
    // revocation here only fails it; the background sync — which HQ's revoke
    // also triggered — removes what HQ gave, outside the lock.
    const profiles = await this.fetchBundle(device, 'fetch', {
      profileIds: source.profileId ? [source.profileId] : undefined,
      signal,
      writes: false,
    });
    for (const profile of profiles) {
      const key = profile.keys.find((k) => k.id === source.keyId);
      if (!key?.secrets) continue;
      return {
        ...hqBundleKeyToApiKey(
          { ...key, secrets: key.secrets },
          device.hq.hqId,
          profile.id,
          credential.createdAt,
        ),
        label: credential.label,
      };
    }
    throw new Error(
      `HQ (${device.hqUrl}) no longer grants "${credential.label}"; run \`wstack hq sync\`.`,
    );
  }

  /** Forget this machine's HQ identity; optionally remove what it imported. */
  async unenroll(options: { removeKeys: boolean }): Promise<{ removed: HqImportChange[] }> {
    const device = await this.device().catch(() => undefined);
    const removed = device && options.removeKeys ? await this.removeOwned(device) : [];
    if (device) this.deps.onLeases?.(device.hq.hqId, [], {});
    await removeHqDevice(this.deps.globalRoot);
    return { removed };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async requireDevice(): Promise<HqDeviceRecord> {
    const device = await this.device();
    if (!device) {
      throw new Error(
        'This machine is not enrolled with an HQ key vault. In HQ open System → Providers → Devices → "Enroll a device", then run the command it shows.',
      );
    }
    return device;
  }

  /** Remove every provider and key this HQ gave the machine; keys entered here stay. */
  private async removeOwned(device: HqDeviceRecord): Promise<HqImportChange[]> {
    const removed: HqImportChange[] = [];
    await this.deps.mutateProviders((all) => {
      for (const [providerId, provider] of Object.entries(all)) {
        if (this.ownsProvider(device, provider)) {
          removed.push({ providerId, profileId: provider.source!.profileId });
          delete all[providerId];
        } else {
          this.dropHqKeys(device, providerId, provider, removed);
        }
      }
    });
    return removed;
  }

  /**
   * HQ revoked this device and proved it (a signature from the pinned HQ key
   * over this request): remove what HQ gave, keep the identity marked revoked
   * so status can say why, and stop.
   */
  private async revoked(device: HqDeviceRecord): Promise<never> {
    this.deps.onLeases?.(device.hq.hqId, [], {});
    const removed = await this.removeOwned(device);
    await writeHqDevice(this.deps.globalRoot, this.deps.vault, {
      ...device,
      status: 'revoked',
      revokedAt: new Date(this.now()).toISOString(),
    });
    throw new HqVaultDeviceRevokedError(device.hqUrl, removed);
  }

  private leaseRenewalAt: number | undefined;

  /**
   * Hand the lease profiles' values to the lease store, work out when to
   * renew them, and record (for every process on the machine) which profiles
   * are leases and which revision this machine has. A partial fetch
   * (`profileIds`) replaces only those profiles' leases.
   */
  private async deliverLeases(
    device: HqDeviceRecord,
    profiles: HqVaultOpenedProfile[],
    profileIds?: string[],
    revision?: number,
  ): Promise<void> {
    const now = this.now();
    const leases: Array<[string, HqLeasedValue]> = [];
    const leaseProfiles: string[] = [];
    let renewAt: number | undefined;
    for (const profile of profiles) {
      if (!profile.lease || profile.lease.withheld) continue;
      leaseProfiles.push(profile.id);
      const ttlMs = profile.lease.ttlSeconds * 1000;
      for (const key of profile.keys) {
        if (!key.secrets) continue;
        const id = `${device.hq.hqId}|${profile.id}|${key.id}`;
        leases.push([
          id,
          {
            ...key.secrets,
            ...(key.expiresAt ? { expiresAt: key.expiresAt } : {}),
            leaseUntil: now + ttlMs,
          },
        ]);
        const expires = key.expiresAt
          ? Date.parse(key.expiresAt) - LEASE_TOKEN_MARGIN_MS
          : Infinity;
        const due = Math.max(
          now + LEASE_MIN_RENEW_MS,
          Math.min(now + ttlMs * (1 - LEASE_RENEW_FRACTION), expires),
        );
        renewAt = renewAt === undefined ? due : Math.min(renewAt, due);
      }
    }
    this.deps.onLeases?.(device.hq.hqId, leases, { profileIds });
    if (!profileIds) this.leaseRenewalAt = renewAt;
    const current = (await this.device()) ?? device;
    const sameLeases =
      profileIds !== undefined ||
      JSON.stringify(current.leaseProfileIds ?? []) === JSON.stringify(leaseProfiles);
    const sameRevision = revision === undefined || revision === current.syncedRevision;
    if (sameLeases && sameRevision) return;
    await writeHqDevice(this.deps.globalRoot, this.deps.vault, {
      ...current,
      ...(sameRevision ? {} : { syncedRevision: revision }),
      ...(profileIds !== undefined ? {} : { leaseProfileIds: leaseProfiles }),
    });
  }

  private ownsProvider(device: HqDeviceRecord, provider: ProviderConfig): boolean {
    return provider.source?.kind === 'hq' && provider.source.hqId === device.hq.hqId;
  }

  private isFrom(device: HqDeviceRecord, key: ProviderApiKey): boolean {
    return key.source?.kind === 'hq' && key.source.hqId === device.hq.hqId;
  }

  /**
   * Remove keys this HQ put into a provider it does not own — what a
   * version-1 import left behind (one key per grant into an existing
   * provider). Keys entered on this machine are untouched.
   */
  private dropHqKeys(
    device: HqDeviceRecord,
    providerId: string,
    provider: ProviderConfig,
    removed: HqImportChange[],
  ): void {
    const keys = normalizeKeys(provider);
    const kept = keys.filter((k) => !this.isFrom(device, k));
    if (kept.length === keys.length) return;
    for (const k of keys) {
      if (this.isFrom(device, k)) removed.push({ providerId, profileId: providerId, key: k.label });
    }
    writeKeysBack(provider, kept);
  }

  private async fetchBundle(
    device: HqDeviceRecord,
    mode: 'list' | 'fetch',
    options: {
      profileIds?: string[] | undefined;
      signal?: AbortSignal | undefined;
      /** Receives the bundle's `revision`. */
      out?: { revision?: number } | undefined;
      /** False inside the config lock: a revocation then only throws, writing nothing. */
      writes?: boolean | undefined;
    } = {},
  ): Promise<HqVaultOpenedProfile[]> {
    const { profileIds, signal, out } = options;
    const request = buildHqVaultFetchRequest(device.keys, {
      mode,
      now: this.now(),
      ...(profileIds ? { profileIds } : {}),
    });
    let bundle: HqVaultBundle;
    try {
      bundle = await this.request<HqVaultBundle>(device.hqUrl, '/api/vault/fetch', request, signal);
    } catch (error) {
      const answer = (error as HqVaultClientRequestError).body as
        | { revocation?: unknown }
        | undefined;
      if (
        error instanceof HqVaultClientRequestError &&
        verifyHqVaultRevocation(answer?.revocation, device.keys, device.hq, request)
      ) {
        if (options.writes === false) throw new HqVaultDeviceRevokedError(device.hqUrl, []);
        await this.revoked(device);
      }
      throw error;
    }
    const profiles = openHqVaultBundle(bundle, device.keys, device.hq, request);
    if (out && Number.isSafeInteger(bundle.revision)) out.revision = bundle.revision as number;
    if (device.status !== 'approved') {
      // A fetch only succeeds for an approved device.
      await writeHqDevice(this.deps.globalRoot, this.deps.vault, { ...device, status: 'approved' });
    }
    return profiles;
  }

  private async apply(
    device: HqDeviceRecord,
    profiles: HqVaultOpenedProfile[],
    options: { removeUngranted: boolean },
  ): Promise<HqImportReport> {
    const report = emptyReport();
    const granted = new Set(profiles.map((p) => p.id));
    const pending = device.pendingUploads ?? [];
    const settled = new Set<string>();
    await this.deps.mutateProviders((all) => {
      for (const profile of profiles) {
        // An approved upload of this machine: its provider becomes this profile's home.
        const upload = profile.uploadId
          ? pending.find((u) => u.uploadId === profile.uploadId)
          : undefined;
        if (upload) {
          adoptHqUpload(all, upload, device.hq.hqId, profile.id);
          settled.add(upload.uploadId);
        }
        const localId = resolveHqLocalId(all, device.hq.hqId, profile.id);
        const change: HqImportChange = { providerId: localId, profileId: profile.id };
        const existing = all[localId];
        const mirrored = mirrorHqProfile(existing, profile, device.hq.hqId);
        all[localId] = mirrored.provider;
        if (!existing) report.added.push(change);
        else if (mirrored.changed) report.updated.push(change);
        else report.unchanged.push(change);
        for (const r of mirrored.renamed) {
          report.renamed.push({ ...change, key: r.from, to: r.to });
        }
      }
      if (!options.removeUngranted) return;
      for (const [providerId, provider] of Object.entries(all)) {
        if (this.ownsProvider(device, provider)) {
          if (!granted.has(provider.source!.profileId)) {
            report.removed.push({ providerId, profileId: provider.source!.profileId });
            delete all[providerId];
          }
        } else {
          this.dropHqKeys(device, providerId, provider, report.removed);
        }
      }
    });
    const now = this.now();
    if (pending.some((u) => settled.has(u.uploadId) || Date.parse(u.expiresAt) <= now)) {
      const current = (await this.device()) ?? device;
      await writeHqDevice(this.deps.globalRoot, this.deps.vault, {
        ...current,
        pendingUploads: (current.pendingUploads ?? []).filter(
          (u) => !settled.has(u.uploadId) && Date.parse(u.expiresAt) > now,
        ),
      });
    }
    return report;
  }

  /**
   * Every HQ call is bounded: a renewal runs inside the config file lock, so
   * an HQ that accepts the connection and stalls must not hold that lock (and
   * every other process waiting on it) until the OS gives up.
   */
  private async request<T>(
    origin: string,
    pathname: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const timeoutMs = this.deps.requestTimeoutMs ?? HQ_REQUEST_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const unreachable = (cause: unknown): HqVaultClientRequestError => {
      const detail = timeout.aborted
        ? `no answer within ${Math.round(timeoutMs / 1000)}s`
        : ((cause as { cause?: { code?: string } }).cause?.code ?? (cause as Error).message);
      return new HqVaultClientRequestError(`Cannot reach HQ at ${origin} (${detail}).`, 0);
    };
    let response: Response;
    let text: string;
    try {
      bounded.throwIfAborted();
      response = await this.fetchImpl(
        `${origin}${pathname}`,
        body === undefined
          ? { method: 'GET', signal: bounded }
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: bounded,
            },
      );
      text = await response.text();
    } catch (cause) {
      throw unreachable(cause);
    }
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new HqVaultClientRequestError(
        `HQ answered ${response.status} with something that is not JSON.`,
        response.status,
      );
    }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string } | string }).error;
      const message =
        typeof error === 'string' ? error : (error?.message ?? `HQ answered ${response.status}.`);
      throw new HqVaultClientRequestError(
        message,
        response.status,
        typeof error === 'object' ? error?.code : undefined,
        parsed,
      );
    }
    return parsed as T;
  }
}
