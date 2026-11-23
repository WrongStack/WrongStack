import * as fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ProviderModelStatus,
  ProviderStatusTrackerPort,
} from '@wrongstack/contracts/types/provider-status';
import { restrictFilePermissions } from '@wrongstack/core/security';
import { atomicWrite, withFileLock } from '@wrongstack/core/utils';

/** Bind standalone manual health controls to the same profile files used by the CLI. */
export function createProviderStatusPersistence(
  tracker: ProviderStatusTrackerPort,
  profileConfigPath: string,
) {
  const statusFile = path.join(path.dirname(profileConfigPath), 'provider-status.json');
  const auditFile = path.join(path.dirname(profileConfigPath), 'provider-status-audit.jsonl');
  let pending: Promise<void> | undefined;
  let auditHardened = false;
  const read = async () => {
    try {
      const value: unknown = JSON.parse(await fs.readFile(statusFile, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('The saved provider status document is invalid.');
      return value as { statuses?: unknown[] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  };
  const prepare = () => {
    pending ??= read()
      .then((saved) => {
        // A fresh live failure must not be overwritten by an older disk entry.
        const statuses = Array.isArray(saved.statuses) ? saved.statuses : [];
        tracker.restoreSnapshot({
          statuses: statuses.filter((raw) => {
            if (!raw || typeof raw !== 'object') return false;
            const row = raw as Record<string, unknown>;
            if (typeof row['providerId'] !== 'string' || typeof row['model'] !== 'string')
              return false;
            const live = tracker.getStatus(row['providerId'], row['model']);
            return (
              !live ||
              (live.lastFailureAt ?? 0) <
                (typeof row['lastFailureAt'] === 'number' ? row['lastFailureAt'] : 0)
            );
          }),
        });
      })
      .catch((error) => {
        pending = undefined;
        throw error;
      });
    return pending;
  };
  const persistControl = async (
    providerId: string,
    model: string,
    before: ProviderModelStatus | undefined,
    reason: string,
  ) => {
    const now = Date.now();
    const current = tracker.getStatus(providerId, model);
    await withFileLock(statusFile, async () => {
      const saved = await read();
      const statuses = (Array.isArray(saved.statuses) ? saved.statuses : []).filter((raw) => {
        if (!raw || typeof raw !== 'object') return false;
        const row = raw as Record<string, unknown>;
        // Preserve a newer peer failure that arrived after this manual action.
        return (
          row['providerId'] !== providerId ||
          row['model'] !== model ||
          (typeof row['lastFailureAt'] === 'number' && row['lastFailureAt'] > now)
        );
      });
      if (
        current &&
        current.state !== 'healthy' &&
        !statuses.some((raw) => {
          const row = raw as Record<string, unknown>;
          return row['providerId'] === providerId && row['model'] === model;
        })
      )
        statuses.push(current);
      await atomicWrite(
        statusFile,
        JSON.stringify({ ...saved, version: 1, updatedAt: now, statuses }, null, 2),
        { mode: 0o600 },
      );
    });
    await withFileLock(auditFile, async () => {
      await fs.appendFile(
        auditFile,
        `${JSON.stringify({ ts: now, providerId, model, from: before?.state ?? 'healthy', to: current?.state ?? 'healthy', reason, error: before?.lastErrorKind ? { kind: before.lastErrorKind, status: before.lastErrorStatus, message: before.lastErrorMessage, sessionId: before.lastSessionId, agentId: before.lastAgentId } : null })}\n`,
        { mode: 0o600 },
      );
      // F38 (WS-045 class): on Windows `mode: 0o600` is a no-op, so this audit
      // log — error messages, session/agent ids — stayed readable by other local
      // accounts where inheritance was not owner-only. Harden once per instance
      // (best-effort, warned not thrown).
      if (!auditHardened) {
        auditHardened = true;
        await restrictFilePermissions(auditFile, { label: 'provider-status-audit' });
      }
    });
  };
  return { prepare, persistControl, auditFile };
}
