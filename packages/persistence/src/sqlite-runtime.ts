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
  Database: new (filename: string, options?: BunDatabaseOptions) => unknown;
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
    return new BunDatabase(filename, bunOptions) as unknown as DatabaseSync;
  }

  return BunDatabaseSync as unknown as DatabaseSyncConstructor;
}

/**
 * Resolve the synchronous SQLite constructor for the active JavaScript runtime.
 * Node uses `node:sqlite`; Bun uses a small constructor adapter over `bun:sqlite`.
 * The SQL surface WrongStack relies on (`exec`, `prepare`, `get`, `all`, `run`,
 * and `close`) is shared by both implementations.
 */
export function loadRuntimeDatabaseSync(
  loadModule: ModuleLoader = createRequire(import.meta.url),
): DatabaseSyncConstructor {
  let nodeError: unknown;
  try {
    const Database = databaseSyncFromNode(loadModule('node:sqlite'));
    if (Database) return Database;
    nodeError = new Error('node:sqlite did not export DatabaseSync');
  } catch (error) {
    nodeError = error;
  }

  let bunError: unknown;
  try {
    const Database = databaseSyncFromBun(loadModule('bun:sqlite'));
    if (Database) return Database;
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
