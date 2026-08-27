/**
 * Alias for the package's session-bound test surface.
 *
 * Kanban's own tests import through this local path; every other package
 * reaches the same module as `@wrongstack/kanban/test-support`.
 */
export * from '../../src/test-support-session.js';
