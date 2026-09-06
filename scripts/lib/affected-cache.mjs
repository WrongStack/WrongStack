/**
 * Shared state for the affected-test cache: where it lives, how paths are
 * normalised, and how file content is fingerprinted.
 *
 * Both halves of the feature import this — the reporter that writes the cache
 * (`scripts/vitest-affected-recorder.mjs`) and the runner that reads it
 * (`scripts/test-affected.mjs`) — so the two can never disagree about the
 * shape of what they are exchanging.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CACHE_PATH = path.join(REPO_ROOT, 'node_modules', '.cache', 'wrongstack-affected.json');

/**
 * Repo-relative, forward-slashed path, or null when the file is outside the
 * repo. Windows hands back `D:\...` while the cache has to stay comparable
 * across shells, so normalising here is not cosmetic.
 */
export function toRepoPath(absolute) {
  const rel = path.relative(REPO_ROOT, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** Content fingerprint, or null when the file is unreadable or gone. */
export function hashFile(repoPath) {
  try {
    return createHash('sha256')
      .update(readFileSync(path.join(REPO_ROOT, repoPath)))
      .digest('hex')
      .slice(0, 16);
  } catch {
    return null;
  }
}

/** Read the cache, tolerating every way it can be absent or corrupt. */
export function readCache() {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    if (parsed?.schemaVersion !== 1) return emptyCache();
    return {
      salt: typeof parsed.salt === 'string' ? parsed.salt : '',
      entries: parsed.entries ?? {},
      hashes: parsed.hashes ?? {},
    };
  } catch {
    return emptyCache();
  }
}

function emptyCache() {
  return { salt: '', entries: {}, hashes: {} };
}
