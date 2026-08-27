import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';

export interface Sandbox {
  dir: string;
  ctx: Context;
  cleanup(): Promise<void>;
}

export async function mkSandbox(): Promise<Sandbox> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-tools-'));
  const messages: Context['messages'] = [];
  const todos: Context['todos'] = [];
  const ctx = {
    cwd: dir,
    projectRoot: dir,
    readFiles: new Set<string>(),
    fileMtimes: new Map<string, number>(),
    fileHashes: new Map<string, string>(),
    writtenFiles: new Set<string>(),
    sideEffects: [],
    hasRead(p: string) {
      return this.readFiles.has(p);
    },
    hasWritten(p: string) {
      return (this as { writtenFiles: Set<string> }).writtenFiles.has(p);
    },
    lastReadMtime(p: string) {
      return this.fileMtimes.get(p);
    },
    lastReadHash(p: string) {
      return (this as { fileHashes: Map<string, string> }).fileHashes.get(p);
    },
    recordRead(p: string, m: number, source: 'user' | 'write' = 'user', contentHash?: string) {
      // Mirrors the real Context semantics: a hash-less record with a new
      // mtime drops the stored hash (content may have changed under us).
      const hashes = (this as { fileHashes: Map<string, string> }).fileHashes;
      if (contentHash !== undefined) {
        hashes.set(p, contentHash);
      } else if (this.fileMtimes.get(p) !== m) {
        hashes.delete(p);
      }
      this.fileMtimes.set(p, m);
      if (source === 'write') {
        (this as { writtenFiles: Set<string> }).writtenFiles.add(p);
      } else {
        this.readFiles.add(p);
      }
    },
    recordSideEffect(se: unknown) {
      (this as { sideEffects: unknown[] }).sideEffects.push(se);
    },
    clearFileTracking() {
      this.readFiles.clear();
      this.fileMtimes.clear();
      (this as { fileHashes: Map<string, string> }).fileHashes.clear();
      (this as { sideEffects: unknown[] }).sideEffects = [];
    },
    todos,
    meta: {},
    // Board and ledger writes are stamped with the owning session, same as a
    // real Context derives it from `session.id`.
    eventSessionId: () => 'test',
    session: {
      id: 'test',
      append: async () => undefined,
      close: async () => undefined,
      recordFileChange: () => {},
      recordSideEffect: () => {},
    },
    messages,
  } as never as Context;
  (ctx as never as { state: Pick<Context['state'], 'replaceMessages' | 'replaceTodos'> }).state = {
    replaceMessages(next) {
      messages.length = 0;
      messages.splice(0, 0, ...next);
    },
    replaceTodos(next) {
      todos.length = 0;
      todos.splice(0, 0, ...next);
    },
  };
  return {
    dir,
    ctx,
    cleanup: async () => fs.rm(dir, { recursive: true, force: true }),
  };
}

export function newSignal(): AbortSignal {
  return new AbortController().signal;
}
