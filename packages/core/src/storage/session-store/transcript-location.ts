import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import {
  SESSION_COLD_TRANSCRIPT_SUFFIX,
  SESSION_HOT_TRANSCRIPT_SUFFIX,
  sessionScopedPath,
} from '../../utils/session-scoped-path.js';

export type TranscriptStorageState = 'hot' | 'cold';

export interface TranscriptLocation {
  id: string;
  state: TranscriptStorageState;
  filePath: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
}

export function hotTranscriptRelativePath(id: string): string {
  return `${id}${SESSION_HOT_TRANSCRIPT_SUFFIX}`;
}

export function coldTranscriptRelativePath(id: string): string {
  return `${id}${SESSION_COLD_TRANSCRIPT_SUFFIX}`;
}

export function isCanonicalTranscriptRelativePath(id: string, relative: string): boolean {
  const normalized = relative.replaceAll('\\', '/');
  return (
    normalized === hotTranscriptRelativePath(id) || normalized === coldTranscriptRelativePath(id)
  );
}

function locationFromStat(
  id: string,
  state: TranscriptStorageState,
  filePath: string,
  size: number,
  mtimeMs: number,
): TranscriptLocation {
  return {
    id,
    state,
    filePath,
    relativePath: state === 'cold' ? coldTranscriptRelativePath(id) : hotTranscriptRelativePath(id),
    size,
    mtimeMs,
  };
}

/**
 * Prefer the live JSONL when both the hot file and a leftover gzip exist
 * (crash between writing the archive and unlinking the source).
 */
export function locateTranscriptSync(storeDir: string, id: string): TranscriptLocation | null {
  const hotPath = sessionScopedPath(storeDir, id, SESSION_HOT_TRANSCRIPT_SUFFIX);
  const coldPath = sessionScopedPath(storeDir, id, SESSION_COLD_TRANSCRIPT_SUFFIX);
  try {
    const hot = fs.statSync(hotPath);
    if (hot.isFile() && hot.size > 0) {
      return locationFromStat(id, 'hot', hotPath, hot.size, hot.mtimeMs);
    }
  } catch {
    // fall through to the cold archive
  }
  try {
    const cold = fs.statSync(coldPath);
    if (cold.isFile() && cold.size > 0) {
      return locationFromStat(id, 'cold', coldPath, cold.size, cold.mtimeMs);
    }
  } catch {
    // missing
  }
  try {
    const emptyHot = fs.statSync(hotPath);
    if (emptyHot.isFile()) {
      return locationFromStat(id, 'hot', hotPath, emptyHot.size, emptyHot.mtimeMs);
    }
  } catch {
    return null;
  }
  return null;
}

export async function locateTranscript(
  storeDir: string,
  id: string,
): Promise<TranscriptLocation | null> {
  const hotPath = sessionScopedPath(storeDir, id, SESSION_HOT_TRANSCRIPT_SUFFIX);
  const coldPath = sessionScopedPath(storeDir, id, SESSION_COLD_TRANSCRIPT_SUFFIX);
  try {
    const hot = await fsp.stat(hotPath);
    if (hot.isFile() && hot.size > 0) {
      return locationFromStat(id, 'hot', hotPath, hot.size, hot.mtimeMs);
    }
  } catch {
    // fall through
  }
  try {
    const cold = await fsp.stat(coldPath);
    if (cold.isFile() && cold.size > 0) {
      return locationFromStat(id, 'cold', coldPath, cold.size, cold.mtimeMs);
    }
  } catch {
    // missing
  }
  try {
    const emptyHot = await fsp.stat(hotPath);
    if (emptyHot.isFile()) {
      return locationFromStat(id, 'hot', hotPath, emptyHot.size, emptyHot.mtimeMs);
    }
  } catch {
    return null;
  }
  return null;
}
