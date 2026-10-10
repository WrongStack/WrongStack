import { type SqliteTextIndex, withSqliteTextIndex } from '@wrongstack/persistence';

export const sageTextIndex: SqliteTextIndex = {
  table: 'memories',
  key: 'id',
  source: 'data',
  field: 'text',
  column: 'unicode_text',
  revision: 'nfkc-lower-v1',
};

export function withSageTextIndex<T>(
  stmt: Parameters<typeof withSqliteTextIndex>[0],
  read: () => T,
): T {
  return withSqliteTextIndex(
    stmt,
    sageTextIndex,
    (value) => (typeof value === 'string' ? value.normalize('NFKC').toLowerCase() : ''),
    read,
  );
}
