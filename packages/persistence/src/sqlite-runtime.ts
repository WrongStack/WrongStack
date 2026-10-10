import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

type DatabaseSyncConstructor = typeof DatabaseSync;
type ModuleLoader = (specifier: string) => unknown;

interface BunDatabaseOptions {
  create?: boolean;
  readonly?: boolean;
  readwrite?: boolean;
}

interface BunSqliteModule {
  Database: {
    new (filename: string, options?: BunDatabaseOptions): unknown;
    prototype: object;
  };
}

function databaseSyncFromNode(module: unknown): DatabaseSyncConstructor | null {
  if (typeof module !== 'object' || module === null || !('DatabaseSync' in module)) return null;
  return typeof module.DatabaseSync === 'function'
    ? (module.DatabaseSync as DatabaseSyncConstructor)
    : null;
}

function databaseSyncFromBun(module: unknown): DatabaseSyncConstructor | null {
  if (typeof module !== 'object' || module === null || !('Database' in module)) return null;
  if (typeof module.Database !== 'function') return null;
  const BunDatabase = module.Database as BunSqliteModule['Database'];

  // A constructor may explicitly return an object. This lets callers retain
  // the Node DatabaseSync contract while Bun receives its own option names.
  function BunDatabaseSync(
    this: unknown,
    filename: string,
    options?: ConstructorParameters<DatabaseSyncConstructor>[1],
  ): DatabaseSync {
    const bunOptions: BunDatabaseOptions | undefined = options?.readOnly
      ? { readonly: true, create: false, readwrite: false }
      : undefined;
    const database = new BunDatabase(filename, bunOptions) as {
      close?: (throwOnError?: boolean) => void;
      prepare?: DatabaseSync['prepare'];
      inTransaction?: boolean;
    };
    let isOpen = true;
    Object.defineProperties(database, {
      isOpen: { get: () => isOpen },
      isTransaction: { get: () => database.inTransaction },
    });
    if (typeof database.prepare === 'function') {
      const prepare = database.prepare.bind(database);
      database.prepare = (...args: Parameters<DatabaseSync['prepare']>) => {
        const statement = prepare(...args);
        const get = statement.get.bind(statement);
        // Bun returns null for a missing row; the Node contract is undefined.
        statement.get = (...params) => Reflect.apply(get, statement, params) ?? undefined;
        return statement;
      };
    }
    if (typeof database.close === 'function') {
      const close = database.close.bind(database);
      // Node close invalidates every statement and releases the file immediately.
      // Bun's default close(false) leaves .prepare() statements and handles alive.
      database.close = () => {
        if (!isOpen) return;
        close(true);
        isOpen = false;
      };
      Object.defineProperty(database, Symbol.dispose, { value: () => database.close?.() });
    }
    return database as unknown as DatabaseSync;
  }

  BunDatabaseSync.prototype = BunDatabase.prototype;
  return BunDatabaseSync as unknown as DatabaseSyncConstructor;
}

let _defaultRequire: ModuleLoader | undefined;
let _cachedDefaultDatabaseSync: DatabaseSyncConstructor | undefined;

function getDefaultRequire(): ModuleLoader {
  _defaultRequire ??= createRequire(import.meta.url);
  return _defaultRequire;
}

/**
 * Resolve the synchronous SQLite constructor for the active JavaScript runtime.
 * Node uses `node:sqlite`; Bun uses a small constructor adapter over `bun:sqlite`.
 * The SQL surface WrongStack relies on (`exec`, `prepare`, `get`, `all`, `run`,
 * and `close`) is shared by both implementations.
 */
export function loadRuntimeDatabaseSync(loadModule?: ModuleLoader): DatabaseSyncConstructor {
  const isDefault = loadModule === undefined;
  if (isDefault && _cachedDefaultDatabaseSync) {
    return _cachedDefaultDatabaseSync;
  }
  const loader = loadModule ?? getDefaultRequire();
  if (isDefault && process.versions.bun) {
    const Database = databaseSyncFromBun(loader('bun:sqlite'));
    if (!Database) throw new Error('bun:sqlite did not export Database');
    _cachedDefaultDatabaseSync = Database;
    return Database;
  }

  let nodeError: unknown;
  try {
    const Database = databaseSyncFromNode(loader('node:sqlite'));
    if (Database) {
      if (isDefault) _cachedDefaultDatabaseSync = Database;
      return Database;
    }
    nodeError = new Error('node:sqlite did not export DatabaseSync');
  } catch (error) {
    nodeError = error;
  }

  let bunError: unknown;
  try {
    const Database = databaseSyncFromBun(loader('bun:sqlite'));
    if (Database) {
      if (isDefault) _cachedDefaultDatabaseSync = Database;
      return Database;
    }
    bunError = new Error('bun:sqlite did not export Database');
  } catch (error) {
    bunError = error;
  }

  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
  throw new Error(
    `No supported synchronous SQLite runtime is available (node:sqlite: ${describe(nodeError)}; bun:sqlite: ${describe(bunError)}).`,
  );
}

export function isRuntimeSqliteAvailable(loadModule?: ModuleLoader): boolean {
  try {
    loadRuntimeDatabaseSync(loadModule);
    return true;
  } catch {
    return false;
  }
}
