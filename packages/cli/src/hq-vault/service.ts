/**
 * HqCredentialService — the client half of the HQ key vault.
 *
 * Every surface that offers "Import from HQ" (`wstack hq enroll|sync`,
 * `wstack auth import --from hq`, the `/auth` menu, the TUI auth panel) calls
 * this one service, and the service writes keys only through
 * `mutateConfigProviders` — the same single writer every other key entry uses.
 *
 * Rules it keeps:
 *  - Values arrive sealed to this device and signed by the HQ pinned at
 *    enrollment; a bundle that does not verify is discarded whole.
 *  - HQ supplies credentials, never endpoints: an existing provider's
 *    `baseUrl`, `family` and headers are never touched (the WS-06 key-exfil
 *    pattern). A provider missing locally is created from the catalog only;
 *    one the catalog does not know is skipped, not invented.
 *  - Imported keys carry `source: { kind: 'hq', … }`; `sync` replaces rotated
 *    ones and removes those HQ stopped granting — and touches nothing else.
 *  - `activeKey` changes only when the grant says so.
 *  - `lease` grants (memory-only keys) are not written to disk; they are
 *    reported as skipped until in-memory leases land.
 */
import * as os from 'node:os';
import type { ModelsRegistry } from '@wrongstack/contracts/types';
import type { ProviderApiKey, ProviderConfig } from '@wrongstack/contracts/types/config';
import type { SecretVault } from '@wrongstack/contracts/types/secret-vault';
import {
  buildHqVaultEnrollRequest,
  buildHqVaultFetchRequest,
  generateHqVaultKeyPair,
  type HqVaultBundle,
  type HqVaultBundleItem,
  type HqVaultEnrollResponse,
  type HqVaultOpenedItem,
  openHqVaultBundle,
  verifyHqVaultEnrollResponse,
} from '@wrongstack/hq';
import {
  mutateConfigProviders,
  normalizeKeys,
  nowIso,
  writeKeysBack,
} from '../provider-config-utils.js';
import {
  type HqDeviceRecord,
  hqDeviceFingerprint,
  readHqDevice,
  removeHqDevice,
  writeHqDevice,
} from './device-store.js';

export interface HqCredentialServiceDeps {
  globalRoot: string;
  vault: SecretVault;
  profileConfigPath: string;
  modelsRegistry?: Pick<ModelsRegistry, 'getProvider'> | undefined;
  fetchImpl?: typeof fetch | undefined;
  hostname?: string | undefined;
  now?: (() => number) | undefined;
}

export interface HqImportChange {
  providerId: string;
  label: string;
}

export interface HqImportReport {
  added: HqImportChange[];
  updated: HqImportChange[];
  removed: HqImportChange[];
  unchanged: HqImportChange[];
  skipped: Array<HqImportChange & { reason: string }>;
}

