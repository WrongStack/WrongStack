import * as fs from 'node:fs/promises';
import os from 'node:os';
import * as path from 'node:path';
import { ERROR_CODES, FsError } from '@wrongstack/contracts/types';
import { isSecretField } from '@wrongstack/core/security';
import { resolveWstackPaths } from '@wrongstack/core/utils';

// ── UID ownership ──────────────────────────────────────────────────────────

type UidFn = () => string | number | undefined;

export const defaultUidFn: UidFn = () => os.userInfo().uid;

async function getFileUid(filePath: string): Promise<string | number | undefined> {
  try {
    const stat = await fs.stat(filePath);
    return stat.uid;
  } catch {
    return undefined;
  }
}

/**
 * Verify the calling process owns config.json before allowing a write operation.
 * Guards against one user on a shared multi-user system overwriting another's config.
 *
 * On Windows, .uid is always undefined on the UserInfo object, and the NT ACL
 * model already restricts writes — so we skip the check on win32.
 * On Unix, we compare the process euid against the file's uid.
 * If config.json doesn't exist yet, we allow the write (first-time setup).
 */
export async function checkConfigOwnership(
  homeFn: HomeDirFn,
  uidFn: UidFn = defaultUidFn,
  targetConfigPath?: string,
): Promise<boolean> {
  if (os.platform() === 'win32') return true; // ACLs handle this on Windows

  const cfg = configPath(homeFn, targetConfigPath);
  const fileUid = await getFileUid(cfg);
  if (fileUid === undefined) return true; // file doesn't exist yet — allow

  const callerUid = uidFn();
  if (callerUid === undefined) return true; // can't determine — allow, don't block

  return fileUid === callerUid;
}

// ── Protected files/directories ────────────────────────────────────
// These are NEVER touched by any operation in this module.
// Guards against bugs (glob patterns, typos, race conditions)
// accidentally deleting critical user data.
const PROTECTED_BASENAMES = new Set(['config.json', '.key', 'index.json']);

// Top-level directories that should never be deleted even if a prune
// pattern accidentally widens. These are absolute directory names
// relative to the .wrongstack root.

/**
 * Guard: throw if `filename` is a protected file or lives inside a protected
 * directory. Used before any unlink / rm call to make accidentally deleting
 * critical files impossible.
 */
export function assertSafeToDelete(filename: string, parentDir: string): void {
  // 1. Exact-match protected files
  if (PROTECTED_BASENAMES.has(filename)) {
    throw new FsError({
      message: `Refusing to delete protected file: ${filename}`,
      code: ERROR_CODES.FS_DELETE_FAILED,
      path: path.join(parentDir, filename),
      context: { reason: 'protected_basename' },
    });
  }
  // 2. No path traversal
  if (filename !== path.basename(filename)) {
    throw new FsError({
      message: `Refusing to delete path with traversal: ${filename}`,
      code: ERROR_CODES.FS_DELETE_FAILED,
      path: filename,
      context: { reason: 'path_traversal' },
    });
  }
  // 3. Validate it's a timestamped config backup (config.json.{ts}.bak)
  //    before we ever consider deleting it.
  if (!filename.startsWith('config.json.') || !filename.endsWith('.bak')) {
    // Unknown files — be conservative, refuse
    throw new FsError({
      message: `Refusing to delete unknown file: ${filename}`,
      code: ERROR_CODES.FS_DELETE_FAILED,
      path: path.join(parentDir, filename),
      context: { reason: 'unknown_file_pattern' },
    });
  }
  // 4. Check parent is the .wrongstack root and the target is not a dir
  const resolvedParent = path.resolve(parentDir);
  const parentOfProfile = path.dirname(resolvedParent);
  const isGlobalRoot = path.basename(resolvedParent) === '.wrongstack';
  const isProfileDir =
    path.basename(parentOfProfile) === 'profiles' &&
    path.basename(path.dirname(parentOfProfile)) === '.wrongstack';
  if (!isGlobalRoot && !isProfileDir) {
    throw new FsError({
      message: `Unexpected parent directory for bak prune: ${resolvedParent}`,
      code: ERROR_CODES.FS_DELETE_FAILED,
      path: resolvedParent,
      context: { reason: 'invalid_parent' },
    });
  }
}

