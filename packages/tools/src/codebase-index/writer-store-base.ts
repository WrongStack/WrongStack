/**
 * Connection, transaction and helper-host layer of {@link IndexStore}
 * (writer.ts): owns the SQLite handle, the statement / BM25 caches and the
 * host objects the writer-* helper modules operate on.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Bm25Index } from './bm25.js';
import type { IndexStoreBatchesHost } from './index-store-batches.js';
import type { IndexStoreMaintenanceHost } from './index-store-maintenance.js';
import { loadDatabaseSync, runSqliteWithRetry } from './sqlite-runtime.js';
import * as writerAdmin from './writer-admin.js';
import {
  close as closeFromHost,
  dataVersion as dataVersionFromHost,
  getOrBuildBm25 as getOrBuildBm25FromHost,
  recordFtsChurn as recordFtsChurnFromHost,
  setMetadata as setMetadataFromHost,
  stmt as stmtFromHost,
  type WriterCacheLifecycleHost,
} from './writer-cache-lifecycle.js';
import type { IndexDeletionHost } from './writer-deletion.js';
import * as writerDeletion from './writer-deletion.js';
import { resolveIndexDir } from './writer-helpers.js';
import { allocateSymbolIds, initIndexSchema } from './writer-init.js';
import { applyIndexStorePragmas } from './writer-pragmas.js';
import * as writerRefs from './writer-refs.js';
import type { WriterSymbolQueriesHost } from './writer-symbol-queries.js';
import type { IndexTransactionHost } from './writer-transactions.js';
import * as writerTransactions from './writer-transactions.js';
import { isWrongIndexWriteBlocked } from './wrongindex/owner-lock.js';

const DB_FILE = 'index.db';

/**
 * Open an index the WrongIndex service owns without changing it: no schema
 * initialization (which can migrate or repair) and `query_only`, so any write
 * through this store fails instead of racing the owner. A read-write handle
 * (not `readOnly`) is used because a read-only connection to a WAL database
 * needs its shared-memory file to exist.
 */
function openOwnedIndexQueryOnly(db: DatabaseSync): {
  ftsAvailable: boolean;
  vectorsAvailable: boolean;
} {
  db.exec('PRAGMA busy_timeout = 15000');
  db.exec('PRAGMA query_only = 1');
  const has = (name: string) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
  return { ftsAvailable: has('symbols_fts'), vectorsAvailable: has('symbol_vectors') };
}

export abstract class IndexStoreBase {
  protected db: DatabaseSync;
  protected atomicIndexUpdateActive = false;
  protected writeSavepointSequence = 0;
  protected readonly projectRoot: string;
  protected readonly indexDir: string;
  protected ftsAvailable = false;
  protected vectorsAvailable = false;
  protected readonly stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  protected bm25Cache: Bm25Index | null = null;
  protected bm25Dirty = true;
  /** `PRAGMA data_version` the BM25 cache was built at. */
  protected bm25DataVersion = -1;

