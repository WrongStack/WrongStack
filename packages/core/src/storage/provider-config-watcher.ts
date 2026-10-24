/**
 * provider-config-watcher — live hot-reload of provider credentials.
 *
 * Provider API keys are read from `config.json` once at boot and baked into
 * the constructed `Provider`. When a user adds/removes/replaces a key in
 * another process (a second terminal running `wstack auth`, or either WebUI
 * provider panel), a *running* session would otherwise keep using the
 * boot-time key until restart.
 *
 * This watcher closes that gap: it tails a config file and emits whenever any
 * field changes. The callback receives the decrypted provider/routing subset
 * plus an opaque full-file fingerprint; hosts then re-run the canonical config
 * loader, replace the complete live Config snapshot, and rebuild the active
 * provider only when its construction inputs changed.
 *
 * It mirrors {@link module:hq/auth-store.watchHqAuthFile}:
 * - Watches the *directory* (not the file) so atomic tmp+rename writes
 *   (see {@link module:utils/atomic-write.atomicWrite}) surface reliably.
 * - Debounces events (most writers do a tmp+rename dance emitting several).
 * - Reads leniently — a missing/corrupt/torn file yields a warning, never a
 *   throw, and the watcher stays live for the next valid write.
 *
 * A `lastSerialized` guard suppresses callbacks when the complete on-disk
 * document is identical to the last one surfaced. Rewrites that only change
 * formatting may still cause a harmless reload; semantic changes never wait
 * for a restart.
 *
 * `fs.watch` is best-effort across platforms; on some network filesystems
 * events may not fire and the operator must restart to pick up changes.
 *
 * @module storage/provider-config-watcher
 */
import * as syncFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ProviderConfig } from '@wrongstack/contracts/types/config';
import type { SecretVault } from '@wrongstack/contracts/types/secret-vault';
import { decryptConfigSecrets } from '../security/config-secrets.js';
import { normalizeInlineProviderModels } from './config-loader/inline-provider-models.js';

/**
 * A decrypted snapshot of the credential-bearing slice of `config.json`.
 * `providers` is always present (empty object when the file has none);
 * `apiKey`/`baseUrl` are the top-level fallbacks a provider inherits when its
 * saved entry omits them.
 */
export interface ProviderConfigSnapshot {
  providers: Record<string, ProviderConfig>;
  /**
   * Opaque full-file fingerprint. It makes the watcher fire for changes outside
   * the historical credential/routing subset; consumers can then reload the
   * canonical full Config without exposing raw config values here.
   */
  sourceFingerprint?: string;
  /** True when the config file actually had a `providers` key. The watcher
   *  callback uses this to avoid clearing in-memory providers during hot-reload
   *  when the profile config file simply doesn't define any — without this
   *  guard, reading a profile config that has no `providers` key would set
   *  `appConfig.providers = {}` and wipe all configured providers. */
  snapshotHasProviders: boolean;
  apiKey?: string;
  baseUrl?: string;
  /** Display language (Config.uiLocale), surfaced so a cross-process change
   *  (e.g. the desktop shell) propagates to running webui instances. */
  uiLocale?: string;
  /** Live routing fields — surfaced so a cross-process WebUI /setmodel or
   *  profile-reorder propagates to running workers without restart. */
  fallbackModels?: string[];
  fallbackBridge?: string;
  fallbackProfiles?: Record<string, string[]>;
  /** Selected named profile (Config.fallbackProfile). */
  fallbackProfile?: string;
  favoriteModels?: string[];
  disabledModels?: string[];
  disabledProviders?: string[];
  favoriteModelsOnly?: boolean;
  modelMatrix?: Record<string, unknown>;
  fallbackAuto?: boolean;
  /** Primary-probe cooldown / sticky-dwell tuning (Config.fallbackStickiness). */
  fallbackStickiness?: { primaryProbeInterval?: number; stickyFallbackTurns?: number };
  /** Last-resort append cap (Config.fallbackMaxLastResortCandidates). */
  fallbackMaxLastResortCandidates?: number;
  modelAvailabilitySchedule?: import('@wrongstack/contracts/types/model-availability').ModelBlackoutRule[];
}

export interface WatchProviderConfigOptions {
  /** Surface non-fatal read/parse/decrypt issues. */
  warn?: (msg: string) => void;
  /** Coalesce bursts of fs events (default 200ms). */
  debounceMs?: number;
}

