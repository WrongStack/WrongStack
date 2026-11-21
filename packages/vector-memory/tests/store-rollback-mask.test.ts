import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const roots: string[] = [];

/**
 * Controls the faulting database. `vi.hoisted` so the `vi.mock` factory below
 * (hoisted above the imports) can read the same object.
 */
const fault = vi.hoisted(() => ({
  failWrites: true,
  failCommits: false,
  primary: 'PRIMARY: provider metadata write failed',
}));

vi.mock('@wrongstack/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/persistence')>();

  class FaultingDatabase {
    exec(sql: string): void {
      const statement = sql.trim().toUpperCase();
      // SQLite can end the transaction when a write or COMMIT fails; the
      // follow-up ROLLBACK then throws `cannot rollback - no transaction is
      // active`. That is the error a caller must never see in place of the
      // primary failure.
      if (statement === 'ROLLBACK') throw new Error('SECONDARY: no transaction is active');
      if (statement.startsWith('COMMIT') && fault.failCommits) throw new Error(fault.primary);
    }

    prepare(): {
      run: () => { changes: number };
      get: () => undefined;
      all: () => unknown[];
    } {
      return {
        run: () => {
          if (fault.failWrites) throw new Error(fault.primary);
          return { changes: 1 };
        },
        get: () => undefined,
        all: () => [],
      };
    }
  }

  return { ...actual, loadRuntimeDatabaseSync: () => FaultingDatabase };
});

import { VectorMemoryStore } from '../src/store.js';

function projectRoot(label: string): string {
  const root = join(tmpdir(), `wrongstack-vector-rollback-${label}-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

const provider = {
  id: 'proof-provider',
  dimensions: 4,
  embed: async () => [new Float32Array([1, 2, 3, 4])],
};

/** A store whose constructor succeeds, so a later transaction can fail. */
function healthyStore(label: string): VectorMemoryStore {
  fault.failWrites = false;
  try {
    return new VectorMemoryStore({ projectRoot: projectRoot(label), provider });
  } finally {
    fault.failWrites = true;
  }
}

beforeEach(() => {
  fault.failWrites = true;
  fault.failCommits = false;
  fault.primary = 'PRIMARY: provider metadata write failed';
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('VectorMemoryStore transaction failure reporting', () => {
  it('preserves the provider-metadata write error when rollback also fails', () => {
    expect(
      () =>
        new VectorMemoryStore({
          projectRoot: projectRoot('victim'),
          provider,
        }),
    ).toThrow('PRIMARY: provider metadata write failed');
  });

  it('rejects a missing provider before opening the database', () => {
    expect(
      () =>
        new VectorMemoryStore({
          projectRoot: projectRoot('control'),
          provider: undefined as never,
        }),
    ).toThrow('provider is required');
  });

  it('preserves the remember() commit error when rollback also fails', async () => {
    const store = healthyStore('remember');
    fault.failCommits = true;
    fault.primary = 'PRIMARY: entries commit failed';
    await expect(store.remember({ text: 'a memory that failed to commit' })).rejects.toThrow(
      'PRIMARY: entries commit failed',
    );
  });

  it('preserves the forget() commit error when rollback also fails', async () => {
    const store = healthyStore('forget');
    fault.failCommits = true;
    fault.primary = 'PRIMARY: delete commit failed';
    await expect(store.forget('entry-1')).rejects.toThrow('PRIMARY: delete commit failed');
  });
});
