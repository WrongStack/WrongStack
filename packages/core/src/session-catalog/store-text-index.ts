import type { SqliteTextIndex } from '@wrongstack/persistence';

export const catalogTitleIndex: SqliteTextIndex = {
  table: 'sessions',
  key: 'session_id',
  source: 'summary_json',
  field: 'title',
  column: 'unicode_title',
  revision: `locale-lower-v1:${new Intl.Collator().resolvedOptions().locale}`,
};
