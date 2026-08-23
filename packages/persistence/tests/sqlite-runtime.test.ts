import { describe, expect, it, vi } from 'vitest';
import { isRuntimeSqliteAvailable, loadRuntimeDatabaseSync } from '../src/sqlite-runtime.js';

describe('runtime SQLite compatibility', () => {
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
