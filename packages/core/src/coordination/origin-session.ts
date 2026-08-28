/**
 * `callerSessionId` — which conversation is asking?
 *
 * Spawning tools run inside the caller's `Context`, and the answer they need
 * is the run-pinned session: with several tabs sharing one process, the host's
 * own writer names the session it booted with, not the one that just called
 * `delegate`. The pinned id is set for the whole run (see `Agent.run`), so it
 * survives a tab switch mid-run — which the live reading does not.
 *
 * The parameter is typed loosely on purpose: tool `execute` receives an opaque
 * context, and a few hosts pass partial stand-ins.
 *
 * @module origin-session
 */

export function callerSessionId(ctx: unknown, fallback?: string): string | undefined {
  const c = ctx as
    | { session?: { id?: string } | undefined; activeRunSessionId?: string | undefined }
    | undefined;
  const pinned = c?.activeRunSessionId;
  if (typeof pinned === 'string' && pinned.length > 0) return pinned;
  const live = c?.session?.id;
  if (typeof live === 'string' && live.length > 0) return live;
  return fallback;
}
