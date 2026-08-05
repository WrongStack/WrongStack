#!/usr/bin/env node
/**
 * Defensive preload for Vitest coverage on long Windows monorepo runs.
 *
 * Vitest creates `coverage.reportsDirectory/.tmp` once during clean(), then
 * writes `coverage-N.json` chunks for every finished suite. If that directory
 * disappears mid-run (concurrent coverage process, FS flakiness, antivirus),
 * the suite fails after green tests with:
 *
 *   Something removed the coverage directory ".../coverage/.tmp"
 *
 * Upstream (#10117) chose a clearer error over auto-recreate so concurrent
 * reporters cannot silently mix. We still re-create only the immediate parent
 * of a coverage chunk write: the lock in coverage-lock.mjs remains the
 * primary concurrency guard; this only absorbs transient directory loss so a
 * multi-minute green suite is not discarded at the finish line.
 *
 * Load via NODE_OPTIONS `--import ./scripts/coverage-tmp-guard.mjs` before
 * vitest so the patch is in place before the coverage provider imports
 * `node:fs` promises (property access, not a destructured binding).
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const originalWriteFile = fsp.writeFile.bind(fsp);
const COVERAGE_CHUNK = /(?:^|[\\/])coverage-\d+\.json$/iu;

function isCoverageChunkPath(file) {
  if (typeof file !== 'string') return false;
  if (!COVERAGE_CHUNK.test(file)) return false;
  // Path may use / or \ depending on platform and caller.
  return file.includes(`${path.sep}.tmp${path.sep}`) || file.includes('/.tmp/');
}

fsp.writeFile = async function writeFileCoverageGuarded(file, data, options) {
  if (isCoverageChunkPath(file)) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
  }
  return originalWriteFile(file, data, options);
};
