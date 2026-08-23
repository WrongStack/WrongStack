import * as fsp from 'node:fs/promises';
import type { EventBus } from '../event-bus-port.js';
import type { SecretScrubber } from '../../types/secret-scrubber.js';
import type { SessionSummary } from '../../types/session.js';
import { atomicWrite, withFileLock } from '../../utils/atomic-write.js';
import { toErrorMessage } from '../../utils/index.js';
import { sessionContentText } from '../session-helpers.js';
import { emitSessionStoreError, emitSessionStoreWrite } from './events.js';

export interface RenameSessionParams {
  id: string;
  name: string;
  manifest: string;
  jsonlPath: string;
  events?: EventBus | undefined;
  secretScrubber: SecretScrubber;
  readSummaryManifest: (id: string) => Promise<SessionSummary | null>;
  summaryFor: (id: string) => Promise<SessionSummary>;
  appendToIndexStrict: (summary: SessionSummary) => Promise<void>;
}

export async function executeRenameSession(params: RenameSessionParams): Promise<SessionSummary> {
  const {
    id,
    name,
    manifest,
    jsonlPath,
    events,
    secretScrubber,
    readSummaryManifest,
    summaryFor,
    appendToIndexStrict,
  } = params;

  const trimmed = sessionContentText(secretScrubber.scrub(name));
  try {
    await fsp.stat(jsonlPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      throw new Error(`Session not found: ${id}`);
    }
    throw err;
  }

  const t0 = Date.now();
  let outcome: 'success' | 'failure' = 'success';
  let errorMsg: string | undefined;
  let updated: SessionSummary;
  try {
    updated = await withFileLock(manifest, async () => {
      const summary = (await readSummaryManifest(id)) ?? (await summaryFor(id));
      const { name: _drop, ...rest } = summary;
      const next: SessionSummary = trimmed ? { ...rest, name: trimmed } : rest;
      await atomicWrite(manifest, JSON.stringify(next), { mode: 0o600 });
      try {
        await appendToIndexStrict(next);
      } catch (err) {
        await atomicWrite(manifest, JSON.stringify(summary), { mode: 0o600 });
        throw err;
      }
      return next;
    });
  } catch (err) {
    outcome = 'failure';
    errorMsg = toErrorMessage(err);
    emitSessionStoreError(events, id, manifest, 'rename', errorMsg, false);
    throw err;
  } finally {
    emitSessionStoreWrite(
      events,
      id,
      manifest,
      'rename',
      outcome,
      Date.now() - t0,
      undefined,
      errorMsg,
    );
  }
  return updated;
}
