import { readFileSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Cache of resolved prompt text, keyed by `<envDir>\0<id>`. Prompt files do
 * not change during a process lifetime, so the first successful (or failed)
 * lookup is memoized. The key includes the override env var so tests that set
 * `WRONGSTACK_AGENT_INSTRUCTIONS_DIR` still observe fresh resolution.
 */
const promptCache = new Map<string, string>();

/**
 * Cache of the ordered candidate directory list, keyed by `<envDir>\0<cwd-home>`.
 * The list is otherwise identical for every `agentPrompt()` call, so resolving
 * (and sorting via `statSync`) it once per env avoids ~7 redundant `statSync`
 * probes per call. `fleet.ts` + the phase catalogs alone call `agentPrompt()`
 * ~60 times at import time.
 */
const candidateCache = new Map<string, string[]>();

export function agentPrompt(id: string): string {
  const envDir = process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'] ?? '';
  const cacheKey = `${envDir}\u0000${id}`;
  const cached = promptCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const fileName = `${id}.md`;
  let resolved = '';
  for (const dir of agentPromptDirCandidates(envDir)) {
    try {
      resolved = readFileSync(path.join(dir, fileName), 'utf8').trimEnd();
      break;
    } catch {
      // try next candidate
    }
  }
  promptCache.set(cacheKey, resolved);
  return resolved;
}

function agentPromptDirCandidates(envDir: string): string[] {
  const globalRoot = process.env['WRONGSTACK_HOME'] || path.join(os.homedir(), '.wrongstack');
  const candKey = `${envDir}\u0000${globalRoot}`;
  const cached = candidateCache.get(candKey);
  if (cached !== undefined) return cached;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const explicitDir = envDir || undefined;
  const candidates = [
    ...(explicitDir ? [path.resolve(explicitDir)] : []),
    path.join(globalRoot, 'instructions', 'agents'),
    path.resolve(here, '../../../../instructions/agents'),
    path.resolve(here, '../../../instructions/agents'),
    path.resolve(here, '../../instructions/agents'),
    path.resolve(here, '../instructions/agents'),
    path.resolve(here, 'instructions/agents'),
  ];
  const ordered = candidates.sort((a, b) => Number(!isDirectory(a)) - Number(!isDirectory(b)));
  candidateCache.set(candKey, ordered);
  return ordered;
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