/**
 * Read and decrypt the credential slice of a config file. Returns `undefined`
 * when the file is missing or unparseable (the `warn` callback carries the
 * detail); never throws for routine I/O.
 *
 * Exported so multi-layer watchers (e.g. `provider-runtime-setup.ts`) can
 * re-read every active config layer when any layer changes, then merge them
 * with correct precedence before applying.
 */
export async function readProviderSnapshot(
  configPath: string,
  vault: SecretVault,
  warn?: (msg: string) => void,
): Promise<ProviderConfigSnapshot | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn?.(`Could not read ${configPath}: ${(err as Error).message}`);
    }
    return undefined;
  }
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      warn?.(`Config at ${configPath} must be a JSON object`);
      return undefined;
    }
    parsed = value as Record<string, unknown>;
  } catch (err) {
    // A torn read mid-rename can surface as invalid JSON; treat as transient.
    warn?.(`Config at ${configPath} is not valid JSON: ${(err as Error).message}`);
    return undefined;
  }
  normalizeInlineProviderModels(parsed, (message, context) => {
    const suffix = context ? ` (${JSON.stringify(context)})` : '';
    warn?.(`${message}${suffix}`);
  });
  const decrypted = decryptConfigSecrets(parsed, vault, warn ? { warn } : {}) as {
    providers?: Record<string, ProviderConfig>;
    apiKey?: string;
    baseUrl?: string;
    uiLocale?: string;
    fallbackModels?: string[];
    fallbackBridge?: string;
    fallbackProfiles?: Record<string, string[]>;
    fallbackProfile?: string;
    favoriteModels?: string[];
    disabledModels?: string[];
    disabledProviders?: string[];
    favoriteModelsOnly?: boolean;
    modelMatrix?: Record<string, unknown>;
    fallbackAuto?: boolean;
    fallbackStickiness?: { primaryProbeInterval?: number; stickyFallbackTurns?: number };
    fallbackMaxLastResortCandidates?: number;
    modelAvailabilitySchedule?: import('@wrongstack/contracts/types/model-availability').ModelBlackoutRule[];
  };
  const snapshot: ProviderConfigSnapshot = {
    providers: decrypted.providers ?? {},
    snapshotHasProviders: decrypted.providers !== undefined,
    sourceFingerprint: JSON.stringify(parsed),
  };
  if (typeof decrypted.apiKey === 'string') snapshot.apiKey = decrypted.apiKey;
  if (typeof decrypted.baseUrl === 'string') snapshot.baseUrl = decrypted.baseUrl;
  if (typeof decrypted.uiLocale === 'string' && decrypted.uiLocale)
    snapshot.uiLocale = decrypted.uiLocale;
  if (Array.isArray(decrypted.fallbackModels)) snapshot.fallbackModels = decrypted.fallbackModels;
  if (typeof decrypted.fallbackBridge === 'string' && decrypted.fallbackBridge.trim()) {
    snapshot.fallbackBridge = decrypted.fallbackBridge.trim();
  }
  if (decrypted.fallbackProfiles) snapshot.fallbackProfiles = decrypted.fallbackProfiles;
  if (typeof decrypted.fallbackProfile === 'string' && decrypted.fallbackProfile.trim()) {
    snapshot.fallbackProfile = decrypted.fallbackProfile.trim();
  }
  if (decrypted.fallbackStickiness && typeof decrypted.fallbackStickiness === 'object') {
    snapshot.fallbackStickiness = decrypted.fallbackStickiness;
  }
  if (
    typeof decrypted.fallbackMaxLastResortCandidates === 'number' &&
    Number.isFinite(decrypted.fallbackMaxLastResortCandidates)
  ) {
    snapshot.fallbackMaxLastResortCandidates = decrypted.fallbackMaxLastResortCandidates;
  }
  if (Array.isArray(decrypted.favoriteModels)) snapshot.favoriteModels = decrypted.favoriteModels;
  if (Array.isArray(decrypted.disabledModels)) snapshot.disabledModels = decrypted.disabledModels;
  if (Array.isArray(decrypted.disabledProviders))
    snapshot.disabledProviders = decrypted.disabledProviders;
  if (typeof decrypted.favoriteModelsOnly === 'boolean')
    snapshot.favoriteModelsOnly = decrypted.favoriteModelsOnly;
  if (decrypted.modelMatrix) snapshot.modelMatrix = decrypted.modelMatrix;
  if (typeof decrypted.fallbackAuto === 'boolean') snapshot.fallbackAuto = decrypted.fallbackAuto;
  if (Array.isArray(decrypted.modelAvailabilitySchedule))
    snapshot.modelAvailabilitySchedule = decrypted.modelAvailabilitySchedule;
  return snapshot;
}

