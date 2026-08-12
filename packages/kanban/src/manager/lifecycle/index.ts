/**
 * Public re-export surface for the `manager/lifecycle` subpath.
 *
 * The deep-import exists so the slash command can call the read-only
 * `preflightManagedTransition` helper from a project that does NOT want to
 * take the full `@wrongstack/kanban` barrel — keeping this surface narrow
 * (two functions) means downstream code cannot accidentally couple to the
 * mutating internals.
 *
 * Follows the `@wrongstack/*` directory convention: this file is the entry
 * pointed at by `package.json` `exports["./manager/lifecycle"]` and by
 * `scripts/build-package.mjs` `entries["manager/lifecycle"]`.
 */
export {
  preflightManagedTransition,
  validateTickChecks,
} from '../lifecycle.js';
