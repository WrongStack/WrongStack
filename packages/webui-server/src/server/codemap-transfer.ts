import { randomUUID } from 'node:crypto';

/** Transport chunks, not partial graphs: callers publish only the reassembled snapshot. */
const CHUNK_BYTES = 512 * 1024;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_RETAINED_BYTES = 32 * 1024 * 1024;
const MAX_SNAPSHOTS = 8;
const SNAPSHOT_TTL_MS = 60_000;
interface Snapshot {
  scope: string;
  bytes: Buffer;
  expiresAt: number;
}
const snapshots = new Map<string, Snapshot>();
let retainedBytes = 0;

function remove(id: string): void {
  const snapshot = snapshots.get(id);
  if (snapshot) retainedBytes -= snapshot.bytes.length;
  snapshots.delete(id);
}

function sweep(): void {
  for (const [id, snapshot] of snapshots) {
    if (snapshot.expiresAt <= Date.now()) remove(id);
  }
}

export interface GraphTransferReply {
  status: number;
  body: string;
}
function failure(status: number, code: string, error: string): GraphTransferReply {
  return { status, body: JSON.stringify({ code, error }) };
}

function chunk(id: string, snapshot: Snapshot, offset: number): GraphTransferReply {
  const end = Math.min(offset + CHUNK_BYTES, snapshot.bytes.length);
  return {
    status: 200,
    body: JSON.stringify({
      transport: 'codemap-chunks-v1',
      snapshot: id,
      offset,
      nextOffset: end < snapshot.bytes.length ? end : null,
      totalBytes: snapshot.bytes.length,
      chunk: snapshot.bytes.subarray(offset, end).toString('base64'),
    }),
  };
}

/** A continuation reads the pinned snapshot, even if the index is refreshing now. */
export function continueGraphTransfer(
  scope: string,
  query?: URLSearchParams,
): GraphTransferReply | undefined {
  if (query?.get('transfer') !== 'chunks') return undefined;
  sweep();
  const id = query.get('snapshot');
  const rawOffset = query.get('offset');
  if (!id && rawOffset === null) return undefined;
  if (!id || !rawOffset || !/^\d+$/.test(rawOffset)) {
    return failure(400, 'CODEMAP_INVALID_OFFSET', 'Invalid CodeMap transfer offset');
  }
  const snapshot = snapshots.get(id);
  if (!snapshot || snapshot.scope !== scope) {
    return failure(409, 'CODEMAP_SNAPSHOT_EXPIRED', 'CodeMap transfer expired — reload the map.');
  }
  const offset = Number(rawOffset);
  if (
    !Number.isSafeInteger(offset) ||
    offset % CHUNK_BYTES !== 0 ||
    offset >= snapshot.bytes.length
  ) {
    return failure(400, 'CODEMAP_INVALID_OFFSET', 'Invalid CodeMap transfer offset');
  }
  return chunk(id, snapshot, offset);
}

/** Opt-in preserves the unmodified JSON contract for existing API consumers. */
export function startGraphTransfer(
  scope: string,
  body: string,
  query?: URLSearchParams,
): GraphTransferReply {
  if (query?.get('transfer') !== 'chunks' || Buffer.byteLength(body) <= CHUNK_BYTES) {
    return { status: 200, body };
  }
  if (Buffer.byteLength(body) > MAX_SNAPSHOT_BYTES) {
    return failure(
      413,
      'CODEMAP_GRAPH_TOO_LARGE',
      'CodeMap graph exceeds the 16 MiB transfer budget — open a narrower package or file scope.',
    );
  }
  sweep();
  const bytes = Buffer.from(body, 'utf8');
  while (snapshots.size >= MAX_SNAPSHOTS || retainedBytes + bytes.length > MAX_RETAINED_BYTES) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    remove(oldest);
  }
  const id = randomUUID();
  const snapshot = { scope, bytes, expiresAt: Date.now() + SNAPSHOT_TTL_MS };
  snapshots.set(id, snapshot);
  retainedBytes += bytes.length;
  return chunk(id, snapshot, 0);
}
