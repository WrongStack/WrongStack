import { inListChunks, ladderChunkSizes, padToInBucket, placeholders } from './writer-helpers.js';
import { LANG_FAMILY_WILDCARD } from './writer-schema.js';

export const FAMILY_MATCH_SQL = `(
  sym.lang = refs.lang
  OR EXISTS (
    SELECT 1 FROM lang_family lf1
      JOIN lang_family lf2 ON lf1.family = lf2.family
     WHERE lf1.lang = sym.lang AND lf2.lang = refs.lang
  )
  OR ? IN (
    SELECT family FROM lang_family WHERE lang = refs.lang
  )
)`;

export function getNamespaceDeclarationsWithStatement(
  stmtFn: (sql: string) => { all: () => unknown[] },
): Array<{ name: string; file: string }> {
  return stmtFn(
    `SELECT name, file FROM symbols WHERE kind = 'namespace' ORDER BY file, id`,
  ).all() as Array<{ name: string; file: string }>;
}

export function getFilePackagesWithStatement(
  stmtFn: (sql: string) => { all: () => unknown[] },
): Map<string, string> {
  const rows = stmtFn("SELECT file, package FROM files WHERE package != ''").all() as Array<{
    file: string;
    package: string;
  }>;
  return new Map(rows.map((row) => [row.file, row.package]));
}

export function getUnresolvedImportsWithStatement(
  stmtFn: (sql: string) => { all: (...args: (string | number)[]) => unknown[] },
  maxSqlVars: number,
  onlyFiles?: readonly string[],
): Array<{
  fromFile: string;
  lang: string;
  module: string;
}> {
  const base = `SELECT DISTINCT s.file AS fromFile, r.lang AS lang, r.module AS module
                  FROM refs r
                  JOIN symbols s ON s.id = r.from_id
                 WHERE r.call_type = 'import' AND r.module IS NOT NULL`;
  if (!onlyFiles?.length) {
    return stmtFn(base).all() as Array<{ fromFile: string; lang: string; module: string }>;
  }
  const out: Array<{ fromFile: string; lang: string; module: string }> = [];
  // P4.12: ladder + padded buckets — distinct SQL strings ≤ log2(max)+1.
  let cursor = 0;
  for (const take of inListChunks(onlyFiles.length, maxSqlVars)) {
    const chunk = padToInBucket(onlyFiles.slice(cursor, cursor + take));
    cursor += take;
    out.push(
      ...(stmtFn(`${base} AND s.file IN (${placeholders(chunk.length)})`).all(...chunk) as Array<{
        fromFile: string;
        lang: string;
        module: string;
      }>),
    );
  }
  return out;
}

export function getAllResolvedRefsWithStatement(
  stmtFn: (sql: string) => { all: () => unknown[] },
): Array<{
  fromId: number;
  toId: number;
  callType: string;
}> {
  return stmtFn(
    'SELECT from_id AS fromId, to_id AS toId, call_type AS callType FROM refs WHERE to_id IS NOT NULL',
  ).all() as Array<{ fromId: number; toId: number; callType: string }>;
}

export function getAllImportRefsWithStatement(
  stmtFn: (sql: string) => { all: () => unknown[] },
): Array<{
  sourceFile: string | null;
  toName: string;
  toId: number | null;
  callType: string;
  line: number;
}> {
  return stmtFn(
    `SELECT s.file AS sourceFile, r.to_name AS toName, r.to_id AS toId,
            r.call_type AS callType, r.line
     FROM refs r
     LEFT JOIN symbols s ON r.from_id = s.id
     WHERE r.call_type = 'import'
     ORDER BY r.line`,
  ).all() as Array<{
    sourceFile: string | null;
    toName: string;
    toId: number | null;
    callType: string;
    line: number;
  }>;
}

export function resolveRefsWithStatement(
  stmtFn: (sql: string) => { run: (...args: (string | number)[]) => unknown },
): number {
  try {
    const result = stmtFn(
      `UPDATE refs
       SET to_id = s.id
       FROM (
             SELECT sym.name AS name, lf.family AS family, MIN(sym.id) AS id
               FROM symbols sym
               JOIN lang_family lf ON lf.lang = sym.lang
              GROUP BY sym.name, lf.family
             UNION ALL
             SELECT sym.name AS name, '${LANG_FAMILY_WILDCARD}' AS family, MIN(sym.id) AS id
               FROM symbols sym
              GROUP BY sym.name
           ) AS s,
           lang_family AS rf
       WHERE refs.to_id IS NULL
         AND refs.to_name IS NOT NULL
         AND rf.lang = refs.lang
         AND s.name = refs.to_name
         AND s.family = rf.family`,
    ).run() as { changes?: number };
    return result.changes ?? 0;
  } catch {
    const result = stmtFn(
      `UPDATE refs SET to_id = (
         SELECT sym.id FROM symbols sym
          WHERE sym.name = refs.to_name AND ${FAMILY_MATCH_SQL}
          ORDER BY sym.id LIMIT 1
       ) WHERE to_id IS NULL AND to_name IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM symbols sym
            WHERE sym.name = refs.to_name AND ${FAMILY_MATCH_SQL}
         )`,
    ).run(LANG_FAMILY_WILDCARD, LANG_FAMILY_WILDCARD) as { changes?: number };
    return result.changes ?? 0;
  }
}

