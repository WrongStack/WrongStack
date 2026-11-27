import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Scoped metadata reader for code running inside an already-held exclusive
 * storage transaction.
 *
 * `SqliteKanbanStorage.mutateBoard` holds its `exclusive` mutex (and an open
 * SQLite transaction) across the mutator's await. A mutator that reads project
 * metadata at commit time — the Kanban companion-policy gate and write fence
 * do — must NOT call `readMetadata` again: the nested call queues behind the
 * same mutex and deadlocks the transaction. Instead, `mutateBoard` runs the
 * mutator inside this AsyncLocalStorage carrying a reader that reads the
 * database directly within the transaction the caller already holds.
 *
 * The scope carries ONLY a metadata reader — never a writer and never the
 * mutex itself — so a nested mutation can never be smuggled inside another's
 * exclusive section and the storage lock stays non-reentrant.
 */
export interface KanbanStorageTransactionReader {
  readMetadata: (key: string) => Promise<string | null>;
}

const transactionScope = new AsyncLocalStorage<KanbanStorageTransactionReader>();

export async function runInsideStorageTransaction<T>(
  reader: KanbanStorageTransactionReader,
  operation: () => T | Promise<T>,
): Promise<T> {
  return transactionScope.run(reader, async () => await operation());
}

/** The reader for the transaction this async chain is already inside, if any. */
export function currentStorageTransactionReader(): KanbanStorageTransactionReader | undefined {
  return transactionScope.getStore();
}
