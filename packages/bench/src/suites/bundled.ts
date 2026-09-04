import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchSuite, BenchTask, SuiteId } from '../types.js';
import { createLocalManifestSuite } from './local-manifest.js';

/**
 * Walk up from `import.meta.url` until `fixtures/<name>/bench.local.json`.
 * Covers `src/suites/*.ts`, unbundled `dist/suites/*.js`, and the published
 * `dist/index.js` bundle.
 */
export function resolveBundledSuiteDir(name: string): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'fixtures', name);
    if (existsSync(path.join(candidate, 'bench.local.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`cannot locate the bundled WrongStack ${name} suite (fixtures/${name})`);
}

/** Wrap a local-manifest suite under a bundled suite id (`smoke/` / `core/`). */
export function createBundledLocalSuite(name: Extract<SuiteId, 'smoke' | 'core'>): BenchSuite {
  const inner = createLocalManifestSuite({ suiteDir: resolveBundledSuiteDir(name) });
  const prefix = `${name}/`;
  const localPrefix = 'local/';
  return {
    id: name,
    async loadTasks(opts) {
      const tasks = await inner.loadTasks(opts);
      return tasks.map((task) => relabel(task, localPrefix, prefix, name));
    },
    subsetId(tasks) {
      const innerId = inner.subsetId(
        tasks.map((task) => relabel(task, prefix, localPrefix, 'local')),
      );
      return innerId.startsWith('local:') ? `${name}:${innerId.slice('local:'.length)}` : innerId;
    },
  };
}

function relabel(task: BenchTask, from: string, to: string, suite: BenchTask['suite']): BenchTask {
  const id = task.id.startsWith(from) ? `${to}${task.id.slice(from.length)}` : task.id;
  return { ...task, id, suite };
}
