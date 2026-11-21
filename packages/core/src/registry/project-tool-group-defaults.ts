import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isSessionToolGroup,
  isSessionToolGroupMode,
  type SessionToolGroup,
  type SessionToolGroupMode,
} from '@wrongstack/contracts/types';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import { resolveWstackPaths } from '../utils/wstack-paths.js';

type Modes = Partial<Record<SessionToolGroup, SessionToolGroupMode>>;

const empty: Modes = {};

function defaultsFile(projectRoot: string): string {
  return join(resolveWstackPaths({ projectRoot }).projectDir, 'quick-tool-groups.json');
}

function read(file: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const document: unknown = JSON.parse(raw);
  if (
    typeof document !== 'object' ||
    document === null ||
    !('version' in document) ||
    document.version !== 1 ||
    !('groups' in document) ||
    typeof document.groups !== 'object' ||
    document.groups === null ||
    Array.isArray(document.groups)
  ) {
    throw new Error(
      'Invalid Quick tool group settings. Restore the project defaults file before saving.',
    );
  }
  return document.groups as Record<string, unknown>;
}

/** Null means an unreadable or unsupported settings file, so optional tools fail closed. */
export function projectToolGroupDefaults(projectRoot: string | undefined): Modes | null {
  if (!projectRoot) return empty;
  try {
    const modes: Modes = {};
    for (const [group, mode] of Object.entries(read(defaultsFile(projectRoot)))) {
      if (!isSessionToolGroup(group)) continue;
      if (!isSessionToolGroupMode(mode)) return null;
      modes[group] = mode;
    }
    return modes;
  } catch {
    return null;
  }
}

export async function writeProjectToolGroupDefault(
  projectRoot: string,
  group: SessionToolGroup,
  mode: SessionToolGroupMode,
): Promise<void> {
  const file = defaultsFile(projectRoot);
  await withFileLock(file, async () => {
    const groups = read(file);
    if (mode === 'auto') delete groups[group];
    else groups[group] = mode;
    await atomicWrite(file, `${JSON.stringify({ version: 1, groups }, null, 2)}\n`, {
      mode: 0o600,
    });
  });
}
