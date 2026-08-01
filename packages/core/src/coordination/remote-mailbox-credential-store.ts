import type {
  IssueCredentialOptions,
  MailboxCredential,
  MailboxCredentialVerifier,
  RedactedCredentialValidation,
  RedactedMailboxCredential,
} from './mailbox-credential-store.js';
import type { RemoteMailbox } from './remote-mailbox.js';

/**
 * Credential façade backed by the same project SQLite owner as mailbox data.
 * The HTTP bridge never opens the database or a credential sidecar directly.
 */
export class RemoteMailboxCredentialStore implements MailboxCredentialVerifier {
  constructor(private readonly mailbox: RemoteMailbox) {}

  async load(): Promise<void> {
    await this.mailbox.initialize();
  }

  issue(
    options: IssueCredentialOptions,
  ): Promise<{ credential: MailboxCredential; secret: string }> {
    return this.mailbox.credentialIssue(options);
  }

  verify(credentialId: string, secret: string): Promise<RedactedCredentialValidation> {
    return this.mailbox.credentialVerify(credentialId, secret);
  }

  verifyPersisted(credentialId: string, secret: string): Promise<RedactedCredentialValidation> {
    return this.verify(credentialId, secret);
  }

  revoke(credentialId: string, reason?: string, by?: string): Promise<boolean> {
    return this.mailbox.credentialRevoke(credentialId, reason, by);
  }

  rotate(
    credentialId: string,
    options?: Partial<IssueCredentialOptions>,
  ): Promise<{ credential: MailboxCredential; secret: string } | null> {
    return this.mailbox.credentialRotate(credentialId, options);
  }

  get(credentialId: string): Promise<RedactedMailboxCredential | null> {
    return this.mailbox.credentialGet(credentialId);
  }

  list(): Promise<RedactedMailboxCredential[]> {
    return this.mailbox.credentialList();
  }

  statusCounts(): Promise<Record<string, number>> {
    return this.mailbox.credentialStatusCounts();
  }
}
