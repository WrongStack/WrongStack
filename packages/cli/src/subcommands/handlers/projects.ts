import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { color } from '@wrongstack/core/utils';
import type { SubcommandHandler } from '../contracts.js';

export const projectsCmd: SubcommandHandler = async (_args, deps) => {
  const projectsRoot = path.join(deps.paths.globalRoot, 'projects');
  try {
    const entries = await fs.readdir(projectsRoot);
    if (entries.length === 0) {
      deps.renderer.write('No projects tracked.\n');
      return 0;
    }
    for (const hash of entries) {
      try {
        const meta = JSON.parse(
          await fs.readFile(path.join(projectsRoot, hash, 'meta.json'), 'utf8'),
        ) as { root?: string | undefined; lastSeen?: string | undefined };
        deps.renderer.write(
          `  ${color.dim(hash)}  ${color.dim(meta.lastSeen ?? '')}  ${meta.root ?? '?'}\n`,
        );
      } catch {
        deps.renderer.write(`  ${color.dim(hash)}  ${color.dim('(no meta)')}\n`);
      }
    }
    return 0;
  } catch {
    deps.renderer.write('No projects directory.\n');
    return 0;
  }
};
