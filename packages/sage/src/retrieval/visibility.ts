/**
 * JS twin of the SQL visibility rules enforced by `searchSqliteSage` /
 * `materializeSageByIdFactory`.
 *
 * The SQL versions are the authority for the in-process store, where the
 * candidate never leaves SQLite. The client-side vector fusion has no such
 * luxury: when SAGE runs in the per-project daemon, the vector store lives in
 * the *host* process, so a vector-only hit is resolved by id through the port
 * (`getSage`) and must be re-checked here before it can be admitted into a
 * result set. Without this, the semantic channel would be a hole in session
 * isolation and in the `contextPolicy: 'never'` contract.
 *
 * Kept deliberately small and total: every rule below mirrors one clause of
 * `searchSqliteSage`.
 */
import { isVisibleToSession } from '../sqlite-store-search-helpers.js';
import type { Sage, SageSearchOptions } from '../types.js';

/**
 * Does `memory` satisfy every visibility rule the lexical channel would have
 * applied for the same `opts`?
 *
 * Mirrors, in order:
 *  - status filter (`includeStatuses ?? ['active']`)
 *  - scope pin (`opts.scope`)
 *  - audience exclusion (`includeAudienceScoped === false` → `audience IS NULL`)
 *  - `contextPolicy: 'never'` exclusion for automatic-context calls, i.e.
 *    exactly the calls that leave `includeStatuses` unset
 *  - session ownership (`includeAllSessions` wins, then `sessionId`, then
 *    unowned-only)
 */
export function isSageVisibleForSearch(memory: Sage, opts?: SageSearchOptions): boolean {
  const statuses = opts?.includeStatuses ?? ['active'];
  if (!statuses.includes(memory.status)) return false;
  if (opts?.scope !== undefined && memory.scope !== opts.scope) return false;
  if (opts?.includeAudienceScoped === false && memory.audience) return false;
  // `includeStatuses === undefined` is the automatic-context call shape.
  if (opts?.includeStatuses === undefined && memory.contextPolicy === 'never') return false;
  // Session ownership delegates to the ONE JS twin of `buildSessionClause`
  // rather than restating it. `isVisibleToSession`'s own docstring records
  // why: `findMemoriesForFile` shipped a second, independently-written copy
  // of this rule and leaked every session's session-scoped memories to every
  // caller. A third copy here is how that happens again.
  return isVisibleToSession(memory, {
    sessionId: opts?.sessionId,
    includeAllSessions: opts?.includeAllSessions,
  });
}
