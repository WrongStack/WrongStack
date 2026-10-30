/** One finished delegation to a worker agent, as the engine reported it. */
export interface DelegationRecord {
  id: string;
  target: string;
  task: string;
  ok: boolean;
  status: string;
  summary: string;
  durationMs: number;
  iterations: number;
  toolCalls: number;
  /** Engine estimate in USD; null when the engine did not know the worker's price. */
  costUsd: number | null;
}

/** Delegations kept per conversation, newest last. */
export const DELEGATION_LIMIT = 50;
const TEXT_LIMIT = 500;

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/** A `delegate.completed` payload as a record; null when it is not one. */
export function delegationRecord(
  payload: Record<string, unknown>,
  fallbackId: string,
): DelegationRecord | null {
  if (typeof payload['target'] !== 'string' || typeof payload['ok'] !== 'boolean') return null;
  const id =
    typeof payload['delegationId'] === 'string'
      ? payload['delegationId']
      : typeof payload['subagentId'] === 'string'
        ? `${payload['subagentId']}:${fallbackId}`
        : fallbackId;
  return {
    id,
    target: payload['target'],
    task: String(payload['task'] ?? '').slice(0, TEXT_LIMIT),
    ok: payload['ok'],
    status: typeof payload['status'] === 'string' ? payload['status'] : '',
    summary: String(payload['summary'] ?? '').slice(0, TEXT_LIMIT),
    durationMs: count(payload['durationMs']),
    iterations: count(payload['iterations']),
    toolCalls: count(payload['toolCalls']),
    costUsd:
      typeof payload['costUsd'] === 'number' && Number.isFinite(payload['costUsd'])
        ? payload['costUsd']
        : null,
  };
}

/** Appends a delegation once per id, keeping the newest `DELEGATION_LIMIT`. */
export function appendDelegation(records: DelegationRecord[], record: DelegationRecord) {
  if (records.some((item) => item.id === record.id)) return records;
  return [...records, record].slice(-DELEGATION_LIMIT);
}

/** Totals over the kept delegations; cost sums only the delegations with a known estimate. */
export function delegationTotals(records: readonly DelegationRecord[]) {
  const priced = records.filter((item) => item.costUsd !== null);
  return {
    count: records.length,
    failed: records.filter((item) => !item.ok).length,
    toolCalls: records.reduce((sum, item) => sum + item.toolCalls, 0),
    durationMs: records.reduce((sum, item) => sum + item.durationMs, 0),
    costUsd: priced.length ? priced.reduce((sum, item) => sum + (item.costUsd ?? 0), 0) : null,
    unpriced: records.length - priced.length,
  };
}
