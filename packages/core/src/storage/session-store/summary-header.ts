import * as fsp from 'node:fs/promises';
import type { SecretScrubber } from '../../types/secret-scrubber.js';
import type { SessionSummary } from '../../types/session.js';
import { iterateSessionEvents } from './summary-builder.js';
import type { SessionFileRef } from './types.js';

export async function readSessionSummaryHeader(
  ref: SessionFileRef,
  secretScrubber: SecretScrubber,
): Promise<SessionSummary | null> {
  let mtime = new Date(0).toISOString();
  try {
    const stat = await fsp.stat(ref.filePath);
    if (!stat.isFile()) return damagedSummary(ref.id, stat.mtime.toISOString());
    mtime = stat.mtime.toISOString();
  } catch {
    return null;
  }

  try {
    for await (const event of iterateSessionEvents(ref.filePath, secretScrubber)) {
      if (event.type === 'session_start') {
        return {
          id: ref.id,
          title: '(empty session)',
          startedAt: event.ts,
          model: event.model ?? 'unknown',
          provider: event.provider ?? 'unknown',
          tokenTotal: 0,
        };
      }
    }
    return emptySessionSummary(ref.id, new Date(0).toISOString());
  } catch {
    return damagedSummary(ref.id, mtime);
  }
}

function emptySessionSummary(id: string, startedAt: string): SessionSummary {
  return {
    id,
    title: '(empty session)',
    startedAt,
    model: 'unknown',
    provider: 'unknown',
    tokenTotal: 0,
  };
}

function damagedSummary(id: string, startedAt: string): SessionSummary {
  return {
    id,
    title: '(damaged)',
    startedAt,
    model: 'unknown',
    provider: 'unknown',
    tokenTotal: 0,
  };
}
