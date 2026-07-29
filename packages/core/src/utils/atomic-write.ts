import type { FileHandle } from 'node:fs/promises';
import {
  type AtomicWriteOptions,
  createPersistencePrimitives,
  type FileLockOptions,
} from '@wrongstack/persistence';
import { FsError } from '../types/errors.js';

export type { AtomicWriteOptions, FileLockOptions } from '@wrongstack/persistence';

const primitives = createPersistencePrimitives({
  createLockTimeoutError: ({ targetPath, timeoutMs }) =>
    new FsError({
      message: `Timed out waiting for file lock: ${targetPath}`,
      code: 'FS_ATOMIC_WRITE_FAILED',
      path: targetPath,
      context: { timeoutMs },
    }),
});

export const atomicWrite: (
  targetPath: string,
  content: string | Uint8Array,
  opts?: AtomicWriteOptions,
) => Promise<void> = primitives.atomicWrite;
/**
 * Atomic replace that streams its new contents instead of taking them as one
 * buffer. Use when the replacement is large enough that materializing it would
 * itself be the memory problem (log rotation, tail compaction).
 */
export const atomicReplaceWithWriter: <T>(
  targetPath: string,
  write: (handle: FileHandle) => Promise<T>,
  opts?: AtomicWriteOptions,
) => Promise<T> = primitives.atomicReplaceWithWriter;
export const ensureDir: (dir: string) => Promise<void> = primitives.ensureDir;
export const withFileLock: <T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts?: FileLockOptions,
) => Promise<T> = primitives.withFileLock;
