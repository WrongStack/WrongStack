import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { moduleDirFor } from '@wrongstack/persistence';

export function modePrompt(id: string): string {
  for (const dir of modePromptDirCandidates()) {
    try {
      return readFileSync(path.join(dir, `${id}.md`), 'utf8').trimEnd();
    } catch {
      // try next candidate
    }
  }
  return '';
}

/**
 * Resolved once per process: the candidate list is identical for every call and
 * ordering it costs three `statSync` probes. `DEFAULT_MODES` alone asks for 18
 * prompts, so the uncached version spent 54 syscalls re-deriving a constant.
 */
let cachedDirCandidates: string[] | undefined;

function modePromptDirCandidates(): string[] {
  if (cachedDirCandidates) return cachedDirCandidates;
  const here = moduleDirFor(import.meta.url, '@wrongstack/core');
  const candidates = [
    path.resolve(here, '../../instructions/modes'),
    path.resolve(here, '../instructions/modes'),
    path.resolve(here, 'instructions/modes'),
  ];
  cachedDirCandidates = candidates.sort(
    (a, b) => Number(!isDirectory(a)) - Number(!isDirectory(b)),
  );
  return cachedDirCandidates;
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
