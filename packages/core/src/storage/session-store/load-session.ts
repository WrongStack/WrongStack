import * as fsp from 'node:fs/promises';
import type { SecretScrubber } from '../../types/secret-scrubber.js';
import type { SessionData, SessionLoadProgress } from '../../types/session.js';
import { toErrorMessage } from '../../utils/index.js';
import type { EventBus } from '../event-bus-port.js';
import { emitSessionStoreRead } from './events.js';
import type { SessionLoadCache } from './load-cache.js';
import { loadSessionDataFromFile } from './load-session-data.js';

export interface LoadSessionParams {
  id: string;
  file: string;
  full: boolean;
  loadCache: SessionLoadCache;
  events?: EventBus | undefined;
  secretScrubber: SecretScrubber;
  onLoadProgress?: ((progress: SessionLoadProgress) => void) | undefined;
}

export async function executeLoadSession(params: LoadSessionParams): Promise<SessionData> {
  const { id, file, full, loadCache, events, secretScrubber, onLoadProgress } = params;
  const t0 = Date.now();
  let outcome: 'success' | 'failure' = 'success';
  let errorMsg: string | undefined;
  let cacheHit = false;
  try {
    const s = await fsp.stat(file);
    const stat: { mtimeMs: number; size: number } = { mtimeMs: s.mtimeMs, size: s.size };
    const cached = loadCache.getFresh(id, stat, full);
    if (cached) {
      cacheHit = true;
      // A warm cache parses nothing — report a single completed event so a
      // progress consumer still sees the load reach 100%.
      onLoadProgress?.({ loadedBytes: stat.size, totalBytes: stat.size });
      return cached;
    }

    const data = await loadSessionDataFromFile({
      id,
      file,
      full,
      events,
      secretScrubber,
      onLoadProgress,
    });

    if (full) {
      loadCache.set(id, stat, data);
    }

    return data;
  } catch (err) {
    outcome = 'failure';
    errorMsg = toErrorMessage(err);
    throw err;
  } finally {
    emitSessionStoreRead(
      events,
      id,
      file,
      full ? 'load' : 'load_events_only',
      outcome,
      Date.now() - t0,
      errorMsg,
    );
    if (cacheHit) {
      events?.emit('storage.cache_hit', {
        sessionId: id,
        store: 'session',
        filePath: file,
        operation: full ? 'load' : 'load_events_only',
        durationMs: Date.now() - t0,
      });
    }
  }
}
