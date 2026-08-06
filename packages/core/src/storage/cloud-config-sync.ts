import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '../utils/atomic-write.js';
import {
  applyNamespacePayload,
  buildNamespacePayloads,
  CLOUD_SYNC_NAMESPACES,
  NAMESPACE_SCHEMA_VERSIONS,
} from './cloud-config-sync/sanitize.js';

export {
  applyNamespacePayload,
  buildNamespacePayloads,
  CLOUD_SYNC_CONTRACT,
  CLOUD_SYNC_NAMESPACES,
  LOCAL_ONLY_TOP_LEVEL,
  NAMESPACE_SCHEMA_VERSIONS,
  stripSecretMaterial,
} from './cloud-config-sync/sanitize.js';

/**
 * CloudConfigSync — synchronizes the profile config with my.wrongstack.com over the
 * namespaced sync API v1 (server repo: docs/CLIENT_SYNC_CONTRACT.md).
 *
 * Distinct from the legacy GitHub `CloudSync` (whole-file categories to a private repo)
 * and from the local HQ command center: this speaks the portal's revisioned,
 * schema-validated, secret-free namespace protocol.
 *
 * A sync pass is pull-then-push:
 *   1. `GET /config?since=<cursor>` — apply changed namespaces at contract granularity
 *      (locally-kept fields the contract does not own are never clobbered).
 *   2. For each namespace whose projected payload hash differs from the last synced
 *      hash: `PUT /config/<ns>` with `baseRevision` + a persisted `mutationId`, so a
 *      crash-and-retry of the same logical change is idempotent server-side.
 *   3. `POST /heartbeat` with the cursor and revision map for fleet observability.
 *
 * Conflicts (409) resolve by three-way merge at owned-top-level-key granularity: keys the
 * local machine did not change since its last sync adopt the server value; keys it did
 * change keep the local value and are re-pushed on top of the server revision.
 */

export interface CloudConfigSyncSettings {
  enabled: boolean;
  /** Portal base URL, e.g. https://my.wrongstack.com — no trailing slash needed. */
  url: string;
  /** Machine bearer token (wst_…), already decrypted. */
  token: string;
}

interface CloudConfigSyncState {
  version: 1;
  /** Change-feed cursor the client has fully applied. */
  cursor: number;
  /** Server revision last seen per namespace. */
  namespaceRevisions: Record<string, number>;
  /** Hash of the projected payload at last successful sync — dirtiness detector. */
  syncedHashes: Record<string, string>;
  /** Projected payloads at last successful sync — the base of the three-way merge. */
  syncedPayloads: Record<string, Record<string, unknown>>;
  /** In-flight logical change per namespace; reused verbatim on retry. */
  pendingMutations: Record<string, { mutationId: string; hash: string }>;
  /** Payload hash the server refused per namespace; retried only after a local edit. */
  rejectedHashes: Record<string, string>;
  lastSyncedAt?: string | undefined;
}