/** Placeholder written in place of every secret value in a history snapshot. */
const REDACTED = '[REDACTED]';

/**
 * Recurse into a value for masking. Arrays are walked too: a provider's saved
 * credentials live in `providers.<id>.apiKeys[]`, so skipping arrays wrote the
 * real `apiKey` of every saved key into `history/<id>.json` in cleartext —
 * masking the scalar spelling while the array spelling went through untouched.
 */
function maskValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskValue);
  if (typeof v === 'object' && v !== null) return maskConfigSecrets(v as Record<string, unknown>);
  return v;
}

export function maskConfigSecrets(cfg: Record<string, unknown>): Record<string, unknown> {
  if (typeof cfg !== 'object' || cfg === null) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    // `apiKeys` is a secret-named CONTAINER. Keep its non-secret identity
    // fields (label/id/order) so restore can match credentials by stable key,
    // while each nested scalar `apiKey` is still redacted below.
    if (
      k.toLowerCase() === 'apikeys' &&
      Array.isArray(v) &&
      v.every(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          !Array.isArray(entry) &&
          ('label' in entry || 'id' in entry) &&
          'apiKey' in entry,
      )
    ) {
      out[k] = maskValue(v);
    } else if (isSecretField(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = maskValue(v);
    }
  }
  return out;
}

/**
 * Rebuild a writable config from a masked history snapshot.
 *
 * History deliberately never stores secrets, so a snapshot cannot restore them
 * — but writing it back verbatim replaced every live credential with the
 * literal `"[REDACTED]"`, which the next boot reads as a plaintext key and
 * every request 401s. Instead: take the structure from the snapshot and carry
 * each masked value over from the config that is on disk right now. When the
 * current config has no value at that path the key is dropped rather than
 * materialising the placeholder.
 */
export function reviveSecrets(masked: unknown, current: unknown): unknown {
  if (masked === REDACTED) return current;
  if (Array.isArray(masked)) {
    const cur = Array.isArray(current) ? current : [];
    return masked.map((item, i) => {
      const record =
        item && typeof item === 'object' && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : undefined;
      const identityKey =
        typeof record?.['label'] === 'string'
          ? 'label'
          : typeof record?.['id'] === 'string'
            ? 'id'
            : undefined;
      const matched = identityKey
        ? cur.find(
            (candidate) =>
              candidate &&
              typeof candidate === 'object' &&
              !Array.isArray(candidate) &&
              (candidate as Record<string, unknown>)[identityKey] === record?.[identityKey],
          )
        : cur[i];
      return reviveSecrets(item, matched);
    });
  }
  if (typeof masked !== 'object' || masked === null) return masked;

  const curObj =
    typeof current === 'object' && current !== null && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(masked as Record<string, unknown>)) {
    const revived = reviveSecrets(v, curObj[k]);
    // A secret with no counterpart in the live config: omit it entirely.
    if (revived === undefined) continue;
    out[k] = revived;
  }
  return out;
}

export type HomeDirFn = () => string;

export const defaultHomeDir: HomeDirFn = () => os.homedir();

function activeProfileConfigPath(homeFn: HomeDirFn): string {
  const paths =
    homeFn === defaultHomeDir
      ? resolveWstackPaths({ projectRoot: process.cwd() })
      : resolveWstackPaths({ projectRoot: process.cwd(), userHome: homeFn() });
  return paths.profileConfig(paths.profileName);
}

export function configPath(homeFn: HomeDirFn = defaultHomeDir, targetConfigPath?: string): string {
  return targetConfigPath ?? activeProfileConfigPath(homeFn);
}