  protected stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    return stmtFromHost(this.writerCacheLifecycleHost(), sql);
  }

  constructor(projectRoot: string, opts: { indexDir?: string | undefined } = {}) {
    this.projectRoot = projectRoot;
    this.indexDir = resolveIndexDir(projectRoot, opts.indexDir);
    fs.mkdirSync(this.indexDir, { recursive: true });
    const Database = loadDatabaseSync();
    this.db = new Database(path.join(this.indexDir, DB_FILE));
    if (isWrongIndexWriteBlocked(this.indexDir)) {
      const { ftsAvailable, vectorsAvailable } = openOwnedIndexQueryOnly(this.db);
      this.ftsAvailable = ftsAvailable;
      this.vectorsAvailable = vectorsAvailable;
      this.ownedExternally = true;
      return;
    }
    applyIndexStorePragmas(this.db);
    this.initSchema();
  }

  /** Opened query-only because the WrongIndex service owns this index. */
  ownedExternally = false;

  runWithRetry<T>(fn: () => T): T {
    return runSqliteWithRetry(fn);
  }

  async runAtomicIndexUpdate<T>(job: () => Promise<T>): Promise<T> {
    return writerTransactions.runAtomicUpdate(this.indexTransactionHost(), job);
  }

  protected beginWriteTransaction(): string | null {
    return writerTransactions.beginIndexWrite(this.indexTransactionHost());
  }

  protected commitWriteTransaction(savepoint: string | null): void {
    writerTransactions.commitIndexWrite(this.indexTransactionHost(), savepoint);
  }

  /**
   * Never throws: every caller is already propagating the failure that caused
   * the rollback. When SQLite has rolled the transaction back itself (disk
   * full, I/O error) the ROLLBACK fails with "no transaction is active", and
   * that message used to replace the real error.
   */
  protected rollbackWriteTransaction(savepoint: string | null): void {
    writerTransactions.rollbackIndexWrite(this.indexTransactionHost(), savepoint);
  }

  protected initSchema(): void {
    const { ftsAvailable, vectorsAvailable } = initIndexSchema(
      this.db,
      (sql) => this.stmt(sql),
      (key) => this.getMetadata(key),
      (key, value) => this.setMetadata(key, value),
      IndexStoreBase.MAX_SQL_VARS,
      () => this.invalidateBm25(),
    );
    this.ftsAvailable = ftsAvailable;
    this.vectorsAvailable = vectorsAvailable;
  }

  protected static readonly MAX_SQL_VARS = 900;

  protected runWriteTransaction<T>(operation: () => T): T {
    return writerTransactions.runIndexWrite(this.indexTransactionHost(), operation);
  }

  protected allocateSymbolIds(count: number): number {
    return allocateSymbolIds(
      (sql) => this.stmt(sql),
      count,
      () => this.getMaxSymbolId(),
    );
  }

  protected invalidateIncomingRefsForFiles(files: readonly string[]): Set<string> {
    return writerDeletion.invalidateIncomingIndexRefs(this.indexDeletionHost(), files);
  }

  protected resolveRefsForNamesUnsafe(names: Iterable<string>): number {
    return writerRefs.resolveRefsForNamesUnsafe(
      (sql) => this.stmt(sql),
      IndexStoreBase.MAX_SQL_VARS,
      names,
    );
  }

  protected invalidateBm25(): void {
    this.bm25Dirty = true;
    this.bm25Cache = null;
  }

  /**
   * The corpus is rebuilt when this connection wrote (bm25Dirty) OR another
   * connection committed since it was built. Pooled stores stay open for the
   * life of the host while the project daemon, an inline indexer or another
   * process writes the same database; the dirty flag alone never saw those
   * writes, so short-query results silently dropped every symbol added since.
   */
  protected getOrBuildBm25(): Bm25Index {
    return getOrBuildBm25FromHost(this.writerCacheLifecycleHost());
  }

  /** Changes whenever ANOTHER connection commits to this database. */
  protected dataVersion(): number {
    return dataVersionFromHost(this.writerCacheLifecycleHost());
  }

  getAllIndexable(): Array<{ id: number; text: string }> {
    return writerAdmin.getAllIndexableWithStatement((sql) => this.stmt(sql));
  }

  getMaxSymbolId(): number {
    return writerAdmin.getMaxSymbolIdWithStatement((sql) => this.stmt(sql));
  }

  getMetadata(key: string): string | undefined {
    return writerAdmin.getMetadataWithStatement((sql) => this.stmt(sql), key);
  }

  setMetadata(key: string, value: string): void {
    setMetadataFromHost(this.writerCacheLifecycleHost(), key, value);
  }

  /**
   * Best-effort churn bookkeeping for {@link optimizeFtsIfNeeded}. Counts the
   * FTS rows a mutation inserts or deletes so the maintenance gate can fire
   * after real churn, not on a timer. Persisted in metadata so the counter
   * survives store open/close cycles in the daemon pool.
   */
  protected recordFtsChurn(rows: number): void {
    recordFtsChurnFromHost(this.writerCacheLifecycleHost(), rows);
  }

  close(): void {
    closeFromHost(this.writerCacheLifecycleHost());
  }

  protected indexStoreMaintenanceHost(): IndexStoreMaintenanceHost {
    const self = this;
    return {
      stmt: (...args) => this.stmt(...args),
      get ftsAvailable() {
        return self.ftsAvailable;
      },
      getMetadata: (...args) => this.getMetadata(...args),
      setMetadata: (...args) => this.setMetadata(...args),
      runWithRetry: (...args) => this.runWithRetry(...args),
      get db() {
        return self.db;
      },
    };
  }

  protected indexStoreBatchesHost(): IndexStoreBatchesHost {
    const self = this;
    return {
      maxSqlVars: IndexStoreBase.MAX_SQL_VARS,
      invalidateBm25: (...args) => this.invalidateBm25(...args),
      runWriteTransaction: (...args) => this.runWriteTransaction(...args),
      stmt: (...args) => this.stmt(...args),
      get ftsAvailable() {
        return self.ftsAvailable;
      },
      set ftsAvailable(value) {
        self.ftsAvailable = value;
      },
      get vectorsAvailable() {
        return self.vectorsAvailable;
      },
      set vectorsAvailable(value) {
        self.vectorsAvailable = value;
      },
      allocateSymbolIds: (...args) => this.allocateSymbolIds(...args),
      invalidateIncomingRefsForFiles: (...args) => this.invalidateIncomingRefsForFiles(...args),
      resolveRefsForNamesUnsafe: (...args) => this.resolveRefsForNamesUnsafe(...args),
      recordFtsChurn: (...args) => this.recordFtsChurn(...args),
    };
  }

  protected indexDeletionHost(): IndexDeletionHost {
    const self = this;
    return {
      maxSqlVars: IndexStoreBase.MAX_SQL_VARS,
      stmt: (...args) => this.stmt(...args),
      invalidateBm25: (...args) => this.invalidateBm25(...args),
      runWriteTransaction: (...args) => this.runWriteTransaction(...args),
      invalidateIncomingRefsForFiles: (...args) => this.invalidateIncomingRefsForFiles(...args),
      get ftsAvailable() {
        return self.ftsAvailable;
      },
      get vectorsAvailable() {
        return self.vectorsAvailable;
      },
      recordFtsChurn: (...args) => this.recordFtsChurn(...args),
      resolveRefsForNamesUnsafe: (...args) => this.resolveRefsForNamesUnsafe(...args),
      get db() {
        return self.db;
      },
      stmtCache: this.stmtCache,
      initSchema: (...args) => this.initSchema(...args),
    };
  }

  protected indexTransactionHost(): IndexTransactionHost {
    const self = this;
    return {
      get atomicIndexUpdateActive() {
        return self.atomicIndexUpdateActive;
      },
      set atomicIndexUpdateActive(value) {
        self.atomicIndexUpdateActive = value;
      },
      runWithRetry: (...args) => this.runWithRetry(...args),
      get db() {
        return self.db;
      },
      invalidateBm25: (...args) => this.invalidateBm25(...args),
      get writeSavepointSequence() {
        return self.writeSavepointSequence;
      },
      set writeSavepointSequence(value) {
        self.writeSavepointSequence = value;
      },
      beginWriteTransaction: (...args) => this.beginWriteTransaction(...args),
      commitWriteTransaction: (...args) => this.commitWriteTransaction(...args),
      rollbackWriteTransaction: (...args) => this.rollbackWriteTransaction(...args),
    };
  }

  protected writerSymbolQueriesHost(): WriterSymbolQueriesHost {
    // Preserve the owner's instance and check each member against the helper contract.
    void (this.stmt satisfies WriterSymbolQueriesHost['stmt']);
    return this as unknown as WriterSymbolQueriesHost;
  }

  protected writerCacheLifecycleHost(): WriterCacheLifecycleHost {
    // Check the complete helper contract while preserving the owner's identity and receivers.
    void ({
      stmtCache: this.stmtCache,
      db: this.db,
      dataVersion: this.dataVersion,
      bm25Cache: this.bm25Cache,
      bm25Dirty: this.bm25Dirty,
      bm25DataVersion: this.bm25DataVersion,
      getAllIndexable: this.getAllIndexable,
      stmt: this.stmt,
      runWithRetry: this.runWithRetry,
      getMetadata: this.getMetadata,
      indexStoreMaintenanceHost: this.indexStoreMaintenanceHost,
    } satisfies WriterCacheLifecycleHost);
    return this as unknown as WriterCacheLifecycleHost;
  }
}
