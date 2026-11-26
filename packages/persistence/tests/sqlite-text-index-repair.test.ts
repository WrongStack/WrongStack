import { expect, it, vi } from 'vitest';
import { loadRuntimeDatabaseSync } from '../src/sqlite-runtime.js';
import { initializeSqliteTextIndex, withSqliteTextIndex } from '../src/sqlite-text-index.js';

const index = { table: 'records', key: 'id', source: 'payload', field: 'title', column: 'folded' };

it.each([false, true])(
  'reads fresh indexed text after initialization (trigger missing: %s)',
  (missing) => {
    const Database = loadRuntimeDatabaseSync();
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE records(id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
      initializeSqliteTextIndex(db, index);
      db.prepare('INSERT INTO records(id,payload) VALUES (?,?)').run('record', '{"title":"Old"}');
      const fold = vi.fn((value: unknown) => String(value).toLowerCase());
      const search = (query: string) =>
        withSqliteTextIndex(db.prepare.bind(db), index, fold, () =>
          db.prepare('SELECT id FROM records WHERE folded=?').all(query),
        );
      expect(search('old')).toEqual([{ id: 'record' }]);
      expect(fold).toHaveBeenCalledTimes(1);
      if (missing) db.exec('DROP TRIGGER records_folded_invalidate');
      const update = db.prepare('UPDATE records SET payload=? WHERE id=?');
      update.run('{"title":"New"}', 'record');
      if (!missing) expect(search('new')).toEqual([{ id: 'record' }]);
      fold.mockClear();

      initializeSqliteTextIndex(db, index);
      expect(search('new')).toEqual([{ id: 'record' }]);
      expect(search('old')).toEqual([]);
      expect(fold).toHaveBeenCalledTimes(missing ? 1 : 0);

      update.run('{"title":"Final"}', 'record');
      expect(search('final')).toEqual([{ id: 'record' }]);
      expect(search('new')).toEqual([]);
    } finally {
      db.close();
    }
  },
);
