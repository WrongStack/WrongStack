/**
 * Wall-clock time helpers.
 *
 * `nowIso` existed as six byte-identical private/public copies across
 * kanban, cli, sage, and plugins (card #5 slice 5e). It lives here as the
 * canonical definition so every tier of the workspace graph — including
 * packages that sit below core — can share one clock read.
 */

/** Current wall-clock time as an ISO-8601 UTC timestamp (`2026-08-22T14:50:00.000Z`). */
export function nowIso(): string {
  return new Date().toISOString();
}
