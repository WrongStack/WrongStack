import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveWstackPaths, updateJsonObjectFile } from '@wrongstack/core/utils';
import { parsePrivateOriginAllowlist } from './security.js';

/**
 * One live array per project. Browser managers and the network proxy keep a
 * reference to it, so a refresh rewrites it in place instead of replacing it.
 * `stamp` is the policy file's mtime+size when it was last read: another
 * process (the TUI next to a WebUI host) may save an allowance, and an
 * in-memory copy that never re-read the file kept refusing it.
 */
const liveOrigins = new Map<string, { origins: string[]; stamp: string }>();
/**
 * Origins allowed only while one tool call runs (a loopback server the tool
 * itself started). Kept apart from the stored set so a policy refresh during
 * the call cannot drop them and nothing is ever written to the policy file.
 */
const transientOrigins = new Map<string, Map<string, number>>();
function policyPath(root: string): string {
  return join(resolveWstackPaths({ projectRoot: resolve(root) }).projectDir, 'browser-policy.json');
}

function policyStamp(path: string): string {
  const envRaw = process.env['WRONGSTACK_BROWSER_PRIVATE_ORIGINS'] ?? '';
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}|${envRaw}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `missing|${envRaw}`;
    throw error;
  }
}

function readStoredOrigins(path: string): string[] {
  let saved: unknown = {};
  try {
    saved = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved))
    throw new Error('browser: invalid browser-policy.json');
  const stored = (saved as { privateOrigins?: unknown }).privateOrigins ?? [];
  if (!Array.isArray(stored) || stored.some((entry) => typeof entry !== 'string')) {
    throw new Error('browser: invalid privateOrigins in browser-policy.json');
  }
  return parsePrivateOriginAllowlist(stored.join(','));
}

function replaceOrigins(target: string[], stored: readonly string[], key: string): void {
  target.splice(
    0,
    target.length,
    ...new Set([
      ...parsePrivateOriginAllowlist(process.env['WRONGSTACK_BROWSER_PRIVATE_ORIGINS']),
      ...stored,
      ...[...(transientOrigins.get(key)?.keys() ?? [])],
    ]),
  );
}

export function browserPrivateOrigins(root: string): string[] {
  const key = resolve(root);
  const path = policyPath(key);
  const stamp = policyStamp(path);
  let live = liveOrigins.get(key);
  if (live?.stamp === stamp) return live.origins;
  const stored = readStoredOrigins(path);
  if (!live) {
    live = { origins: [], stamp };
    liveOrigins.set(key, live);
  }
  replaceOrigins(live.origins, stored, key);
  live.stamp = stamp;
  return live.origins;
}

/** Explicit operator choice, scoped to one project and one exact origin. */
export async function setBrowserPrivateOrigin(
  root: string,
  raw: string,
  allow: boolean,
): Promise<string[]> {
  const [origin] = parsePrivateOriginAllowlist(raw);
  if (!origin || parsePrivateOriginAllowlist(raw).length !== 1)
    throw new Error(
      'Expected one HTTP(S) origin, for example http://localhost:3000, or "loopback" for every local port',
    );
  const current = browserPrivateOrigins(root);
  let saved: string[] = [];
  await updateJsonObjectFile(policyPath(root), (config) => {
    const previous = config.privateOrigins ?? [];
    if (!Array.isArray(previous) || previous.some((entry) => typeof entry !== 'string'))
      throw new Error('browser: invalid privateOrigins in browser-policy.json');
    const origins = new Set(parsePrivateOriginAllowlist(previous.join(',')));
    if (allow) origins.add(origin);
    else origins.delete(origin);
    saved = [...origins];
    config.privateOrigins = saved;
  });
  replaceOrigins(current, saved, resolve(root));
  const live = liveOrigins.get(resolve(root));
  if (live) live.stamp = policyStamp(policyPath(root));
  return [...current];
}

/**
 * Allow one exact origin for the duration of `fn` — for a loopback server the
 * calling tool started and stops itself. Never persisted; removed on return.
 */
export async function withTransientPrivateOrigin<T>(
  root: string,
  origin: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(root);
  const counts = transientOrigins.get(key) ?? new Map<string, number>();
  transientOrigins.set(key, counts);
  counts.set(origin, (counts.get(origin) ?? 0) + 1);
  const live = browserPrivateOrigins(key);
  const added = !live.includes(origin);
  if (added) live.push(origin);
  try {
    return await fn();
  } finally {
    const remaining = (counts.get(origin) ?? 0) - 1;
    if (remaining > 0) {
      counts.set(origin, remaining);
    } else {
      counts.delete(origin);
      if (counts.size === 0) transientOrigins.delete(key);
      // Re-derive the live array so persistently allowed origins (policy file,
      // env var) and any other in-flight transient origins survive this cleanup.
      try {
        replaceOrigins(live, readStoredOrigins(policyPath(key)), key);
      } catch {
        // If the policy file became unreadable mid-cleanup, fall back to a
        // targeted splice of exactly what this call added.
        if (added) {
          const index = live.indexOf(origin);
          if (index >= 0) live.splice(index, 1);
        }
      }
    }
  }
}
