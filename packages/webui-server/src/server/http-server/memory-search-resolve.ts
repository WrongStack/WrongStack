import type * as http from 'node:http';
import type { MemoryPort } from '@wrongstack/contracts/types';
import { getSageSurface, isSageVisibleForSearch, type Sage } from '@wrongstack/sage';
import { decodeSessionId } from './security-helpers.js';

/** WebUI search has an access token, but no trusted agent-session identity. */
export function isWebuiSearchVisible(memory: Sage): boolean {
  return (
    memory.scope !== 'session' &&
    isSageVisibleForSearch(memory, { includeStatuses: ['active', 'stale'] })
  );
}

/** Resolve a search link without making hidden and nonexistent IDs distinguishable. */
export async function handleMemorySearchResolve(
  res: http.ServerResponse,
  rawId: string,
  getStore: () => MemoryPort | undefined,
): Promise<void> {
  const id = decodeSessionId(rawId);
  if (id === null) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Invalid memory id' }));
    return;
  }
  const store = getStore();
  const sage = store && getSageSurface(store);
  if (!sage) {
    res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'SAGE search unavailable' }));
    return;
  }
  try {
    const memory = await sage.getSage(id);
    if (!memory || !isWebuiSearchVisible(memory)) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Memory unavailable' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ memory }));
  } catch {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Memory resolution failed' }));
  }
}
