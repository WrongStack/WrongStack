/**
 * Status -> tone mapping, shared by every surface that paints a dot, pill or
 * badge. One table means the Console, the Fleet Map and the nav can never
 * disagree about what "waiting_user" looks like.
 */
/**
 * Semantic tones. `running` is deliberately distinct from `active`: `active`
 * means healthy/complete (green), `running` means work in flight right now
 * (the brand signal). Collapsing them loses the difference between "this
 * finished" and "this is moving".
 */
export type HqTone = 'active' | 'running' | 'info' | 'warn' | 'error' | 'idle';

/** Lifecycle of a dispatched remote command. */
export function commandLifecycleTone(lifecycle: string): 'active' | 'error' | 'info' | 'warn' {
  if (lifecycle === 'completed') return 'active';
  if (lifecycle === 'failed' || lifecycle === 'rejected') return 'error';
  if (lifecycle === 'delivered' || lifecycle === 'accepted') return 'info';
  return 'warn';
}

/** Liveness of a session, client or agent. */
export function activityTone(status: string | undefined): HqTone {
  if (status === 'active' || status === 'running' || status === 'streaming') return 'active';
  if (status === 'waiting_user') return 'warn';
  if (status === 'error' || status === 'stale' || status === 'closing') return 'error';
  return 'idle';
}

/** A row in the command audit rail: queued -> delivered -> acked, or failed. */
export function commandAuditTone(entry: {
  status?: string | undefined;
  ackStatus?: string | undefined;
}): HqTone {
  if (entry.ackStatus === 'failed' || entry.ackStatus === 'rejected') return 'error';
  if (entry.status === 'acked') return 'active';
  if (entry.status === 'delivered') return 'info';
  if (entry.status === 'queued') return 'warn';
  return 'idle';
}

export function commandAckTone(ackStatus: string): 'active' | 'error' | 'info' {
  if (ackStatus === 'failed' || ackStatus === 'rejected') return 'error';
  if (ackStatus === 'completed') return 'active';
  return 'info';
}
