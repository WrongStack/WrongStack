import { readdirSync, rmSync } from 'node:fs';

const RETAINABLE_EMPTY_DIRECTORY_ERRORS = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);

/**
 * Remove a package build directory without failing when Windows has already
 * removed every child but a watcher briefly keeps the empty directory open.
 *
 * The empty-directory check is the safety boundary: stale build output must
 * never survive a clean build.
 */
export function cleanBuildOutput(outputPath, { removeSync = rmSync, listSync = readdirSync } = {}) {
  try {
    removeSync(outputPath, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
    return 'removed';
  } catch (error) {
    if (!RETAINABLE_EMPTY_DIRECTORY_ERRORS.has(error?.code)) throw error;

    try {
      if (listSync(outputPath).length === 0) return 'retained-empty';
    } catch (inspectionError) {
      // A concurrent remover completing after rmSync failed is also success.
      if (inspectionError?.code === 'ENOENT') return 'removed';
    }

    throw error;
  }
}
