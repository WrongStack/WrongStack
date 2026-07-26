import { sqliteAnchorNode, sqliteAnchorRelation } from './sqlite-store-anchors.js';
import {
  importanceFromPriority,
  isMigratableAuditRecord,
  isMigratableCandidate,
  isMigratableEdge,
  isMigratableMemoryRecord,
  legacyScopeLabel,
  matchesLegacyForget,
  shouldReplaceMigratedMemory,
} from './sqlite-store-legacy.js';
import {
  DATABASE_SYNC_LOADING,
  getDatabaseSyncCtor,
  loadDatabaseSync,
  probeSqliteAvailable,
  setDatabaseSyncCtor,
  withSqliteExperimentalWarningSuppressed,
} from './sqlite-store-loader.js';
import {
  decodePageCursor,
  escapeGlobPattern,
  escapeLikePattern,
  formatLegacyEntry,
} from './sqlite-store-pagination.js';
import { sqliteCommandFamily, sqliteNormalizeCommand } from './sqlite-store-schema.js';

/**
 * Direct-module test seam for pure defensive helpers. This is intentionally
 * absent from the package barrel, so it does not expand the supported public
 * API while allowing malformed persisted data to be tested without corrupting
 * a real SQLite file.
 */
export const sqliteStoreCoverage = {
  escapeGlobPattern,
  escapeLikePattern,
  formatLegacyEntry,
  decodePageCursor,
  withSqliteExperimentalWarningSuppressed,
  sqliteNormalizeCommand,
  sqliteCommandFamily,
  sqliteAnchorNode,
  sqliteAnchorRelation,
  importanceFromPriority,
  legacyScopeLabel,
  matchesLegacyForget,
  isMigratableMemoryRecord,
  shouldReplaceMigratedMemory,
  isMigratableCandidate,
  isMigratableEdge,
  isMigratableAuditRecord,
  probeSqliteAvailable,
  loadDatabaseSync,
  databaseSyncLoading: DATABASE_SYNC_LOADING,
  getDatabaseSyncCtor,
  setDatabaseSyncCtor,
};
