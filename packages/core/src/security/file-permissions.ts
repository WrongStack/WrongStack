/**
 * Owner-only file hardening — re-exported from `@wrongstack/persistence`.
 *
 * The implementation moved there so the project daemons that cannot depend on
 * core can still call it: `@wrongstack/kanban` depends only on persistence, and
 * the reverse edge is impossible because core already depends on kanban. Every
 * daemon writes a metadata file carrying its per-process IPC auth token, so
 * they all need the same guarantee.
 *
 * This module stays as the re-export because `@wrongstack/core/security` is a
 * published subpath with existing consumers (the SAGE and codebase-index
 * daemons, the HQ login-attempt store, the secret vault). Import from either;
 * they are the same functions.
 *
 * @module security/file-permissions
 */

export { restrictDirPermissions, restrictFilePermissions, SECRET_DIR_MODE, SECRET_FILE_MODE } from '@wrongstack/persistence';
