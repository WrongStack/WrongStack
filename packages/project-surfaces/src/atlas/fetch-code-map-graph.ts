import { surfaceFetch } from '../host';
import type { CodeMapGraphResponse } from './codemap-model';

const MAX_GRAPH_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 512 * 1024;
const INVALID_TRANSFER = 'Invalid CodeMap transfer — reload the map.';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
function graph(value: unknown): value is CodeMapGraphResponse {
  return record(value) && Array.isArray(value.nodes) && Array.isArray(value.edges);
}

/** Every engine/IPC response stays small; no partial graph enters the UI/cache. */
export async function fetchCodeMapGraph(
  resource: string,
  unavailable: string,
  signal?: AbortSignal,
  cancelled: () => boolean = () => false,
): Promise<CodeMapGraphResponse> {
  // An evicted/expired snapshot gets one clean restart, never mixed generations.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const url = new URL(resource, 'http://codemap.local');
    url.searchParams.set('transfer', 'chunks');
    let offset = 0;
    let snapshot: string | undefined;
    let bytes: Uint8Array | undefined;
    for (let page = 0; page < MAX_GRAPH_BYTES / CHUNK_BYTES; page += 1) {
      signal?.throwIfAborted();
      if (cancelled()) throw new DOMException('CodeMap load superseded', 'AbortError');
      const response = await surfaceFetch(`${url.pathname}${url.search}`, {
        signal: signal ?? null,
      });
      signal?.throwIfAborted();
      if (cancelled()) throw new DOMException('CodeMap load superseded', 'AbortError');
      if (response.status === 401 || response.status === 403) {
        throw new Error('Authentication required — open this dashboard from its token URL.');
      }
      const body: unknown = await response.json().catch(() => {
        throw new Error(unavailable);
      });
      if (!response.ok) {
        if (
          response.status === 409 &&
          record(body) &&
          body.code === 'CODEMAP_SNAPSHOT_EXPIRED' &&
          attempt === 0
        )
          break;
        throw new Error(
          record(body) && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
        );
      }
      // Old engines ignore transfer=chunks. Preserve compatibility, but never accept
      // an unchunked graph in the middle of an already-started snapshot.
      if (snapshot === undefined && graph(body)) return body;
      if (
        !record(body) ||
        body.transport !== 'codemap-chunks-v1' ||
        typeof body.snapshot !== 'string' ||
        !body.snapshot ||
        body.offset !== offset ||
        typeof body.totalBytes !== 'number' ||
        !Number.isSafeInteger(body.totalBytes) ||
        body.totalBytes <= 0 ||
        body.totalBytes > MAX_GRAPH_BYTES ||
        typeof body.chunk !== 'string' ||
        body.chunk.length > Math.ceil(CHUNK_BYTES / 3) * 4 ||
        (snapshot !== undefined &&
          (body.snapshot !== snapshot || body.totalBytes !== bytes?.length))
      ) {
        throw new Error(INVALID_TRANSFER);
      }
      snapshot = body.snapshot;
      const decoded = Uint8Array.from(atob(body.chunk), (character) => character.charCodeAt(0));
      const end = offset + decoded.length;
      if (
        !decoded.length ||
        decoded.length > CHUNK_BYTES ||
        end > body.totalBytes ||
        (body.nextOffset !== null && (body.nextOffset !== end || decoded.length !== CHUNK_BYTES)) ||
        (body.nextOffset === null && end !== body.totalBytes)
      )
        throw new Error(INVALID_TRANSFER);
      bytes ??= new Uint8Array(body.totalBytes);
      bytes.set(decoded, offset);
      if (body.nextOffset === null) {
        const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!graph(result)) throw new Error(INVALID_TRANSFER);
        return result;
      }
      offset = end;
      url.searchParams.set('snapshot', snapshot);
      url.searchParams.set('offset', String(offset));
    }
  }
  throw new Error('CodeMap transfer expired — reload the map.');
}
