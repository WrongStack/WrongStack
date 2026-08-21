# Finding: String-interpolated SQL constants — safe today, fragile pattern

**Severity:** Low (hardening)
**Category:** Security hardening / Maintainability

## Description

The SAGE SQLite store builds some SQL fragments by interpolating constants directly into query strings instead of using placeholders. The interpolated values are compile-time module constants, so there is **no injection vulnerability today**. However, the pattern normalizes string-built SQL: a future refactor that turns a constant into a computed value (e.g. a configurable prefix length or glob) would silently become an injection sink without any test failing.

## Evidence

Verified by reading `packages/sage/src/sqlite-store-retrieve-path.ts`:

Lines 68–85:

```ts
`SELECT DISTINCT m.data
 FROM memories m
 WHERE m.id IN (
     SELECT SUBSTR(e.from_node, ${MEMORY_NODE_PREFIX_LEN + 1})
     FROM edges e
     WHERE e.from_node GLOB '${MEMORY_NODE_GLOB}'
       AND (
         e.to_node IN (${targetPlaceholders})
         ${globClause}
       )
 )
 AND m.status IN ('active', 'stale')
 ${session.clause}
 ${audienceEdgeClause}
 ORDER BY m.importance DESC, m.updated_at DESC
 LIMIT ?`
```

- `MEMORY_NODE_PREFIX_LEN` and `MEMORY_NODE_GLOB` are module-level constants (safe).
- `targetPlaceholders`, `globClause`, `session.clause`, `audienceEdgeClause` are placeholder-based and parameterized via `.all(...)` at line 85 (safe).

Similarly, `packages/tools/src/codebase-index/writer-bulk-insert.ts:67,89` builds `VALUES ${placeholders}` where `placeholders` is generated `?` markers only — parameterized correctly.

A related dynamic-SQL site, `packages/sage/src/sqlite-store-search.ts:204` (`SELECT COUNT(*) AS n FROM memories` + `sharedWhereSql`), also composes from parameterized clause builders.

## Proposed remediation

1. Add a short comment contract on each SQL-building helper stating "interpolations must be compile-time constants or `?`-placeholder generators only".
2. Add a unit test asserting that `MEMORY_NODE_GLOB` contains no quote characters (`'`, `"`) so a future edit that makes it configurable fails loudly.
3. Optionally centralize these constant interpolations into named fragment builders (the repo already has `sqlite-store-search-helpers.ts` as the right home), so review of dynamic SQL happens in one file.
