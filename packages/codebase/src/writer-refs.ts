import { allRowsAsArrays } from './sqlite-runtime.js';
import { inListChunks, ladderChunkSizes, padToInBucket, placeholders } from './writer-helpers.js';
import { LANG_FAMILY_WILDCARD } from './writer-schema.js';

export const FAMILY_MATCH_SQL = `(
  sym.lang = refs.lang
  OR refs.lang = ''
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
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.file, row.package);
  }
  return map;
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
  // ~180k rows feed every wiring-graph build (rank pass, first context query
  // after an edit): read as arrays, which node:sqlite produces in well under
  // half the time of its per-row objects, and shaped here.
  const rows = allRowsAsArrays(
    stmtFn('SELECT from_id, to_id, call_type FROM refs WHERE to_id IS NOT NULL'),
  ) as Array<[number, number, string]>;
  const out = new Array<{ fromId: number; toId: number; callType: string }>(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const [fromId, toId, callType] = rows[i] as [number, number, string];
    out[i] = { fromId, toId, callType };
  }
  return out;
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

/**
 * Refs the name-based resolvers leave alone, as a WHERE term over `refs`
 * (`rf` = the ref's lang_family row). Both are owned by the import-aware
 * binding pass (ref-binding-pass.ts): `to_file = ''` marks a name bound to a
 * module outside the index, whose answer is "nothing in this project", and a
 * JS-family import's `to_id` is the export it names in its resolved module.
 * A name guess for either would reintroduce the homonym the binding removed.
 */
const BOUND_ELSEWHERE_SQL = `(refs.to_file IS NULL OR refs.to_file <> '')
         AND NOT (refs.call_type = 'import' AND refs.module IS NOT NULL AND rf.family = 'js')`;
/** {@link BOUND_ELSEWHERE_SQL} for the fallback forms, which have no `rf`. */
const BOUND_ELSEWHERE_FALLBACK_SQL = `(refs.to_file IS NULL OR refs.to_file <> '')
         AND NOT (refs.call_type = 'import' AND refs.module IS NOT NULL
                  AND refs.lang IN (SELECT lang FROM lang_family WHERE family = 'js'))`;

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
         AND s.family = rf.family
         AND ${BOUND_ELSEWHERE_SQL}`,
    ).run() as { changes?: number };
    return result.changes ?? 0;
  } catch {
    const result = stmtFn(
      `UPDATE refs SET to_id = (
         SELECT sym.id FROM symbols sym
          WHERE sym.name = refs.to_name AND ${FAMILY_MATCH_SQL}
          ORDER BY sym.id LIMIT 1
       ) WHERE to_id IS NULL AND to_name IS NOT NULL
         AND ${BOUND_ELSEWHERE_FALLBACK_SQL}
         AND EXISTS (
           SELECT 1 FROM symbols sym
            WHERE sym.name = refs.to_name AND ${FAMILY_MATCH_SQL}
         )`,
    ).run(LANG_FAMILY_WILDCARD, LANG_FAMILY_WILDCARD) as { changes?: number };
    return result.changes ?? 0;
  }
}

/**
 * Importer files holding an import ref whose `to_file` is no longer indexed —
 * the target was deleted or renamed. A watcher run only re-resolves the files
 * it touched, and the importer of a deleted file is not one of them, so these
 * are added to its scope; otherwise the edge to the missing file survives.
 */
export function getFilesWithDanglingImportsWithStatement(
  stmtFn: (sql: string) => { all: () => unknown[] },
): string[] {
  return (
    stmtFn(
      `SELECT DISTINCT s.file AS file
         FROM refs r
         JOIN symbols s ON s.id = r.from_id
        WHERE r.call_type = 'import'
          AND r.to_file IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM files f WHERE f.file = r.to_file)`,
    ).all() as Array<{ file: string }>
  ).map((row) => row.file);
}

/**
 * Imports whose `to_file` is still unset, across the whole index.
 *
 * A file that appears can be the target of imports written long before it —
 * `import './foo'` stays unresolved until `foo.ts` exists. When a run adds
 * files, these are the only imports whose answer can have changed; every
 * resolved import still points at a file that exists.
 */
export function getImportsWithoutTargetWithStatement(
  stmtFn: (sql: string) => { all: () => unknown[] },
): Array<{ fromFile: string; lang: string; module: string }> {
  return stmtFn(
    `SELECT DISTINCT s.file AS fromFile, r.lang AS lang, r.module AS module
       FROM refs r
       JOIN symbols s ON s.id = r.from_id
      WHERE r.call_type = 'import' AND r.module IS NOT NULL AND +r.to_file IS NULL`,
  ).all() as Array<{ fromFile: string; lang: string; module: string }>;
}

/**
 * Files holding an import that resolved to one of `targets`. Scoped
 * counterpart of {@link getFilesWithDanglingImportsWithStatement} for a run
 * that knows exactly which files it deleted — it reaches the importers
 * through `idx_r_to_file` instead of scanning every import ref.
 */
export function getImportersOfFilesWithStatement(
  stmtFn: (sql: string) => { all: (...args: string[]) => unknown[] },
  maxSqlVars: number,
  targets: readonly string[],
): string[] {
  const out = new Set<string>();
  let cursor = 0;
  for (const take of inListChunks(targets.length, maxSqlVars)) {
    const bucket = padToInBucket(targets.slice(cursor, cursor + take));
    cursor += take;
    const rows = stmtFn(
      `SELECT DISTINCT s.file AS file
         FROM refs r
         JOIN symbols s ON s.id = r.from_id
        WHERE r.to_file IN (${placeholders(bucket.length)}) AND r.call_type = 'import'`,
    ).all(...bucket) as Array<{ file: string }>;
    for (const row of rows) out.add(row.file);
  }
  return [...out];
}