export interface CloudConfigSyncDeps {
  /** State file location, e.g. `<profileDir>/cloud-sync-state.json`. */
  statePath: string;
  /** Reads the decrypted profile config object (the file layer, not env/CLI merges). */
  readLocalConfig(): Promise<Record<string, unknown>>;
  /**
   * Atomically mutates the profile config file. The mutator receives the decrypted
   * object and returns the replacement; the writer re-encrypts secrets and persists.
   */
  writeLocalConfig(
    mutator: (config: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>;
  /** Resolved cloud-sync settings, or null when unconfigured/disabled. */
  getSettings(): CloudConfigSyncSettings | null;
  fetchImpl?: typeof fetch | undefined;
  appVersion?: string | undefined;
  logger?: { info(msg: string): void; warn(msg: string): void } | undefined;
  randomUUID?: (() => string) | undefined;
  /** Request timeout per HTTP call. Default 15s. */
  requestTimeoutMs?: number | undefined;
}

export interface CloudSyncPassSummary {
  ok: boolean;
  skipped: boolean;
  pulled: string[];
  pushed: string[];
  conflicted: string[];
  rejected: string[];
  message: string;
}

const EMPTY_STATE: CloudConfigSyncState = {
  version: 1,
  cursor: 0,
  namespaceRevisions: {},
  syncedHashes: {},
  syncedPayloads: {},
  pendingMutations: {},
  rejectedHashes: {},
};

/** Deterministic JSON: object keys sorted recursively, so hashes are stable. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function hashPayload(payload: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function deepEquals(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

interface SnapshotResponse {
  namespace?: string;
  revision: number;
  schemaVersion: number;
  payload: Record<string, unknown>;
}

export class CloudConfigSync {
  private state: CloudConfigSyncState | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly uuid: () => string;
  private readonly timeoutMs: number;

  constructor(private readonly deps: CloudConfigSyncDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.uuid = deps.randomUUID ?? (() => nodeRandomUUID());
    this.timeoutMs = deps.requestTimeoutMs ?? 15_000;
  }

  /** One full pull-then-push-then-heartbeat pass. Never throws; failures are summarized. */
  async syncOnce(): Promise<CloudSyncPassSummary> {
    const settings = this.deps.getSettings();
    if (!settings?.enabled || !settings.url || !settings.token) {
      return summary({ skipped: true, message: 'Cloud sync is not configured.' });
    }

    const state = await this.loadState();
    const pulled: string[] = [];
    const pushed: string[] = [];
    const conflicted: string[] = [];
    const rejected: string[] = [];

    try {
      await this.pullChanges(settings, state, pulled);
      await this.pushDirty(settings, state, { pushed, conflicted, rejected });
      await this.heartbeat(settings, state);
      state.lastSyncedAt = new Date().toISOString();
      await this.saveState(state);
      return summary({
        ok: true,
        pulled,
        pushed,
        conflicted,
        rejected,
        message:
          pulled.length + pushed.length === 0
            ? 'Already in sync.'
            : `Pulled ${pulled.length}, pushed ${pushed.length} namespace(s).`,
      });
    } catch (error) {
      // Persist whatever progressed (applied pulls, pending mutation ids) so the next
      // pass resumes instead of repeating work.
      await this.saveState(state).catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger?.warn(`cloud-config-sync: pass failed: ${message}`);
      return summary({ pulled, pushed, conflicted, rejected, message });
    }
  }

  /** Human-readable status for the slash command. */
  async statusText(): Promise<string> {
    const settings = this.deps.getSettings();
    if (!settings?.enabled) {
      return 'Cloud config sync: disabled. Run `/cloudsync on` after setting url + token.';
    }
    const state = await this.loadState();
    const dirty = await this.dirtyNamespaces(state);
    const rejectedList = Object.keys(state.rejectedHashes);
    const lines = [
      'Cloud config sync: enabled',
      `  url:        ${settings.url}`,
      `  cursor:     ${state.cursor}`,
      `  last sync:  ${state.lastSyncedAt ?? 'never'}`,
      `  dirty:      ${dirty.length > 0 ? dirty.join(', ') : 'none'}`,
    ];
    if (rejectedList.length > 0) {
      lines.push(`  rejected:   ${rejectedList.join(', ')} (kept local; edit to retry)`);
    }
    return lines.join('\n');
  }

  // ── Pull ────────────────────────────────────────────────────────────────

  private async pullChanges(
    settings: CloudConfigSyncSettings,
    state: CloudConfigSyncState,
    pulled: string[],
  ): Promise<void> {
    const delta = (await this.request(settings, 'GET', `/api/sync/v1/config?since=${state.cursor}`))
      .json as {
      cursor: number;
      full: boolean;
      changed: Array<{ namespace: string; revision: number }>;
    };

    const toRead = delta.full
      ? CLOUD_SYNC_NAMESPACES.map((namespace) => ({ namespace }))
      : delta.changed.filter(
          (entry) =>
            CLOUD_SYNC_NAMESPACES.includes(entry.namespace) &&
            entry.revision > (state.namespaceRevisions[entry.namespace] ?? 0),
        );

    // Namespaces with unsynced local edits must not be blindly overwritten by a pull:
    // those merge three-way (unchanged keys adopt the server, changed keys stay local and
    // push later in this same pass).
    const dirtyBefore = new Set(await this.dirtyNamespaces(state));

    for (const entry of toRead) {
      const snapshot = (
        await this.request(
          settings,
          'GET',
          `/api/sync/v1/config/${encodeURIComponent(entry.namespace)}`,
        )
      ).json as SnapshotResponse;

      if ((state.namespaceRevisions[entry.namespace] ?? 0) >= snapshot.revision) continue;
      if (snapshot.revision === 0) {
        state.namespaceRevisions[entry.namespace] = 0;
        continue;
      }

      if (dirtyBefore.has(entry.namespace)) {
        const local = await this.deps.readLocalConfig();
        const localPayload = buildNamespacePayloads(local)[entry.namespace] ?? {};
        const base = state.syncedPayloads[entry.namespace] ?? {};
        const merged: Record<string, unknown> = { ...snapshot.payload };
        for (const [key, localValue] of Object.entries(localPayload)) {
          if (!deepEquals(localValue, base[key])) merged[key] = localValue;
        }
        await this.deps.writeLocalConfig((config) =>
          applyNamespacePayload(config, entry.namespace, merged),
        );
        // Revision advances to the server's; the synced hash deliberately does NOT — the
        // merged local state still differs from the server, so pushDirty sends it.
        state.namespaceRevisions[entry.namespace] = snapshot.revision;
        state.syncedPayloads[entry.namespace] = snapshot.payload;
      } else {
        await this.applySnapshot(entry.namespace, snapshot, state);
      }
      pulled.push(entry.namespace);
    }

    state.cursor = Math.max(state.cursor, delta.cursor);
  }

  private async applySnapshot(
    namespace: string,
    snapshot: SnapshotResponse,
    state: CloudConfigSyncState,
  ): Promise<void> {
    await this.deps.writeLocalConfig((config) =>
      applyNamespacePayload(config, namespace, snapshot.payload),
    );
    state.namespaceRevisions[namespace] = snapshot.revision;
    state.syncedPayloads[namespace] = snapshot.payload;
    // The applied server state is the new clean baseline: recompute from the merged
    // local file so local-only fields do not register as dirt.
    const local = await this.deps.readLocalConfig();
    const projected = buildNamespacePayloads(local)[namespace] ?? {};
    state.syncedHashes[namespace] = hashPayload(projected);
    delete state.pendingMutations[namespace];
    delete state.rejectedHashes[namespace];
  }

  // ── Push ────────────────────────────────────────────────────────────────

  private async dirtyNamespaces(state: CloudConfigSyncState): Promise<string[]> {
    const local = await this.deps.readLocalConfig();
    const payloads = buildNamespacePayloads(local);
    return Object.entries(payloads)
      .filter(([namespace, payload]) => hashPayload(payload) !== state.syncedHashes[namespace])
      .map(([namespace]) => namespace);
  }

  private async pushDirty(
    settings: CloudConfigSyncSettings,
    state: CloudConfigSyncState,
    out: { pushed: string[]; conflicted: string[]; rejected: string[] },
  ): Promise<void> {
    const local = await this.deps.readLocalConfig();
    const payloads = buildNamespacePayloads(local);

    for (const [namespace, payload] of Object.entries(payloads)) {
      const hash = hashPayload(payload);
      if (hash === state.syncedHashes[namespace]) continue;
      if (state.rejectedHashes[namespace] === hash) continue;

      const pending = state.pendingMutations[namespace];
      const mutationId = pending?.hash === hash ? pending.mutationId : this.uuid();
      // Persist the mutation id BEFORE the network call: a crash between request and
      // response must retry with the same id to hit the server's idempotency record.
      state.pendingMutations[namespace] = { mutationId, hash };
      await this.saveState(state);

      const result = await this.putNamespace(settings, state, namespace, payload, mutationId);
      if (result.kind === 'applied') {
        out.pushed.push(namespace);
      } else if (result.kind === 'conflict') {
        out.conflicted.push(namespace);
        await this.resolveConflict(settings, state, namespace, payload, result.server, out);
      } else {
        state.rejectedHashes[namespace] = hash;
        delete state.pendingMutations[namespace];
        out.rejected.push(namespace);
        this.deps.logger?.warn(
          `cloud-config-sync: server rejected ${namespace} (${result.code}); keeping it local until the config changes.`,
        );
      }
    }
  }

  private async putNamespace(
    settings: CloudConfigSyncSettings,
    state: CloudConfigSyncState,
    namespace: string,
    payload: Record<string, unknown>,
    mutationId: string,
  ): Promise<
    | { kind: 'applied' }
    | { kind: 'conflict'; server: SnapshotResponse }
    | { kind: 'rejected'; code: string }
  > {
    const response = await this.request(
      settings,
      'PUT',
      `/api/sync/v1/config/${encodeURIComponent(namespace)}`,
      {
        baseRevision: state.namespaceRevisions[namespace] ?? 0,
        mutationId,
        schemaVersion: NAMESPACE_SCHEMA_VERSIONS[namespace] ?? 1,
        payload,
      },
      // 409 (conflict) and 422 (contract mismatch) are protocol answers, not failures.
      [409, 422],
    );

    if (response.status === 422) {
      const code = (response.json as { error?: { code?: string } }).error?.code;
      return { kind: 'rejected', code: code ?? 'invalid_payload' };
    }

    const body = response.json as SnapshotResponse & { cursor?: number };
    if (response.status === 409) {
      // Conflict body carries the current server snapshot. Deliberately NOT written to
      // syncedPayloads here — that field is the three-way-merge base and must keep the
      // pre-conflict baseline until the merge lands.
      return { kind: 'conflict', server: body };
    }

    // 200 covers both `updated` and idempotent `duplicate` — same bookkeeping either way.
    state.namespaceRevisions[namespace] = body.revision;
    state.syncedHashes[namespace] = hashPayload(payload);
    state.syncedPayloads[namespace] = payload;
    if (typeof body.cursor === 'number') state.cursor = Math.max(state.cursor, body.cursor);
    delete state.pendingMutations[namespace];
    delete state.rejectedHashes[namespace];
    return { kind: 'applied' };
  }

  /**
   * Three-way merge at owned-top-level-key granularity: keys unchanged locally since the
   * last sync adopt the server value; locally-changed keys win and are re-pushed on top
   * of the server revision with a fresh mutation id.
   */
  private async resolveConflict(
    settings: CloudConfigSyncSettings,
    state: CloudConfigSyncState,
    namespace: string,
    localPayload: Record<string, unknown>,
    server: SnapshotResponse,
    out: { pushed: string[] },
  ): Promise<void> {
    const base = state.syncedPayloads[namespace] ?? {};
    const merged: Record<string, unknown> = { ...server.payload };
    for (const [key, localValue] of Object.entries(localPayload)) {
      if (!deepEquals(localValue, base[key])) merged[key] = localValue;
    }

    // Adopt the merge locally first, then push it on top of the server revision.
    await this.deps.writeLocalConfig((config) => applyNamespacePayload(config, namespace, merged));
    state.namespaceRevisions[namespace] = server.revision;

    const mutationId = this.uuid();
    const hash = hashPayload(merged);
    state.pendingMutations[namespace] = { mutationId, hash };
    await this.saveState(state);

    const result = await this.putNamespace(settings, state, namespace, merged, mutationId);
    if (result.kind === 'applied') {
      out.pushed.push(namespace);
    } else {
      this.deps.logger?.warn(
        `cloud-config-sync: conflict resolution for ${namespace} did not converge (${result.kind}); will retry next pass.`,
      );
    }
  }

  // ── Heartbeat ───────────────────────────────────────────────────────────

  private async heartbeat(
    settings: CloudConfigSyncSettings,
    state: CloudConfigSyncState,
  ): Promise<void> {
    await this.request(settings, 'POST', '/api/sync/v1/heartbeat', {
      transport: 'poll',
      syncCursor: state.cursor,
      namespaceRevisions: state.namespaceRevisions,
    }).catch((error) => {
      // Presence is best-effort; a failed heartbeat must not fail the sync pass.
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger?.warn(`cloud-config-sync: heartbeat failed: ${message}`);
    });
  }

  // ── HTTP + state plumbing ───────────────────────────────────────────────

  private async request(
    settings: CloudConfigSyncSettings,
    method: 'GET' | 'PUT' | 'POST',
    pathname: string,
    body?: unknown,
    acceptStatuses: number[] = [],
  ): Promise<{ status: number; json: unknown }> {
    const url = `${settings.url.replace(/\/+$/, '')}${pathname}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${settings.token}`,
      'X-WrongStack-Version': this.deps.appVersion ?? 'unknown',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await this.fetchImpl(url, init);

    const ok = response.ok || acceptStatuses.includes(response.status);
    if (!ok) {
      if (response.status === 401) {
        throw new Error('unauthorized: the machine token is invalid, expired, or revoked.');
      }
      if (response.status === 429) {
        throw new Error('rate limited by the portal; backing off until the next pass.');
      }
      throw new Error(`${method} ${pathname} failed with HTTP ${response.status}.`);
    }

    const json = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, json };
  }

  private async loadState(): Promise<CloudConfigSyncState> {
    if (this.state) return this.state;
    try {
      const raw = await fs.readFile(this.deps.statePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CloudConfigSyncState>;
      this.state = {
        ...structuredClone(EMPTY_STATE),
        ...parsed,
        version: 1,
      };
    } catch {
      this.state = structuredClone(EMPTY_STATE);
    }
    return this.state;
  }

  private async saveState(state: CloudConfigSyncState): Promise<void> {
    this.state = state;
    await fs.mkdir(path.dirname(this.deps.statePath), { recursive: true });
    await atomicWrite(this.deps.statePath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}

function summary(
  partial: Partial<CloudSyncPassSummary> & { message: string },
): CloudSyncPassSummary {
  return {
    ok: partial.ok ?? false,
    skipped: partial.skipped ?? false,
    pulled: partial.pulled ?? [],
    pushed: partial.pushed ?? [],
    conflicted: partial.conflicted ?? [],
    rejected: partial.rejected ?? [],
    message: partial.message,
  };
}
