import * as fsp from 'node:fs/promises';
import type { SessionCatalogProjectClient } from '../../session-catalog/client.js';
import { atomicWrite } from '../../utils/atomic-write.js';

export interface ClearSessionHistoryParams {
  id: string;
  canonical: string;
  catalogClient?: SessionCatalogProjectClient | undefined;
  maintenanceHolderId: string;
  ensureShardDir: (id: string) => Promise<string>;
  sessionPath: (id: string, ext: '.jsonl' | '.summary.json') => string;
}

export async function executeClearSessionHistory(params: ClearSessionHistoryParams): Promise<void> {
  const { canonical, catalogClient, maintenanceHolderId, ensureShardDir, sessionPath } = params;

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
  const backupSuffix = maintenance ? `.${maintenance.leaseId}.clear-backup` : undefined;
  const fileBackup = backupSuffix ? `${file}${backupSuffix}` : undefined;
  const metaBackup = backupSuffix ? `${meta}${backupSuffix}` : undefined;
  let fileStaged = false;
  let metaStaged = false;
  const record = `${JSON.stringify({
    type: 'session_start',
    ts: new Date().toISOString(),
    id: canonical,
    model: 'unknown',
    provider: 'unknown',
  })}\n`;

  try {
    if (fileBackup) {
      try {
        await fsp.rename(file, fileBackup);
        fileStaged = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (metaBackup) {
      try {
        await fsp.rename(meta, metaBackup);
        metaStaged = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await atomicWrite(file, record);
    if (!metaBackup) await fsp.unlink(meta).catch(() => undefined);
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
    if (fileStaged && fileBackup) await fsp.unlink(fileBackup).catch(() => undefined);
    if (metaStaged && metaBackup) await fsp.unlink(metaBackup).catch(() => undefined);
  } catch (error) {
    if (fileStaged && fileBackup) {
      await fsp.unlink(file).catch(() => undefined);
      await fsp.rename(fileBackup, file).catch(() => undefined);
    }
    if (metaStaged && metaBackup) {
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
  }
}
