/**
 * Trust-on-first-use (TOFU) pinning for external plugins.
 *
 * In-process plugins run with full host privileges, so the only practical
 * supply-chain signal available before plugin code executes is "has this
 * plugin's entry file changed since the user first ran it?". On first load
 * the host records a SHA-256 of the resolved entry file in
 * `~/.wrongstack/plugin-trust.json`. Later loads compare hashes:
 *
 *   - match            → plugin loads silently
 *   - no pin yet       → pin is written now, plugin loads (first use)
 *   - hash mismatch    → plugin is REFUSED until the user re-pins it with
 *                        `wstack plugin trust <name>`
 *
 * The pin covers the entry file only (not the whole dependency tree) —
 * it catches swapped/updated plugin builds, not deep transitive changes.
 * It is a tamper signal, not a signature scheme.
 *
 * Disable entirely with `features.pluginsTrust: false` in config.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ERROR_CODES, FsError } from '../types/errors.js';

export interface PluginTrustEntry {
  /** Absolute entry file path that was hashed at pin time. */
  entry: string;
  /** `sha256-<hex>` of the entry file contents at pin time. */
  integrity: string;
  /** ISO timestamp of when the pin was written. */
  pinnedAt: string;
  /** Optional provenance — the config spec/path the plugin was loaded from. */
  spec?: string | undefined;
}

export interface PluginTrustStore {
  pinned: Record<string, PluginTrustEntry>;
}

export type PluginTrustVerification =
  | { status: 'unpinned'; integrity: string }
  | { status: 'trusted'; integrity: string }
  | { status: 'changed'; expected: string; actual: string; pinnedAt: string };

/** Default trust store location: `~/.wrongstack/plugin-trust.json`. */
export function defaultPluginTrustPath(globalRoot: string): string {
  return join(globalRoot, 'plugin-trust.json');
}

/**
 * Canonical pin-key form: forward slashes on every platform, so a plugin
 * pinned by discovery (forward-slash paths) and re-pinned from a config
 * entry (backslashes on Windows) addresses the same store key.
 */
export function normalizeTrustKey(path: string): string {
  return path.replaceAll('\\', '/');
}

export async function hashFileContents(
  entryPath: string,
  readFileFn: (path: string) => Promise<Buffer> = defaultReadFile,
): Promise<string> {
  const contents = await readFileFn(entryPath);
  return `sha256-${createHash('sha256').update(contents).digest('hex')}`;
}

async function defaultReadFile(path: string): Promise<Buffer> {
  return readFile(path);
}

/**
 * Read the trust store. A missing file is an empty store (first run).
 * A corrupt file is a hard error — silently ignoring it would downgrade
 * every existing pin to "unpinned" and re-trust changed code, which is
 * exactly the attack this file exists to catch.
 */
export async function readPluginTrustStore(
  storePath: string,
  readFileFn: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<PluginTrustStore> {
  let raw: string;
  try {
    raw = await readFileFn(storePath);
  } catch {
    return { pinned: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new FsError({
      message: `Plugin trust store "${storePath}" is not valid JSON — fix or delete the file before loading external plugins (${err instanceof Error ? err.message : String(err)})`,
      code: ERROR_CODES.FS_READ_FAILED,
      path: storePath,
    });
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new FsError({
      message: `Plugin trust store "${storePath}" has an unexpected shape (expected { pinned: {...} }) — fix or delete the file`,
      code: ERROR_CODES.FS_READ_FAILED,
      path: storePath,
    });
  }
  const pinned = (parsed as { pinned?: unknown }).pinned;
  if (pinned === undefined) return { pinned: {} };
  if (pinned === null || typeof pinned !== 'object' || Array.isArray(pinned)) {
    throw new FsError({
      message: `Plugin trust store "${storePath}" has an invalid "pinned" section — fix or delete the file`,
      code: ERROR_CODES.FS_READ_FAILED,
      path: storePath,
    });
  }
  return { pinned: pinned as Record<string, PluginTrustEntry> };
}

/**
 * Write the trust store atomically (temp file + rename, 0o600 — it is a
 * security-relevant record, same treatment as the profile config).
 */
export async function writePluginTrustStore(
  storePath: string,
  store: PluginTrustStore,
): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true });
  const tmp = `${storePath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, storePath);
}

/**
 * Pure verification: compare a freshly computed integrity hash against the
 * pinned entry. Keyed by plugin name; the pinned `entry` path is advisory
 * (an npm update can legitimately move the entry inside node_modules while
 * the content hash is what decides trust).
 */
export function verifyPluginTrust(
  name: string,
  integrity: string,
  store: PluginTrustStore,
): PluginTrustVerification {
  const pinned = store.pinned[name];
  if (!pinned) return { status: 'unpinned', integrity };
  if (pinned.integrity === integrity) return { status: 'trusted', integrity };
  return {
    status: 'changed',
    expected: pinned.integrity,
    actual: integrity,
    pinnedAt: pinned.pinnedAt,
  };
}

/** Insert or replace the pin for `name` and persist the store. */
export async function pinPluginTrust(
  storePath: string,
  name: string,
  entry: string,
  integrity: string,
  spec?: string,
): Promise<PluginTrustStore> {
  const store = await readPluginTrustStore(storePath);
  store.pinned[name] = { entry, integrity, pinnedAt: new Date().toISOString(), spec };
  await writePluginTrustStore(storePath, store);
  return store;
}

/** Remove the pin for `name` (if present) and persist the store. */
export async function unpinPluginTrust(
  storePath: string,
  name: string,
): Promise<PluginTrustStore> {
  const store = await readPluginTrustStore(storePath);
  if (store.pinned[name] !== undefined) {
    delete store.pinned[name];
    await writePluginTrustStore(storePath, store);
  }
  return store;
}
