import type { Dirent } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  isColdSessionTranscriptFileName,
  stripSessionTranscriptExtension,
} from '../../utils/session-scoped-path.js';
import type { SessionFileRef } from './types.js';
import { isSessionJsonlFileName, shouldSkipSessionDirectoryEntry } from './directory-scan.js';

function sessionIdForFile(prefix: string, name: string): string {
  const base = stripSessionTranscriptExtension(name);
  return prefix ? `${prefix}/${base}` : base;
}

function preferHotTranscript(existing: SessionFileRef | undefined, next: SessionFileRef): SessionFileRef {
  if (!existing) return next;
  if (!isColdSessionTranscriptFileName(existing.filePath)) return existing;
  if (!isColdSessionTranscriptFileName(next.filePath)) return next;
  return existing;
}

function childPrefixFor(entry: Dirent, prefix: string, depth: number): string {
  return depth === 0 ? entry.name : `${prefix}/${entry.name}`;
}

export async function collectSessionFiles(
  dir: string,
  prefix = '',
  depth = 0,
): Promise<SessionFileRef[]> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirEntries: Dirent[] = [];
  const files = new Map<string, SessionFileRef>();
  for (const entry of entries) {
    if (shouldSkipSessionDirectoryEntry(entry.name)) continue;
    if (entry.isDirectory()) {
      dirEntries.push(entry);
    } else if (entry.isFile() && isSessionJsonlFileName(entry.name)) {
      const id = sessionIdForFile(prefix, entry.name);
      const next = { id, filePath: path.join(dir, entry.name) };
      files.set(id, preferHotTranscript(files.get(id), next));
    }
  }

  const childFileArrays = await Promise.all(
    dirEntries.map((entry) =>
      collectSessionFiles(
        path.join(dir, entry.name),
        childPrefixFor(entry, prefix, depth),
        depth + 1,
      ),
    ),
  );

  return [...childFileArrays.flat(), ...files.values()];
}

export async function collectSessionIds(dir: string, prefix = '', depth = 0): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirEntries: Dirent[] = [];
  const fileIds = new Set<string>();
  for (const entry of entries) {
    if (shouldSkipSessionDirectoryEntry(entry.name)) continue;
    if (entry.isDirectory()) {
      dirEntries.push(entry);
    } else if (entry.isFile() && isSessionJsonlFileName(entry.name)) {
      fileIds.add(sessionIdForFile(prefix, entry.name));
    }
  }

  const childIdArrays = await Promise.all(
    dirEntries.map((entry) =>
      collectSessionIds(
        path.join(dir, entry.name),
        childPrefixFor(entry, prefix, depth),
        depth + 1,
      ),
    ),
  );

  return [...childIdArrays.flat(), ...fileIds];
}
