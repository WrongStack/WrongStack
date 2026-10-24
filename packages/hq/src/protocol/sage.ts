/** Project memory replication. User/session memories never cross this boundary. */
export interface HqSageRecord {
  id: string;
  revision: number;
  changeId: string;
  memory: Record<string, unknown> | null;
}

export interface HqSageSnapshotPayload {
  projectId: string;
  records: HqSageRecord[];
}

export interface HqServerSageSnapshotMessage {
  type: 'hq.sage_snapshot';
  payload: HqSageSnapshotPayload;
}

export const MAX_HQ_SAGE_RECORD_BYTES = 256 * 1024;
export const MAX_HQ_SAGE_PAYLOAD_BYTES = 512 * 1024;

export function isHqSageRecord(value: unknown): value is HqSageRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as HqSageRecord;
  if (
    typeof r.id !== 'string' ||
    !r.id ||
    r.id.length > 256 ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 1 ||
    typeof r.changeId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(r.changeId)
  )
    return false;
  if (
    JSON.stringify(r).length > MAX_HQ_SAGE_RECORD_BYTES ||
    Buffer.byteLength(JSON.stringify(r)) > MAX_HQ_SAGE_RECORD_BYTES
  )
    return false;
  const m = r.memory;
  if (m === null) return true;
  if (
    !m ||
    typeof m !== 'object' ||
    Array.isArray(m) ||
    m.id !== r.id ||
    !['project', 'file', 'symbol'].includes(String(m.scope))
  )
    return false;
  return (
    ['text', 'kind', 'status', 'createdAt', 'updatedAt'].every((k) => typeof m[k] === 'string') &&
    ['importance', 'confidence', 'freshness'].every(
      (k) => typeof m[k] === 'number' && Number.isFinite(m[k]),
    ) &&
    Array.isArray(m.tags) &&
    m.tags.every((t) => typeof t === 'string') &&
    Array.isArray(m.anchors) &&
    m.anchors.every((a) => a && typeof a === 'object' && typeof a.type === 'string') &&
    Array.isArray(m.sources) &&
    m.sources.every((s) => s && typeof s === 'object' && typeof s.type === 'string')
  );
}

export function isHqSageSnapshotPayload(value: unknown): value is HqSageSnapshotPayload {
  if (!value || typeof value !== 'object') return false;
  const p = value as HqSageSnapshotPayload;
  return (
    typeof p.projectId === 'string' &&
    p.projectId.length > 0 &&
    p.projectId.length <= 256 &&
    Array.isArray(p.records) &&
    p.records.length <= 100 &&
    p.records.every(isHqSageRecord) &&
    Buffer.byteLength(JSON.stringify(p)) <= MAX_HQ_SAGE_PAYLOAD_BYTES
  );
}

/** Logical revision; deletes win ties, then a stable change nonce resolves offline forks. */
export function compareHqSageRecords(a: HqSageRecord, b: HqSageRecord): number {
  return (
    a.revision - b.revision ||
    Number(a.memory === null || a.memory.status === 'deleted') -
      Number(b.memory === null || b.memory.status === 'deleted') ||
    (a.changeId < b.changeId ? -1 : a.changeId > b.changeId ? 1 : 0)
  );
}

export function* chunkHqSageRecords(
  projectId: string,
  records: Iterable<HqSageRecord>,
): Generator<HqSageSnapshotPayload> {
  let batch: HqSageRecord[] = [];
  let bytes = Buffer.byteLength(JSON.stringify({ projectId, records: [] }));
  for (const record of records) {
    if (!isHqSageRecord(record)) throw new Error('Invalid or oversized SAGE sync record');
    const size = Buffer.byteLength(JSON.stringify(record)) + 1;
    if (batch.length && (batch.length >= 100 || bytes + size > MAX_HQ_SAGE_PAYLOAD_BYTES)) {
      yield { projectId, records: batch };
      batch = [];
      bytes = Buffer.byteLength(JSON.stringify({ projectId, records: [] }));
    }
    batch.push(record);
    bytes += size;
  }
  if (batch.length) yield { projectId, records: batch };
}
