import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { color } from '@wrongstack/core/utils';
import type { SubcommandHandler } from '../contracts.js';

interface ProjectManifestEntry {
  name?: string | undefined;
  root?: string | undefined;
  slug?: string | undefined;
  lastSeen?: string | undefined;
}

/**
 * List the projects WrongStack has actually been used in.
 *
 * The source is `~/.wrongstack/projects.json`, the manifest `boot.ts` writes
 * on every start and the one `/project` already reads.
 *
 * This used to enumerate the `~/.wrongstack/projects/` DIRECTORY instead, which
 * is not the same thing: that directory also holds per-run scratch state for
 * ephemeral roots — Chimera review worktrees and the like — which are created
 * by the hundred and carry no `meta.json`. On a working machine the listing was
 * 1,495 rows of which 1,461 printed `(no meta)` and 262 were single-use
 * `chimera-*` scratch dirs, against 30 real entries in the manifest. The
 * command was unusable for the one question it answers.
 */
export const projectsCmd: SubcommandHandler = async (_args, deps) => {
  const manifestPath = path.join(deps.paths.globalRoot, 'projects.json');

  let entries: ProjectManifestEntry[];
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      projects?: unknown;
    };
    entries = Array.isArray(parsed.projects) ? (parsed.projects as ProjectManifestEntry[]) : [];
  } catch {
    deps.renderer.write('No projects tracked yet.\n');
    return 0;
  }

  if (entries.length === 0) {
    deps.renderer.write('No projects tracked yet.\n');
    return 0;
  }

  // Most recently used first: the answer to "where was I working" is almost
  // always at the top, and the tail is history.
  const sorted = [...entries].sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''));
  const slugWidth = Math.min(
    Math.max(...sorted.map((entry) => (entry.slug ?? '').length), 4),
    40,
  );

  for (const entry of sorted) {
    const slug = (entry.slug ?? '?').padEnd(slugWidth);
    const seen = entry.lastSeen ?? '';
    deps.renderer.write(`  ${color.dim(slug)}  ${color.dim(seen)}  ${entry.root ?? '?'}\n`);
  }
  return 0;
};
