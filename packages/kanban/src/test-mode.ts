/**
 * The single definition of "run Kanban in-process instead of through the
 * project IPC owner".
 *
 * Two production entry points consult it — `client-domain.ts`, which otherwise
 * routes every domain call over the daemon, and `storage.ts`, which otherwise
 * refuses to touch SQLite directly. They had identical three-clause copies of
 * this condition. Two copies of a switch that decides whether tests exercise
 * production code paths is exactly the kind of thing that drifts silently and
 * takes the suite's meaning with it.
 *
 * Nothing outside a Vitest run can take the in-process branch: `NODE_ENV=test`
 * alone is not enough, and `WRONGSTACK_KANBAN_FORCE_IPC=1` opts a test back
 * into the real path.
 */
export function isInProcessTestMode(): boolean {
  return (
    process.env['NODE_ENV'] === 'test' &&
    process.env['VITEST'] === 'true' &&
    process.env['WRONGSTACK_KANBAN_FORCE_IPC'] !== '1'
  );
}
