import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type {
  RedactedCredentialValidation,
  MailboxCredentialVerifier,
} from './mailbox-credential-store.js';
import type { MailboxActorContext } from './mailbox-types.js';

export type MailboxHttpAccessDecision =
  | { allowed: true; rateLimitKey?: string; actor?: MailboxActorContext }
  | { allowed: false; status?: number; body?: unknown };

/**
 * Successful credential authorization result extending MailboxHttpAccessDecision.
 * TypeScript disallows interfaces extending union types, so this intersects
 * the allowed variant of MailboxHttpAccessDecision with the credential fields.
 */
export type MailboxHttpCredentialDecision = Extract<
  MailboxHttpAccessDecision,
  { allowed: true }
> & {
  /** Trusted actor context used for identity and capability enforcement. */
  actor: MailboxActorContext;
};

export function authorizeMailboxBearerToken(
  request: IncomingMessage,
  expectedToken: string,
): MailboxHttpAccessDecision {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return { allowed: false };
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match === null) return { allowed: false };
  const presented = Buffer.from(match[1] ?? '', 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { allowed: false };
  }
  return { allowed: true, rateLimitKey: expectedToken };
}

/**
 * Authorize a request using identity-scoped credentials.
 *
 * The credential format is `Credential <id>:<secret>`, where `<secret>` is the
 * opaque 32-byte hex value issued at creation time. Verification always goes
 * to the persisted store, so a revocation issued elsewhere applies on the very
 * next request rather than after some cache expires.
 */
export async function authorizePersistedMailboxCredential(
  request: IncomingMessage,
  store: MailboxCredentialVerifier,
): Promise<MailboxHttpAccessDecision | MailboxHttpCredentialDecision> {
  const parsed = parseCredentialAuthorization(request);
  if (parsed === undefined) return { allowed: false };
  return credentialDecision(
    parsed.credentialId,
    await store.verifyPersisted(parsed.credentialId, parsed.secret),
  );
}

function credentialDecision(
  credentialId: string,
  result: RedactedCredentialValidation,
): MailboxHttpAccessDecision | MailboxHttpCredentialDecision {
  const credential = result.credential;
  const projectId = credential?.projectId;
  if (!result.valid || credential === undefined || projectId === undefined) {
    return { allowed: false };
  }

  const identitySeparator = credential.principalId.indexOf('@');
  const role =
    credential.kind === 'agent'
      ? credential.principalId.slice(0, identitySeparator === -1 ? undefined : identitySeparator)
      : undefined;
  const sessionId =
    identitySeparator === -1
      ? undefined
      : credential.principalId.slice(identitySeparator + 1) || undefined;

  return {
    allowed: true,
    rateLimitKey: `cred:${credentialId}`,
    actor: {
      actorId: credential.principalId,
      projectId,
      kind: credential.kind,
      capabilities: new Set(credential.capabilities),
      authMode: 'identity-token',
      recipientAliases: role === undefined ? new Set() : new Set([role]),
      ...(role !== undefined ? { role } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    },
  };
}

export function parseCredentialAuthorization(
  request: IncomingMessage,
): { credentialId: string; secret: string } | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Credential\s+([^:]+):(.+)$/i.exec(header);
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  return { credentialId: match[1], secret: match[2] };
}
