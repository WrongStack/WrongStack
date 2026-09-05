import * as fsp from 'node:fs/promises';
import type { SessionSummary } from '../../types/session.js';
import { atomicWrite } from '../../utils/atomic-write.js';
import { toErrorMessage } from '../../utils/index.js';
import type { EventBus } from '../event-bus-port.js';
import { emitSessionStoreError, emitSessionStoreRead } from './events.js';

export function decorateStorage(
  summary: SessionSummary,
  located: { state: 'hot' | 'cold'; size: number },
): SessionSummary {
  if (located.state === 'cold') {
    return {
      ...summary,
      storageState: 'cold',
      codec: 'gzip',
      compressedBytes: located.size,
    };
  }
  return { ...summary, storageState: 'hot', uncompressedBytes: located.size };
}

export async function readSummaryManifestFile(
  manifestPath: string,
  events: EventBus | undefined,
  id: string,
  startTime = Date.now(),
): Promise<SessionSummary | null> {
  try {
    const raw = await fsp.readFile(manifestPath, 'utf8');
    emitSessionStoreRead(events, id, manifestPath, 'summary', 'success', Date.now() - startTime);
    return JSON.parse(raw) as SessionSummary;
  } catch {
    return null;
  }
}

export interface SummaryManifestHost {
  events?: EventBus | undefined;
  sessionPath: (id: string, ext: '.summary.json') => string;
  requireTranscript: (
    id: string,
  ) => Promise<{ filePath: string; state: 'hot' | 'cold'; size: number }>;
  summarize: (id: string, mtime: string) => Promise<SessionSummary>;
  logWarn: (msg: string, ctx?: Record<string, unknown>) => void;
}

export async function executeSummaryFor(
  host: SummaryManifestHost,
  id: string,
): Promise<SessionSummary> {
  const manifest = host.sessionPath(id, '.summary.json');
  const t0 = Date.now();
  let outcome: 'success' | 'failure' = 'success';
  let errorMsg: string | undefined;
  const fromManifest = await readSummaryManifestFile(manifest, host.events, id, t0);
  if (fromManifest) return fromManifest;

  try {
    const located = await host.requireTranscript(id);
    const full = located.filePath;
    const stat = await fsp.stat(full);
    const summary = decorateStorage(await host.summarize(id, stat.mtime.toISOString()), located);
    await atomicWrite(manifest, JSON.stringify(summary), { mode: 0o600 }).catch((err) => {
      const msg = toErrorMessage(err);
      emitSessionStoreError(host.events, id, manifest, 'summary_fallback', msg, true);
      host.logWarn('Session manifest write failed', {
        event: 'session_store.manifest_write_failed',
        sessionId: id,
        message: msg,
      });
    });
    outcome = 'failure';
    errorMsg = 'summary fallback — manifest rebuilt';
    emitSessionStoreRead(host.events, id, manifest, 'summary', outcome, Date.now() - t0, errorMsg);
    return summary;
  } catch (err) {
    outcome = 'failure';
    errorMsg = toErrorMessage(err);
    emitSessionStoreRead(host.events, id, manifest, 'summary', outcome, Date.now() - t0, errorMsg);
    return {
      id,
      title: '(damaged)',
      startedAt: new Date().toISOString(),
      model: 'unknown',
      provider: 'unknown',
      tokenTotal: 0,
    };
  }
}
