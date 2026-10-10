import { describe, expect, it, vi } from 'vitest';
import { isRuntimeSqliteAvailable, loadRuntimeDatabaseSync } from '../src/sqlite-runtime.js';

describe('runtime SQLite compatibility', () => {
  it('invalidates retained statements and releases a real database file on close', () => {
    const root = mkdtempSync(join(tmpdir(), 'wrongstack-sqlite-close-'));
    const Database = loadRuntimeDatabaseSync();
    const db = new Database(join(root, 'store.sqlite'));
    const statement = db.prepare('SELECT 42 AS value');
    expect(statement.get()).toMatchObject({ value: 42 });
    db.close();
    expect(() => statement.get()).toThrow();
    rmSync(root, { recursive: true });
  });

  it('returns undefined for a missing row and tracks transaction state', () => {
    const Database = loadRuntimeDatabaseSync();
    const db = new Database(':memory:');
    try {
      expect(db.isOpen).toBe(true);
      expect(db.prepare('SELECT 1 WHERE 0').get()).toBeUndefined();
      db.exec('BEGIN');
      expect(db.isTransaction).toBe(true);
      db.exec('ROLLBACK');
      expect(db.isTransaction).toBe(false);
    } finally {
      db.close();
    }
    expect(db.isOpen).toBe(false);
  });
  it('finalizes outstanding statements when closing the native Bun fallback', () => {
    const close = vi.fn();
    class BunDatabase {
      close = close;
    }
    const Database = loadRuntimeDatabaseSync((specifier) => {
      if (specifier === 'node:sqlite') throw new Error('missing node builtin');
      return { Database: BunDatabase };
    });
    const db = new Database('store.db');
    db.close();
    expect(close).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('uses node:sqlite when DatabaseSync is available', () => {
    class NodeDatabase {}
    const load = vi.fn((specifier: string) => {
      if (specifier === 'node:sqlite') return { DatabaseSync: NodeDatabase };
      throw new Error(`unexpected module: ${specifier}`);
    });

    expect(loadRuntimeDatabaseSync(load)).toBe(NodeDatabase);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('adapts bun:sqlite and translates the read-only constructor option', () => {
    const opened: Array<{ filename: string; options: unknown }> = [];
    class BunDatabase {
      constructor(filename: string, options?: unknown) {
        opened.push({ filename, options });
      }
    }
    const load = (specifier: string) => {
      if (specifier === 'node:sqlite') throw new Error('missing node builtin');
      if (specifier === 'bun:sqlite') return { Database: BunDatabase };
      throw new Error(`unexpected module: ${specifier}`);
    };

    const Database = loadRuntimeDatabaseSync(load);
    const writable = new Database('write.db');
    const readonly = new Database('read.db', { readOnly: true });

    expect(writable).toBeInstanceOf(BunDatabase);
    expect(readonly).toBeInstanceOf(BunDatabase);
    expect(opened).toEqual([
      { filename: 'write.db', options: undefined },
      { filename: 'read.db', options: { readonly: true, create: false, readwrite: false } },
    ]);
  });

  it('reports unavailable only after both runtime modules fail', () => {
    const load = vi.fn(() => {
      throw new Error('missing');
    });

    expect(isRuntimeSqliteAvailable(load)).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
    expect(() => loadRuntimeDatabaseSync(load)).toThrow(/node:sqlite.*bun:sqlite/u);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
