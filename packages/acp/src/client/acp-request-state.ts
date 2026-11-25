import { ACPSessionError } from './acp-session-errors.js';

export interface PendingRequest {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timeoutMs: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
  /** Set on a request timed by inactivity: restarts its clock. */
  rearm?: (() => void) | undefined;
}

/** The agent was heard from: restart the clock of every inactivity-timed request. */
export function touchIdleRequests(pending: Map<string | number, PendingRequest>): void {
  for (const p of pending.values()) p.rearm?.();
}

export type State =
  | 'init'
  | 'ready'
  | 'authenticated'
  | 'sessioning'
  | 'prompting'
  | 'done'
  | 'closed';

/**
 * Fail and forget every in-flight request. Without a `reason` the session was
 * closed locally; with one, the agent connection ended (the process exited,
 * the socket closed), so no reply can arrive and waiting out each request's
 * timeout would only stall the caller.
 */
export function rejectPendingRequests(
  pending: Map<string | number, PendingRequest>,
  reason?: string,
): void {
  const entries = [...pending.values()];
  pending.clear();
  for (const p of entries) {
    clearTimeout(p.timeoutHandle);
    const message =
      reason === undefined
        ? 'session was closed'
        : `agent connection closed (${reason}) during ${p.method}`;
    p.reject(new ACPSessionError('closed', message));
  }
}
