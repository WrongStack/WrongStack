if (process.env['NODE_ENV'] !== 'test' || process.env['VITEST'] !== 'true') {
  throw new Error('@wrongstack/kanban/test-support is test-only');
}

export { buildKanbanWorkbench } from './manager/workbench.js';
/**
 * Legacy codec fixtures for cross-package tests. This subpath is deliberately
 * separate from the production client API so raw board paths cannot become a
 * runtime dependency.
 */
export { createBoardObject, getKanbanPath } from './storage.js';

/**
 * Session-bound domain calls for tests in every package. See
 * `test-support-session.ts`: the mutators there fill in the owning session so a
 * test that does not care about attribution reads as it did before the
 * invariant landed.
 */
export * from './test-support-session.js';
