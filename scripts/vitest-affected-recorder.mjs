/**
 * Records what each test file actually imported, so the next local run can skip
 * the ones nothing under them changed.
 *
 * Why this is not `vitest --changed` / `vitest --related`: both were measured
 * against this repo (2026-09-06) and return NOTHING. Appending a line to
 * `packages/core/src/types/session.ts` — a module hundreds of suites reach —
 * selected zero test files. A selector that silently skips everything that
 * could break is worse than no selector, so the dependency edges are taken
 * from Vitest's own SSR module graph after a run instead of being predicted
 * before one. What a run imported is a fact; what a resolver thinks it will
 * import is a guess, and this repo's alias table (every `@wrongstack/*` mapped
 * to source) is exactly where such a guess goes wrong.
 *
 * The cache is written by this reporter and consumed by
 * `scripts/test-affected.mjs`. It is a LOCAL iteration aid: CI and
 * `pnpm release:check` always run the full suite, which is what makes the one
 * unavoidable blind spot (a test that reads a fixture at runtime without
 * importing it) acceptable.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CACHE_PATH, hashFile, readCache, toRepoPath } from './lib/affected-cache.mjs';

/** Walk the SSR module graph from a test file and return every repo file it pulled in. */
function collectDeps(moduleGraph, filepath) {
  const roots = moduleGraph.getModulesByFile?.(filepath);
  if (!roots || roots.size === 0) return null;
  const seen = new Set();
  const files = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const node = queue.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    // Virtual modules (vite internals, inline mocks) surface as a `file` that
    // is null, or a bare specifier like ` vite/dynamic-import-helper.js`. They
    // have no content on disk, so recording one makes its test look eternally
    // dirty — `hashFile` can never resolve it. Only absolute paths are real.
    if (typeof node.file === 'string' && path.isAbsolute(node.file)) {
      const rel = toRepoPath(node.file);
      // node_modules churn is covered by the lockfile in the salt, and hashing
      // it would dominate the cost for no signal.
      if (rel && !rel.includes('node_modules/')) files.add(rel);
    }
    for (const next of node.ssrImportedModules ?? node.importedModules ?? []) queue.push(next);
  }
  return [...files].sort();
}

/** Vitest 4 exposes `.ok()`; stay tolerant so a minor bump cannot silently poison the cache. */
function modulePassed(testModule) {
  if (typeof testModule.ok === 'function') return testModule.ok();
  const state = typeof testModule.state === 'function' ? testModule.state() : undefined;
  return state === 'pass' || state === 'passed';
}

export default class AffectedRecorder {
  onInit(vitest) {
    this.vitest = vitest;
  }

  onTestRunEnd(testModules) {
    try {
      this.record(testModules ?? []);
    } catch (error) {
      // A broken cache must never fail a test run: the worst outcome of not
      // writing it is that the next run does more work than strictly needed.
      process.stderr.write(`[affected] could not update the cache: ${String(error)}\n`);
    }
  }

  record(testModules) {
    const salt = process.env['WRONGSTACK_AFFECTED_SALT'];
    if (!salt) return;
    const cache = readCache();
    // A different salt means the config/lockfile moved under every entry, so
    // nothing recorded earlier can still be trusted.
    const entries = cache.salt === salt ? cache.entries : {};
    const hashes = cache.salt === salt ? cache.hashes : {};

    for (const project of this.vitest.projects ?? []) {
      const moduleGraph = (project.vite ?? project.server)?.moduleGraph;
      if (!moduleGraph) continue;
      for (const testModule of testModules) {
        const filepath = testModule.moduleId ?? testModule.filepath;
        if (typeof filepath !== 'string') continue;
        const rel = toRepoPath(filepath);
        if (!rel) continue;
        const deps = collectDeps(moduleGraph, filepath);
        // No graph entry means we did not observe this file's imports; dropping
        // the entry makes the next run treat it as dirty, which is the safe way
        // to be wrong.
        if (deps === null) {
          delete entries[rel];
          continue;
        }
        for (const dep of deps) hashes[dep] = hashFile(dep);
        entries[rel] = { status: modulePassed(testModule) ? 'pass' : 'fail', deps };
      }
    }

    mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ schemaVersion: 1, salt, entries, hashes }), 'utf8');
  }
}
