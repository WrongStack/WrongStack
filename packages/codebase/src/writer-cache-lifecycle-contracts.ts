import { REFS_INDEX_SQL, SYMBOL_INDEX_SQL } from './writer-schema.js';

/** Index names declared by the symbols/refs index DDL. */
export function secondaryIndexNames(): string[] {
  const names: string[] = [];
  for (const sql of [...SYMBOL_INDEX_SQL, ...REFS_INDEX_SQL]) {
    const match = /CREATE INDEX IF NOT EXISTS (\w+)/.exec(sql);
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

export const MAX_STATEMENT_CACHE = 128;
