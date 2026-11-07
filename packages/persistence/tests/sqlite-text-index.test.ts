import { describe, expect, it } from 'vitest';
import { loadRuntimeDatabaseSync } from '../src/sqlite-runtime.js';
import { initializeSqliteTextIndex, withSqliteTextIndex } from '../src/sqlite-text-index.js';

const index = {
  table: 'records',
  key: 'id',
  source: 'data',
  field: 'text',
  column: 'unicode_text',
};

describe('SQLite Unicode text index', () => {
  it('recomputes cached folds when another host uses a different locale', () => {
    const Database = loadRuntimeDatabaseSync();
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE records(id TEXT PRIMARY KEY, data TEXT NOT NULL)');
      initializeSqliteTextIndex(db, index);
      db.prepare('INSERT INTO records(id,data) VALUES (?,?)').run(
        'city',
        JSON.stringify({ text: 'İstanbul' }),
      );
      const read = (locale: string) =>
        withSqliteTextIndex(
          db.prepare.bind(db),
          { ...index, revision: locale },
          (value) => String(value).toLocaleLowerCase(locale),
          () => db.prepare('SELECT unicode_text FROM records').get(),
        );
      expect(read('en')).toEqual({ unicode_text: 'i\u0307stanbul' });
      expect(read('tr')).toEqual({ unicode_text: 'istanbul' });
      expect(read('en')).toEqual({ unicode_text: 'i\u0307stanbul' });
    } finally {
      db.close();
    }
  });

  it('invalidates cached revision folds when revision is subsequently omitted and matches existing columns case-insensitively (F655)', () => {
    const Database = loadRuntimeDatabaseSync();
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE records(id TEXT PRIMARY KEY, data TEXT NOT NULL, UNICODE_TEXT TEXT)');
      expect(() => initializeSqliteTextIndex(db, index)).not.toThrow();
      db.prepare('INSERT INTO records(id,data) VALUES (?,?)').run(
        'city',
        JSON.stringify({ text: 'İstanbul' }),
      );
      expect(
        withSqliteTextIndex(
          db.prepare.bind(db),
          { ...index, revision: 'tr' },
          (value) => String(value).toLocaleLowerCase('tr'),
          () => db.prepare('SELECT unicode_text AS unicode_text FROM records').get(),
        ),
      ).toEqual({ unicode_text: 'istanbul' });

      expect(
        withSqliteTextIndex(
          db.prepare.bind(db),
          index,
          (value) => String(value).toLocaleLowerCase('en'),
          () => db.prepare('SELECT unicode_text AS unicode_text FROM records').get(),
        ),
      ).toEqual({ unicode_text: 'i\u0307stanbul' });
    } finally {
      db.close();
    }
  });
  it('migrates existing rows and refreshes text changed by older writers', () => {
    const Database = loadRuntimeDatabaseSync();
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE records(id TEXT PRIMARY KEY, data TEXT NOT NULL)');
      const insert = db.prepare('INSERT INTO records(id,data) VALUES (?,?)');
      insert.run('old', JSON.stringify({ text: 'ŞİRKET Ａ' }));
      initializeSqliteTextIndex(db, index);
      initializeSqliteTextIndex(db, index);
      const read = (needle: string) =>
        withSqliteTextIndex(
          db.prepare.bind(db),
          index,
          (value) => String(value).normalize('NFKC').toLowerCase(),
          () => db.prepare('SELECT id FROM records WHERE unicode_text LIKE ?').all(`%${needle}%`),
        );
      expect(read('şi̇rket a')).toEqual([{ id: 'old' }]);
      db.prepare('UPDATE records SET data=? WHERE id=?').run(
        JSON.stringify({ text: 'ÜRETİM' }),
        'old',
      );
      expect(read('şi̇rket')).toEqual([]);
      expect(read('üreti̇m')).toEqual([{ id: 'old' }]);
      insert.run('new', JSON.stringify({ text: 'ÇAĞRI' }));
      expect(read('çağri')).toEqual([{ id: 'new' }]);
    } finally {
      db.close();
    }
  });

  it('rolls back a failed refresh without consuming an outer transaction', () => {
    const Database = loadRuntimeDatabaseSync();
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE records(id TEXT PRIMARY KEY, data TEXT NOT NULL)');
      initializeSqliteTextIndex(db, index);
      db.exec('BEGIN');
      db.prepare('INSERT INTO records(id,data) VALUES (?,?)').run(
        'outer',
        JSON.stringify({ text: 'HELLO' }),
      );
      expect(() =>
        withSqliteTextIndex(db.prepare.bind(db), index, String, () => {
          throw new Error('read failed');
        }),
      ).toThrow('read failed');
      expect(db.isTransaction).toBe(true);
      expect(db.prepare('SELECT unicode_text FROM records WHERE id=?').get('outer')).toEqual({
        unicode_text: null,
      });
      db.exec('COMMIT');
      expect(db.prepare('SELECT id FROM records').all()).toEqual([{ id: 'outer' }]);
    } finally {
      db.close();
    }
  });

  it('preserves the primary error if savepoint rollback/release fails after savepoint loss', () => {
    const Database = loadRuntimeDatabaseSync();
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE records(id TEXT PRIMARY KEY, data TEXT NOT NULL)');
      initializeSqliteTextIndex(db, index);
      const primaryError = new Error('primary read callback error');
      expect(() =>
        withSqliteTextIndex(db.prepare.bind(db), index, String, () => {
          db.exec('RELEASE ws_text_index');
          throw primaryError;
        }),
      ).toThrow(primaryError);
    } finally {
      db.close();
    }
  });

  it('replaces stale triggers when source or field changes and coerces nullish fold results so rows are not re-folded on every read (F768)', () => {
    const Database = loadRuntimeDatabaseSync();
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE records(id TEXT PRIMARY KEY, data TEXT NOT NULL)');
      const titleIndex = {
        table: 'records',
        key: 'id',
        source: 'data',
        field: 'title',
        column: 'unicode_text',
      };
      initializeSqliteTextIndex(db, titleIndex);
      db.prepare('INSERT INTO records(id, data) VALUES (?, ?)').run(
        'r1',
        JSON.stringify({ title: 'Alpha', summary: 'First Summary' }),
      );
      const fold = (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : '');
      expect(
        withSqliteTextIndex(db.prepare.bind(db), titleIndex, fold, () => {
          return db.prepare('SELECT unicode_text FROM records WHERE id=?').get('r1');
        }),
      ).toEqual({ unicode_text: 'alpha' });

      // Evolve index to watch 'summary' instead of 'title'
      const summaryIndex = {
        table: 'records',
        key: 'id',
        source: 'data',
        field: 'summary',
        column: 'unicode_text',
      };
      initializeSqliteTextIndex(db, summaryIndex);
      db.prepare('UPDATE records SET data=? WHERE id=?').run(
        JSON.stringify({ title: 'Alpha', summary: 'Updated Summary' }),
        'r1',
      );
      expect(
        withSqliteTextIndex(db.prepare.bind(db), summaryIndex, fold, () => {
          return db.prepare('SELECT unicode_text FROM records WHERE id=?').get('r1');
        }),
      ).toEqual({ unicode_text: 'updated summary' });

      // Nullish return from fold() is coerced to '' so the row does not remain NULL
      db.prepare('INSERT INTO records(id, data) VALUES (?, ?)').run('r-missing', '{}');
      let foldCalls = 0;
      const nullishFold = (value: unknown) => {
        if (value == null) {
          foldCalls += 1;
          return null as unknown as string;
        }
        return String(value).toLowerCase();
      };
      withSqliteTextIndex(db.prepare.bind(db), summaryIndex, nullishFold, () => null);
      withSqliteTextIndex(db.prepare.bind(db), summaryIndex, nullishFold, () => null);
      expect(foldCalls).toBe(1);
    } finally {
      db.close();
    }
  });

  it('replaces stale triggers when JSON field casing or key column changes (F33)', () => {
    const Database = loadRuntimeDatabaseSync();
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE docs(id TEXT PRIMARY KEY, doc_id TEXT UNIQUE, payload TEXT NOT NULL)');
      const indexV1 = {
        table: 'docs',
        key: 'id',
        source: 'payload',
        field: 'Title',
        column: 'folded_title',
      };
      initializeSqliteTextIndex(db, indexV1);
      db.prepare('INSERT INTO docs(id, doc_id, payload) VALUES (?, ?, ?)').run(
        '1',
        'd-1',
        JSON.stringify({ Title: 'Legacy Title', title: 'Initial Lowercase' }),
      );
      const fold = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '');
      expect(
        withSqliteTextIndex(db.prepare.bind(db), indexV1, fold, () =>
          db.prepare('SELECT folded_title FROM docs WHERE id = ?').get('1'),
        ),
      ).toEqual({ folded_title: 'legacy title' });

      const indexV2 = {
        table: 'docs',
        key: 'doc_id',
        source: 'payload',
        field: 'title',
        column: 'folded_title',
      };
      initializeSqliteTextIndex(db, indexV2);
      db.prepare('UPDATE docs SET payload = ? WHERE doc_id = ?').run(
        JSON.stringify({ Title: 'Legacy Title', title: 'Updated Lowercase' }),
        'd-1',
      );
      expect(
        withSqliteTextIndex(db.prepare.bind(db), indexV2, fold, () =>
          db.prepare('SELECT folded_title FROM docs WHERE doc_id = ?').get('d-1'),
        ),
      ).toEqual({ folded_title: 'updated lowercase' });
    } finally {
      db.close();
    }
  });
});
