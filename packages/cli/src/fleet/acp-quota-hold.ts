/**
 * Hold an external agent whose usage quota is spent.
 *
 * Each delegation to a spent agent still started it, waited ~20s for the
 * provider to refuse, and failed — once per retry, per parallel delegate.
 * After one `provider_quota` failure the agent is held until its reset (or
 * a default window); delegations in between fail at once with the same
 * classified error, so the leader routes the work elsewhere.
 */
import type { SubagentError } from '@wrongstack/contracts/types';

/** Without a reset time from the agent, hold it this long. */
const DEFAULT_HOLD_MS = 15 * 60_000;

const holds = new Map<string, { until: number; error: SubagentError }>();

function isQuotaError(err: unknown): err is SubagentError {
  return !!err && typeof err === 'object' && (err as { kind?: unknown }).kind === 'provider_quota';
}

/** Run `start` unless `agentId` is held; record a hold when it fails on quota. */
export async function runWithQuotaHold<T>(
  agentId: string,
  start: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const hold = holds.get(agentId);
  if (hold) {
    const left = hold.until - now();
    if (left > 0) {
      const at = new Date(hold.until).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      throw {
        ...hold.error,
        message: `${hold.error.message} — not started: ${agentId} is held until ${at}`,
        backoffMs: left,
      } satisfies SubagentError;
    }
    holds.delete(agentId);
  }
  try {
    return await start();
  } catch (err) {
    if (isQuotaError(err)) {
      holds.set(agentId, { until: now() + (err.backoffMs ?? DEFAULT_HOLD_MS), error: err });
    }
    throw err;
  }
}
