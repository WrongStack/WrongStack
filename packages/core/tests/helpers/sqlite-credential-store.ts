/**
 * Credential-store shape backed by the real SQLite store.
 *
 * `JsonlCredentialStore` was the file-based half of the mailbox subsystem's
 * auth: `_mailbox_credentials.json`, loaded into memory, rewritten on every
 * mutation. Production has not used it since credentials moved into
 * `_mailbox.sqlite` behind the project owner — only tests still constructed
 * one, which is the same shape of problem that let the JSONL mailbox survive a
 * whole migration unnoticed.
 *
 * This adapter keeps the store-shaped call sites those tests were written
 * against while routing every operation at the store production actually uses.
 * `load()` is a no-op and `verifyPersisted()` is `verify()` because a SQLite
 * read is already the persisted state — there is no in-memory snapshot that
 * can drift from the file.
 */
import type {
  CredentialValidation,
  IssueCredentialOptions,
  MailboxCredential,
} from '../../src/coordination/mailbox-credential-store.js';
import { SqliteMailbox } from '../../src/coordination/sqlite-mailbox.js';

export interface CredentialStoreLike {
  load(): Promise<void>;
  issue(
    options: IssueCredentialOptions,
  ): Promise<{ credential: MailboxCredential; secret: string }>;
  verify(credentialId: string, secret: string): CredentialValidation;
  verifyPersisted(credentialId: string, secret: string): Promise<CredentialValidation>;
  revoke(credentialId: string, reason?: string, by?: string): Promise<boolean>;
  rotate(
    credentialId: string,
    options?: Partial<IssueCredentialOptions>,
  ): Promise<{ credential: MailboxCredential; secret: string } | null>;
  get(credentialId: string): MailboxCredential | null;
  list(): MailboxCredential[];
  statusCounts(): Record<string, number>;
  /** Release the underlying handle. Windows will not unlink the dir until then. */
  close(): Promise<void>;
}

const opened = new Set<CredentialStoreLike>();

/**
 * Close every store opened since the last call.
 *
 * Tests here create their temp dir inline and remove it in a `finally`, which
 * runs before any `afterEach`, so the release has to happen at the same point
 * as the removal. Call this immediately before `rm`.
 */
export async function closeOpenedCredentialStores(): Promise<void> {
  const stores = [...opened];
  opened.clear();
  await Promise.all(stores.map((store) => store.close().catch(() => undefined)));
}

/**
 * Open a credential store over `projectDir`, backed by SQLite.
 *
 * Two calls on the same directory behave like two processes sharing one store:
 * whatever the first commits, the second reads. That is what the file-based
 * store's `load()`-and-reread tests were really asserting.
 */
export function openCredentialStore(projectDir: string): CredentialStoreLike {
  const mailbox = new SqliteMailbox(projectDir);
  let closed = false;
  const store: CredentialStoreLike = {
    load: async () => {},
    issue: async (options) => mailbox.credentialIssue(options),
    verify: (credentialId, secret) => mailbox.credentialVerify(credentialId, secret),
    verifyPersisted: async (credentialId, secret) => mailbox.credentialVerify(credentialId, secret),
    revoke: async (credentialId, reason, by) => mailbox.credentialRevoke(credentialId, reason, by),
    rotate: async (credentialId, options) => mailbox.credentialRotate(credentialId, options),
    get: (credentialId) => mailbox.credentialGet(credentialId),
    list: () => mailbox.credentialList(),
    statusCounts: () => mailbox.credentialStatusCounts(),
    close: async () => {
      if (closed) return;
      closed = true;
      opened.delete(store);
      await mailbox.close();
    },
  };
  opened.add(store);
  return store;
}