export function applyImportResolutionsWithStatement(
  db: { exec: (sql: string) => unknown },
  stmtFn: (sql: string) => { run: (...args: string[]) => unknown },
  runWithRetry: <T>(fn: () => T) => T,
  maxSqlVars: number,
  resolutions: ReadonlyArray<{ fromFile: string; lang: string; module: string; toFile: string }>,
): number {
  if (resolutions.length === 0) return 0;
  return runWithRetry(() => {
    db.exec('DROP TABLE IF EXISTS temp.import_resolution');
    db.exec(
      `CREATE TEMP TABLE import_resolution (
         from_file TEXT NOT NULL,
         lang TEXT NOT NULL,
         module TEXT NOT NULL,
         to_file TEXT NOT NULL
       )`,
    );
    const chunkSize = Math.max(1, Math.floor(maxSqlVars / 4));
    // P4.12: ladder chunking so the INSERT INTO temp.import_resolution
    // statement resolves to ≤ log2(chunkSize)+1 distinct SQL strings.
    let cursor = 0;
    for (const take of ladderChunkSizes(resolutions.length, chunkSize)) {
      const chunk = resolutions.slice(cursor, cursor + take);
      cursor += take;
      const valuesPh = chunk.map(() => '(?, ?, ?, ?)').join(', ');
      const binds: string[] = [];
      for (const entry of chunk) {
        binds.push(entry.fromFile, entry.lang, entry.module, entry.toFile);
      }
      stmtFn(
        `INSERT INTO temp.import_resolution(from_file, lang, module, to_file)
         VALUES ${valuesPh}`,
      ).run(...binds);
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS temp.idx_ir
         ON import_resolution(module, lang, from_file)`,
    );

    const result = stmtFn(
      `UPDATE refs
          SET to_file = (
            SELECT ir.to_file
              FROM temp.import_resolution ir
              JOIN symbols s ON s.id = refs.from_id
             WHERE ir.module = refs.module
               AND ir.lang = refs.lang
               AND ir.from_file = s.file
             LIMIT 1
          )
        WHERE refs.call_type = 'import'
          AND refs.module IS NOT NULL
          AND EXISTS (
            SELECT 1
              FROM temp.import_resolution ir
              JOIN symbols s ON s.id = refs.from_id
             WHERE ir.module = refs.module
               AND ir.lang = refs.lang
               AND ir.from_file = s.file
          )`,
    ).run() as { changes?: number };
    db.exec('DROP TABLE IF EXISTS temp.import_resolution');
    return result.changes ?? 0;
  });
}

export function resolveRefsForNamesUnsafe(
  stmtFn: (sql: string) => { run: (...args: (string | number)[]) => unknown },
  maxSqlVars: number,
  names: Iterable<string>,
): number {
  const list = [...names].filter((name) => name.length > 0);
  if (list.length === 0) return 0;
  let total = 0;
  // P4.12: ladder + padded buckets. One padded array feeds EVERY IN-list in
  // both statements (primary uses it 3×, fallback 1× between two FAMILY
  // binds) — placeholder count and bind count stay in lockstep by
  // construction, which the FAMILY_MATCH_SQL contract requires.
  let cursor = 0;
  for (const take of inListChunks(list.length, maxSqlVars)) {
    const chunk = padToInBucket(list.slice(cursor, cursor + take));
    cursor += take;
    const ph = placeholders(chunk.length);
    try {
      const result = stmtFn(
        `UPDATE refs
         SET to_id = s.id
         FROM (
               SELECT sym.name AS name, lf.family AS family, MIN(sym.id) AS id
                 FROM symbols sym
                 JOIN lang_family lf ON lf.lang = sym.lang
                WHERE sym.name IN (${ph})
                GROUP BY sym.name, lf.family
               UNION ALL
               SELECT sym.name AS name, '${LANG_FAMILY_WILDCARD}' AS family, MIN(sym.id) AS id
                 FROM symbols sym
                WHERE sym.name IN (${ph})
                GROUP BY sym.name
             ) AS s,
             lang_family AS rf
         WHERE refs.to_name IN (${ph})
           AND rf.lang = refs.lang
           AND s.name = refs.to_name
           AND s.family = rf.family`,
      ).run(...chunk, ...chunk, ...chunk) as { changes?: number };
      total += result.changes ?? 0;
    } catch {
      const result = stmtFn(
        `UPDATE refs SET to_id = (
           SELECT sym.id FROM symbols sym
            WHERE sym.name = refs.to_name AND ${FAMILY_MATCH_SQL}
            ORDER BY sym.id LIMIT 1
         ) WHERE refs.to_name IN (${ph})
           AND EXISTS (
             SELECT 1 FROM symbols sym
              WHERE sym.name = refs.to_name AND ${FAMILY_MATCH_SQL}
           )`,
      ).run(LANG_FAMILY_WILDCARD, ...chunk, LANG_FAMILY_WILDCARD) as {
        changes?: number;
      };
      total += result.changes ?? 0;
    }
  }
  return total;
}