/**
 * Distinct [owner file, to_name] of every ref — import or bound call — whose
 * `to_file` is one of `targets`: what the import-aware binding pass must
 * revisit when those files change (ref-binding-pass.ts).
 */
export function getRefNamesTargetingWithStatement(
  stmtFn: (sql: string) => { all: (...args: string[]) => unknown[] },
  maxSqlVars: number,
  targets: readonly string[],
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let cursor = 0;
  for (const take of inListChunks(targets.length, maxSqlVars)) {
    const bucket = padToInBucket(targets.slice(cursor, cursor + take));
    cursor += take;
    const rows = allRowsAsArrays(
      stmtFn(
        `SELECT DISTINCT s.file, r.to_name
           FROM refs r
           JOIN symbols s ON s.id = r.from_id
          WHERE r.to_file IN (${placeholders(bucket.length)})`,
      ),
      ...(bucket as never[]),
    ) as Array<[string, string]>;
    for (const row of rows) out.push(row);
  }
  return out;
}

/** Resolution batches up to this size update entry by entry; see below. */
const PER_ENTRY_RESOLUTION_LIMIT = 2_000;

/**
 * Write module-resolution results. `toFile: null` records "re-resolved, no
 * target": it CLEARS a previous `to_file`. Only resolved entries used to be
 * written, so an import whose target had since been deleted kept pointing at
 * it through every later run, full reindex included.
 */
export function applyImportResolutionsWithStatement(
  db: { exec: (sql: string) => unknown },
  stmtFn: (sql: string) => { run: (...args: (string | null)[]) => unknown },
  runWithRetry: <T>(fn: () => T) => T,
  maxSqlVars: number,
  resolutionInput: ReadonlyArray<{
    fromFile: string;
    lang: string;
    module: string;
    toFile: string | null;
  }>,
): number {
  let resolutions = resolutionInput;
  if (resolutions.length === 0) return 0;
  // One row per (importer, lang, specifier): a duplicate would be written
  // twice, and the bulk statement's LIMIT 1 would pick between them.
  const unique = new Map<string, (typeof resolutions)[number]>();
  for (const entry of resolutions) {
    unique.set(`${entry.fromFile}\u0000${entry.lang}\u0000${entry.module}`, entry);
  }
  resolutions = [...unique.values()];
  // A watcher/edit run resolves a handful of imports. Each is two index
  // probes (the importer's symbols by file, their refs by id), whereas the
  // bulk statement below visits every import ref in the repository once —
  // ~600 ms on 70k imports, paid per one-file edit before this split.
  // `+column` keeps SQLite off the low-selectivity call_type/module indexes.
  if (resolutions.length <= PER_ENTRY_RESOLUTION_LIMIT) {
    return runWithRetry(() => {
      const update = stmtFn(
        `UPDATE refs SET to_file = ?
          WHERE from_id IN (SELECT id FROM symbols WHERE file = ?)
            AND +module = ? AND +lang = ? AND +call_type = 'import'`,
      );
      let changes = 0;
      for (const entry of resolutions) {
        const result = update.run(entry.toFile, entry.fromFile, entry.module, entry.lang) as {
          changes?: number;
        };
        changes += Number(result.changes ?? 0);
      }
      return changes;
    });
  }
  return runWithRetry(() => {
    db.exec('DROP TABLE IF EXISTS temp.import_resolution');
    db.exec(
      `CREATE TEMP TABLE import_resolution (
         from_file TEXT NOT NULL,
         lang TEXT NOT NULL,
         module TEXT NOT NULL,
         to_file TEXT
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
      const binds: (string | null)[] = [];
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

/**
 * Resolve the still-unresolved refs named `names`.
 *
 * Only `to_id IS NULL` rows are touched, and that is complete, not a
 * shortcut: a ref resolves to the MIN symbol id declaring its name, and ids
 * are allocated monotonically (`allocateSymbolIds`), so a newly inserted
 * declaration can never undercut an existing answer. The only way a resolved
 * ref's answer changes is its target being deleted, and every deletion path
 * NULLs those refs first (`invalidateIncomingRefsForFiles`). Re-updating the
 * resolved rows too rewrote every `push`/`get`/`map` ref in the repository on
 * each one-file edit.
 */
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
           AND refs.to_id IS NULL
           AND rf.lang = refs.lang
           AND s.name = refs.to_name
           AND s.family = rf.family
           AND ${BOUND_ELSEWHERE_SQL}`,
      ).run(...chunk, ...chunk, ...chunk) as { changes?: number };
      total += result.changes ?? 0;
    } catch {
      const result = stmtFn(
        `UPDATE refs SET to_id = (
           SELECT sym.id FROM symbols sym
            WHERE sym.name = refs.to_name AND ${FAMILY_MATCH_SQL}
            ORDER BY sym.id LIMIT 1
         ) WHERE refs.to_name IN (${ph})
           AND refs.to_id IS NULL
           AND ${BOUND_ELSEWHERE_FALLBACK_SQL}
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
