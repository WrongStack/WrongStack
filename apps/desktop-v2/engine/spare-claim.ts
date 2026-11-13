import { readFile, rm } from 'node:fs/promises';

/**
 * What a session host asks of a spare engine when it hands the engine to a conversation:
 * a new conversation (no source), or a recorded one to resume, optionally as a fork. `stop`
 * means the host no longer wants the spare (another project took the one slot, or the engine
 * build changed): it stops gracefully, as when its maximum age runs out.
 */
export type SpareClaim = { resume?: string | undefined; fork: boolean; stop?: true };

/** A claim file's content, or null when it is not one (yet). */
export function parseSpareClaim(text: string): SpareClaim | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row['stop'] === true) return { fork: false, stop: true };
  const resume = typeof row['resume'] === 'string' ? row['resume'].trim() : undefined;
  if (row['resume'] !== undefined && row['resume'] !== null && !resume) return null;
  return { ...(resume ? { resume } : {}), fork: row['fork'] === true };
}

/** How long a spare waits for its claim when the host names no limit. */
const DEFAULT_SPARE_MAX_AGE_MS = 20 * 60 * 1000;

/** The host's `WRONGSTACK_DESKTOP_SPARE_MAX_AGE_MS`, or the default when absent or invalid. */
export function spareMaxAge(value: string | undefined): number {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_SPARE_MAX_AGE_MS;
}

/**
 * Waits until the host writes the claim file, then removes it and returns the claim. A spare
 * engine has booted every service already; the conversation it becomes starts at once instead
 * of behind a whole engine boot. The host writes the file atomically (temp + rename).
 *
 * Returns null when no claim arrived within `maxWaitMs`: the spare then stops, so an unused
 * engine does not hold its memory (or stale boot-time state) forever, even when the host that
 * started it is gone.
 */
export async function waitForSpareClaim(
  path: string,
  {
    pollMs = 100,
    maxWaitMs = DEFAULT_SPARE_MAX_AGE_MS,
    now = () => Date.now(),
    read = (p: string) => readFile(p, 'utf8'),
  } = {},
): Promise<SpareClaim | null> {
  const deadline = now() + maxWaitMs;
  for (;;) {
    const text = await read(path).catch(() => null);
    const claim = text === null ? null : parseSpareClaim(text);
    if (claim) {
      await rm(path, { force: true }).catch(() => undefined);
      return claim;
    }
    if (now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
