import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import type { SessionMetadata } from '@wrongstack/contracts/types/session';
import type { SessionCatalogProjectClient } from '../../session-catalog/client.js';
import { atomicWrite } from '../../utils/atomic-write.js';
import { createTranscriptLineReader } from './transcript-io.js';

export interface ClearSessionHistoryParams {
  id: string;
  canonical: string;
  catalogClient?: SessionCatalogProjectClient | undefined;
  maintenanceHolderId: string;
  ensureShardDir: (id: string) => Promise<string>;
  sessionPath: (id: string, ext: '.jsonl' | '.summary.json') => string;
  clearLoadCache?: ((id: string) => Promise<void>) | undefined;
}

export async function executeClearSessionHistory(params: ClearSessionHistoryParams): Promise<void> {
  const {
    canonical,
    catalogClient,
    maintenanceHolderId,
    ensureShardDir,
    sessionPath,
    clearLoadCache,
  } = params;

  const maintenance = catalogClient
    ? await catalogClient.call('acquire_maintenance', {
        sessionId: canonical,
        operation: 'clear',
        holderId: maintenanceHolderId,
        holderPid: process.pid,
      })
    : undefined;

  await ensureShardDir(canonical);
  const file = sessionPath(canonical, '.jsonl');
  const meta = sessionPath(canonical, '.summary.json');
  // Always move the live files aside before rewriting, lease or not. On
  // Windows a file another handle still has open (the session's own writer, a
  // tailing reader) can be renamed AWAY but never replaced in place, so the
  // lease-less path used to fail /clear with EPERM from atomicWrite's rename.
  const backupSuffix = `.${maintenance?.leaseId ?? randomUUID()}.clear-backup`;
  const fileBackup = `${file}${backupSuffix}`;
  const metaBackup = `${meta}${backupSuffix}`;
  let fileStaged = false;
  let metaStaged = false;
  try {
    fileStaged = await moveAside(file, fileBackup);
    metaStaged = await moveAside(meta, metaBackup);
    const quickToolPins = fileStaged ? await readQuickToolPins(fileBackup) : {};
    const record = `${JSON.stringify({
      type: 'session_start',
      ts: new Date().toISOString(),
      id: canonical,
      model: 'unknown',
      provider: 'unknown',
      ...quickToolPins,
    })}\n`;
    await atomicWrite(file, record);
    if (catalogClient) {
      const now = new Date().toISOString();
      await catalogClient.call('upsert_summary', {
        summary: {
          id: canonical,
          title: '',
          startedAt: now,
          model: 'unknown',
          provider: 'unknown',
          tokenTotal: 0,
          lastActivityAt: now,
        },
        transcriptRelativePath: `${canonical}.jsonl`,
        summaryRelativePath: `${canonical}.summary.json`,
      });
    }
    if (fileStaged) await fsp.unlink(fileBackup).catch(() => undefined);
    if (metaStaged) await fsp.unlink(metaBackup).catch(() => undefined);
  } catch (error) {
    if (fileStaged) {
      await fsp.unlink(file).catch(() => undefined);
      await fsp.rename(fileBackup, file).catch(() => undefined);
    }
    if (metaStaged) {
      await fsp.unlink(meta).catch(() => undefined);
      await fsp.rename(metaBackup, meta).catch(() => undefined);
    }
    throw error;
  } finally {
    if (maintenance && catalogClient) {
      await catalogClient
        .call('release_maintenance', { lease: maintenance })
        .catch(() => undefined);
    }
    // Evict the now-stale session data graph from the load cache so the next
    // load() sees the freshly rewritten JSONL instead of a cached copy.
    // Must not throw: the finally block would propagate this error and mask
    // the primary clear operation result (success or the original error).
    try {
      await clearLoadCache?.(canonical);
    } catch {
      // Swallow — cache eviction is best-effort; the mtime guard in loadCache
      // will revalidate on next access and heal the stale entry automatically.
    }
  }
}

async function readQuickToolPins(
  file: string,
): Promise<Pick<SessionMetadata, 'quickToolSchemaVersion' | 'quickShellTool'>> {
  const reader = createTranscriptLineReader(file);
  try {
    for await (const line of reader.lines) {
      if (!line.trim()) continue;
      const header = JSON.parse(line);
      if (header?.type === 'session_start') {
        const { quickToolSchemaVersion, quickShellTool } = header;
        return {
          quickToolSchemaVersion:
            typeof quickToolSchemaVersion === 'number' ? quickToolSchemaVersion : undefined,
          quickShellTool:
            quickShellTool === 'bash' || quickShellTool === 'pwsh' ? quickShellTool : undefined,
        };
      }
      break;
    }
  } catch {
    // Legacy or damaged journals can still be cleared.
  } finally {
    reader.close();
  }
  return {};
}

/** Rename `from` to `to`; false when there was nothing to move. */
async function moveAside(from: string, to: string): Promise<boolean> {
  try {
    await fsp.rename(from, to);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
