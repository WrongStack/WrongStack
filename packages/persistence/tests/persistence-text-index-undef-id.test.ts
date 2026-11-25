import { describe, expect, it } from 'vitest';
import { initializeSqliteTextIndex } from '../src/sqlite-text-index.js';

describe('initializeSqliteTextIndex non-string identifier guard', () => {
  it('rejects undefined identifier fields instead of coercing them to "undefined"', () => {
    let sqlExecuted = false;
    const fakeDb = {
      prepare: () => {
        sqlExecuted = true;
        return { all: () => [], get: () => undefined };
      },
      exec: () => {
        sqlExecuted = true;
      },
    } as never;

    expect(() =>
      initializeSqliteTextIndex(fakeDb, {
        table: 'items',
        key: 'id',
        source: 'json',
        field: undefined as never,
        column: 'idx',
      }),
    ).toThrow(/Invalid SQLite text index identifier/);
    expect(sqlExecuted).toBe(false);
  });
});
