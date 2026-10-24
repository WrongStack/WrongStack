import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { deriveHqProjectId } from '@wrongstack/hq';

/**
 * Why this is not just `string | undefined`.
 *
 * Resolution walks `ProjectSessionRegistry.list()`, which probes each known
 * project's session-catalog daemon with `callExisting` — a path that must never
 * spawn — and turns EVERY per-project failure into an empty result: metadata not
 * yet written, the daemon gone, the IPC connect refused, a timeout. The gateway
 * then reported that as `404 Unknown project`, which is indistinguishable from
 * "this project does not exist".
 *
 * That conflation is observable: a session lease lives 30s and is renewed every
 * 5s, so under heavy load a live project's daemon can lapse and exit, and a
 * perfectly real project answers 404 for a moment. The caller cannot tell a
 * permanent negative from a blip, so it cannot know whether retrying is
 * sensible.
 *
 * The on-disk project directory is the discriminator: it is created when the
 * project first gets a daemon and it outlives that daemon (only the metadata
 * file is removed on exit). A directory therefore means "this machine knows
 * this project, it just is not answering right now" — transient. No directory
 * means genuinely unknown.
 */
export type HqProjectResolution =
  | { status: 'found'; projectRoot: string }
  /** No such project on this machine. A retry will not help. */
  | { status: 'unknown' }
  /** The project is known but could not be resolved right now; retry may help. */
  | { status: 'unavailable' };

/** Reject anything that could escape `<globalRoot>/projects/` before joining it. */
function isPlainSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !path.isAbsolute(value)
  );
}

async function projectDirectoryExists(globalRoot: string, projectId: string): Promise<boolean> {
  if (!isPlainSegment(projectId)) return false;
  try {
    return (await fsp.stat(path.join(globalRoot, 'projects', projectId))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * One structured line per 503, so the next occurrence names its mechanism
 * instead of collapsing four swallowing layers into "unreachable":
 * `registry-error` (the registry itself threw) vs `probe-failed
 * <slug>/<phase>/<code>...` (per-project probe failures: metadata-missing vs
 * call-existing failure) vs `no-live-lease` (every probe answered fine, the
 * catalog just reported no matching live lease).
 */
function warnProjectUnavailable(projectId: string, reason: string): void {
  process.stderr.write(
    `${JSON.stringify({ level: 'warn', event: 'hq.project_unavailable', projectId, reason })}\n`,
  );
}

export function resolveHqProjectRoot(
  globalRoot: string,
  ids: { sessionId?: string | undefined; projectId?: string | undefined },
): Promise<HqProjectResolution> {
  // Dynamic import to avoid pulling in SessionRegistry at module level.
  const fn = async (): Promise<HqProjectResolution> => {
    const { getSessionRegistry } = await import('@wrongstack/core/storage');
    try {
      const registry = getSessionRegistry(globalRoot);
      if (typeof ids.sessionId === 'string') {
        const entry = await registry.get(ids.sessionId).catch(() => null);
        if (entry?.projectRoot) return { status: 'found', projectRoot: entry.projectRoot };
      }
      if (typeof ids.projectId === 'string') {
        const { createHash } = await import('node:crypto');
        const probeFailures: string[] = [];
        const all = await registry
          .list({
            onProjectFailure: (slug, phase, error) => {
              const code = (error as NodeJS.ErrnoException | null)?.code ?? 'error';
              probeFailures.push(`${slug}/${phase}/${code}`);
            },
          })
          .catch(() => []);
        const projectIds = new Map<string, string>();
        const projectIdForRoot = (projectRoot: string): string => {
          const cached = projectIds.get(projectRoot);
          if (cached !== undefined) return cached;
          const derived = deriveHqProjectId(projectRoot);
          projectIds.set(projectRoot, derived);
          return derived;
        };
        const match = all.find(
          (e: { projectSlug?: string; projectRoot: string }) =>
            e.projectSlug === ids.projectId ||
            projectIdForRoot(e.projectRoot) === ids.projectId ||
            createHash('sha256').update(e.projectRoot).digest('hex').slice(0, 12) === ids.projectId,
        );
        if (match) return { status: 'found', projectRoot: match.projectRoot };
        // Only a slug-shaped id names a directory. A hashed id cannot be checked
        // this way, so it keeps the old, definitive answer rather than guessing.
        if (await projectDirectoryExists(globalRoot, ids.projectId)) {
          warnProjectUnavailable(
            ids.projectId,
            probeFailures.length > 0 ? `probe-failed ${probeFailures.join(',')}` : 'no-live-lease',
          );
          return { status: 'unavailable' };
        }
      }
    } catch {
      // The registry itself failed — we did not learn that the project is
      // absent, only that we could not look. Saying "unknown" here would be the
      // same lie in a different place.
      warnProjectUnavailable(String(ids.projectId ?? ids.sessionId ?? '?'), 'registry-error');
      return { status: 'unavailable' };
    }
    return { status: 'unknown' };
  };
  return fn();
}