export class HqVaultClientRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'HqVaultClientRequestError';
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
  return { added: [], updated: [], removed: [], unchanged: [], skipped: [] };
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
   * Enroll this machine with the token copied from HQ → System → Keys. Fresh
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
    const response = await this.post<HqVaultEnrollResponse>(origin, '/api/vault/enroll', request);
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
  async list(): Promise<HqVaultBundleItem[]> {
    const device = await this.requireDevice();
    const { items } = await this.fetchBundle(device, 'list');
    return items;
  }

  /** Import granted keys (all, or the given vault key ids) into the active profile. */
  async importKeys(options: { keyIds?: string[] | undefined } = {}): Promise<HqImportReport> {
    const device = await this.requireDevice();
    const { items } = await this.fetchBundle(device, 'fetch', options.keyIds);
    return this.apply(device, items, { removeUngranted: false });
  }

  /** Bring imported keys in step with HQ: rotated ones replaced, ungranted ones removed. */
  async sync(): Promise<HqImportReport> {
    const device = await this.requireDevice();
    const { items } = await this.fetchBundle(device, 'fetch');
    return this.apply(device, items, { removeUngranted: true });
  }

  /** Forget this machine's HQ identity; optionally remove the keys it imported. */
  async unenroll(options: { removeKeys: boolean }): Promise<{ removed: HqImportChange[] }> {
    const device = await this.device().catch(() => undefined);
    const removed: HqImportChange[] = [];
    if (device && options.removeKeys) {
      await mutateConfigProviders(this.deps.profileConfigPath, this.deps.vault, (all) => {
        for (const [providerId, provider] of Object.entries(all)) {
          const keys = normalizeKeys(provider);
          const kept = keys.filter((k) => !this.isFrom(device, k));
          if (kept.length === keys.length) continue;
          for (const k of keys)
            if (this.isFrom(device, k)) removed.push({ providerId, label: k.label });
          writeKeysBack(provider, kept);
        }
      });
    }
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
        'This machine is not enrolled with an HQ key vault. In HQ open System → Keys → "Enroll a device", then run the command it shows.',
      );
    }
    return device;
  }

  private isFrom(device: HqDeviceRecord, key: ProviderApiKey): boolean {
    return key.source?.kind === 'hq' && key.source.hqId === device.hq.hqId;
  }

  private async fetchBundle(
    device: HqDeviceRecord,
    mode: 'list' | 'fetch',
    keyIds?: string[],
  ): Promise<{ items: HqVaultOpenedItem[] }> {
    const request = buildHqVaultFetchRequest(device.keys, {
      mode,
      now: this.now(),
      ...(keyIds ? { secretIds: keyIds } : {}),
    });
    const bundle = await this.post<HqVaultBundle>(device.hqUrl, '/api/vault/fetch', request);
    const items = openHqVaultBundle(bundle, device.keys, device.hq, request);
    if (device.status !== 'approved') {
      // A fetch only succeeds for an approved device.
      await writeHqDevice(this.deps.globalRoot, this.deps.vault, { ...device, status: 'approved' });
    }
    return { items };
  }

  private async apply(
    device: HqDeviceRecord,
    items: HqVaultOpenedItem[],
    options: { removeUngranted: boolean },
  ): Promise<HqImportReport> {
    const report = emptyReport();
    const catalog = new Map<string, { family?: string; baseUrl?: string; envVars?: string[] }>();
    for (const item of items) {
      if (item.policy !== 'local' || item.apiKey === undefined || catalog.has(item.providerId))
        continue;
      const known = await this.deps.modelsRegistry
        ?.getProvider(item.providerId)
        .catch(() => undefined);
      if (known) {
        catalog.set(item.providerId, {
          ...(known.family ? { family: known.family } : {}),
          ...(known.apiBase ? { baseUrl: known.apiBase } : {}),
          ...(known.envVars ? { envVars: known.envVars } : {}),
        });
      }
    }
    const granted = new Set(items.map((i) => i.secretId));
    await mutateConfigProviders(this.deps.profileConfigPath, this.deps.vault, (all) => {
      for (const item of items) {
        const change = { providerId: item.providerId, label: item.label };
        if (item.policy === 'lease') {
          report.skipped.push({
            ...change,
            reason: 'leased (memory-only) keys are not written to disk; lease support comes later',
          });
          continue;
        }
        if (item.apiKey === undefined) continue;
        let provider: ProviderConfig | undefined = all[item.providerId];
        if (!provider) {
          const known = catalog.get(item.providerId);
          if (!known) {
            report.skipped.push({
              ...change,
              reason: `"${item.providerId}" is neither configured here nor in the provider catalog; add it with \`wstack auth\` first`,
            });
            continue;
          }
          provider = {
            type: item.providerId,
            ...(known.family ? { family: known.family as ProviderConfig['family'] } : {}),
            ...(known.baseUrl ? { baseUrl: known.baseUrl } : {}),
            ...(known.envVars ? { envVars: known.envVars } : {}),
          };
          all[item.providerId] = provider;
        }
        const keys = normalizeKeys(provider);
        const source = {
          kind: 'hq' as const,
          hqId: device.hq.hqId,
          keyId: item.secretId,
          version: item.version,
          grantId: item.grantId,
        };
        const existing = keys.find(
          (k) => this.isFrom(device, k) && k.source?.keyId === item.secretId,
        );
        let label: string;
        // A grant's "make it active" applies once — when the key arrives, or
        // when a new grant delivers it — never on every sync: switching back
        // to another key must survive the next `wstack hq sync`.
        let newGrant: boolean;
        if (existing) {
          label = existing.label;
          newGrant = existing.source?.grantId !== item.grantId;
          if (
            !newGrant &&
            existing.apiKey === item.apiKey &&
            existing.source?.version === item.version
          ) {
            report.unchanged.push({ ...change, label });
          } else {
            existing.apiKey = item.apiKey;
            existing.source = source;
            report.updated.push({ ...change, label });
          }
        } else {
          const used = new Set(keys.map((k) => k.label));
          label = item.label;
          if (used.has(label)) label = `${item.label}-hq`;
          for (let n = 2; used.has(label); n++) label = `${item.label}-hq-${n}`;
          newGrant = true;
          keys.push({
            label,
            apiKey: item.apiKey,
            createdAt: nowIso(),
            authMethod: 'api_key',
            source,
          });
          report.added.push({ ...change, label });
        }
        if (item.setActive && newGrant) provider.activeKey = label;
        writeKeysBack(provider, keys);
      }
      if (!options.removeUngranted) return;
      for (const [providerId, provider] of Object.entries(all)) {
        const keys = normalizeKeys(provider);
        const kept = keys.filter(
          (k) => !this.isFrom(device, k) || granted.has(k.source?.keyId ?? ''),
        );
        if (kept.length === keys.length) continue;
        for (const k of keys) {
          if (!kept.includes(k)) report.removed.push({ providerId, label: k.label });
        }
        writeKeysBack(provider, kept);
      }
    });
    return report;
  }

  private async post<T>(origin: string, pathname: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${origin}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      const detail =
        (cause as { cause?: { code?: string } }).cause?.code ?? (cause as Error).message;
      throw new HqVaultClientRequestError(`Cannot reach HQ at ${origin} (${detail}).`, 0);
    }
    const text = await response.text();
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
      );
    }
    return parsed as T;
  }
}