/** Stable serialization for the no-op guard (key order independent). */
function serializeSnapshot(s: ProviderConfigSnapshot): string {
  return JSON.stringify({
    sourceFingerprint: s.sourceFingerprint ?? null,
    providers: s.providers,
    apiKey: s.apiKey ?? null,
    baseUrl: s.baseUrl ?? null,
    uiLocale: s.uiLocale ?? null,
    fallbackModels: s.fallbackModels ?? null,
    fallbackBridge: s.fallbackBridge ?? null,
    fallbackProfiles: s.fallbackProfiles ?? null,
    fallbackProfile: s.fallbackProfile ?? null,
    favoriteModels: s.favoriteModels ?? null,
    disabledModels: s.disabledModels ?? null,
    disabledProviders: s.disabledProviders ?? null,
    favoriteModelsOnly: s.favoriteModelsOnly ?? null,
    modelMatrix: s.modelMatrix ?? null,
    fallbackAuto: s.fallbackAuto ?? null,
    fallbackStickiness: s.fallbackStickiness ?? null,
    fallbackMaxLastResortCandidates: s.fallbackMaxLastResortCandidates ?? null,
    modelAvailabilitySchedule: s.modelAvailabilitySchedule ?? null,
  });
}

/**
 * Watch `configPath` for credential changes and invoke `onChange` with a
 * freshly-decrypted snapshot whenever the `providers`/`apiKey`/`baseUrl` slice
 * actually changes. Returns a `close()` that stops watching.
 *
 * The initial on-disk state is read once to seed the no-op guard but does NOT
 * fire `onChange` — only subsequent changes do.
 */
export function watchProviderConfig(
  configPath: string,
  vault: SecretVault,
  onChange: (snapshot: ProviderConfigSnapshot) => void,
  opts: WatchProviderConfigOptions = {},
): { close: () => void } {
  const debounceMs = opts.debounceMs ?? 200;
  const warn = opts.warn;
  const base = path.basename(configPath);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let readGeneration = 0;
  let lastSerialized: string | undefined;

  // Seed the guard with current on-disk content so the first *change* fires
  // rather than re-applying what we already have.
  void readProviderSnapshot(configPath, vault, warn).then((seed) => {
    if (!closed && seed && lastSerialized === undefined) {
      lastSerialized = serializeSnapshot(seed);
    }
  });

  let watcher: syncFs.FSWatcher;
  try {
    // Watch the directory (not the file) so atomic-rename events surface
    // reliably across platforms.
    watcher = syncFs.watch(path.dirname(configPath), { recursive: false });
  } catch (err) {
    warn?.(`Provider config watcher could not start: ${(err as Error).message}`);
    return { close: () => {} };
  }

  const trigger = (): void => {
    if (closed) return;
    const generation = ++readGeneration;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void readProviderSnapshot(configPath, vault, warn).then(
        (next) => {
          if (closed || generation !== readGeneration || !next) return;
          const serialized = serializeSnapshot(next);
          if (serialized === lastSerialized) return; // no-op / self-write
          lastSerialized = serialized;
          onChange(next);
        },
        () => {
          // readProviderSnapshot never rejects for routine I/O — guard only.
        },
      );
    }, debounceMs);
  };

  watcher.on('change', (eventType: string, filename: string | Buffer | null) => {
    const name = typeof filename === 'string' ? filename : '';
    // Windows reports a deleted watched directory as an endless 'rename' storm
    // of its own absolute path (never error/close). Stop instead of spinning.
    if (path.isAbsolute(name)) {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
      warn?.(`Provider config watcher stopped: ${path.dirname(configPath)} was removed`);
      return;
    }
    if (eventType === 'rename' || eventType === 'change') {
      if (!name || name === base) trigger();
    }
  });

  watcher.on('error', (err: Error) => {
    warn?.(`Provider config watcher error: ${err.message}`);
  });

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
