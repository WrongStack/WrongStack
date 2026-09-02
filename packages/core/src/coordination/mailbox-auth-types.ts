/**
 * The kind of principal making a mailbox request. Determines default
 * capability grants, credential lifetime bounds, and audit labelling.
 */
export type MailboxPrincipalKind = 'agent' | 'operator' | 'service';

/**
 * Fine-grained authorization capabilities. Capabilities are deny-by-default:
 * a principal must explicitly hold a capability to perform the corresponding
 * operation. Implication rules:
 *   - `mail.read.all` => `mail.read.self`
 *   - `mail.events.all` => `mail.events.self`
 *   - `mail.send.directive` => `mail.send.actionable` => `mail.send.informational`
 *
 * `control` send capability is never granted to external principals — it is
 * reserved for trusted runtime use only.
 */
export type MailboxCapability =
  | 'mail.send.informational' // note, btw, result, status, broadcast
  | 'mail.send.actionable' // ask, assign, review (requires informational)
  | 'mail.send.directive' // steer (requires actionable)
  | 'mail.read.self' // query/check messages visible to this principal
  | 'mail.read.all' // administrative query of all messages
  | 'mail.ack.self' // acknowledge messages for this principal only
  | 'mail.events.self' // SSE events filtered to this principal's visibility
  | 'mail.events.all' // unfiltered SSE (implies events.self)
  | 'mail.presence.register.self'
  | 'mail.presence.heartbeat.self'
  | 'mail.presence.deregister.self'
  | 'mail.presence.read'
  | 'mail.retention.purge'
  | 'mail.retention.clear'
  | 'mail.admin.receipts'; // view aggregate receipt state across actors

/** How the principal was authenticated. */
export type MailboxAuthMode = 'runtime' | 'identity-token' | 'legacy-operator';

/**
 * Trusted actor context for mailbox operations.
 *
 * This is the resolved, server-side identity that all actor-specific
 * mailbox decisions (visibility, receipt scoping, capability enforcement)
 * MUST derive from. It is never decoded from untrusted request payloads.
 */
export interface MailboxActorContext {
  /** Process-unique agent identity (e.g. `leader@a1b2c3d4`). */
  actorId: string;
  /** Project this actor is bound to. Mailbox operations are scoped to it. */
  projectId: string;
  /** What kind of principal this is. Determines defaults and audit labels. */
  kind: MailboxPrincipalKind;
  /** Trusted role (e.g. `leader`, `tech-stack`). Not decoded from request body. */
  role?: string | undefined;
  /** Explicit capabilities granted to this actor. Deny-by-default. */
  capabilities: ReadonlySet<MailboxCapability>;
  /** How this actor was authenticated. */
  authMode: MailboxAuthMode;
  /**
   * Base aliases this principal may consume mail for (e.g. `leader`, `worker`).
   * Used to derive eligible recipient forms for self-query. Issued by trusted
   * runtime code or credential provisioning — never from request body.
   */
  recipientAliases: ReadonlySet<string>;
  /**
   * Session ID if the principal belongs to a specific session. Enables
   * session-broadcast delivery.
   */
  sessionId?: string | undefined;
}

/**
 * Set of capabilities implied by holding another capability.
 * Used to expand capability sets for enforcement checks.
 */
export const MAILBOX_CAPABILITY_IMPLICATIONS: Readonly<
  Record<MailboxCapability, readonly MailboxCapability[]>
> = {
  'mail.read.all': ['mail.read.self'],
  'mail.events.all': ['mail.events.self'],
  'mail.send.directive': ['mail.send.actionable', 'mail.send.informational'],
  'mail.send.actionable': ['mail.send.informational'],
  // Leaf capabilities imply nothing further.
  'mail.send.informational': [],
  'mail.read.self': [],
  'mail.ack.self': [],
  'mail.events.self': [],
  'mail.presence.register.self': [],
  'mail.presence.heartbeat.self': [],
  'mail.presence.deregister.self': [],
  'mail.presence.read': [],
  'mail.retention.purge': [],
  'mail.retention.clear': [],
  'mail.admin.receipts': [],
};

/**
 * Expand a set of capabilities to include all implied capabilities.
 * For example, `mail.read.all` implies `mail.read.self`.
 */
export function expandMailboxCapabilities(
  caps: Iterable<MailboxCapability>,
): Set<MailboxCapability> {
  const result = new Set<MailboxCapability>();
  const queue = [...caps];
  while (queue.length > 0) {
    const cap = queue.pop()!;
    if (result.has(cap)) continue;
    result.add(cap);
    const implied = MAILBOX_CAPABILITY_IMPLICATIONS[cap];
    if (implied) queue.push(...implied);
  }
  return result;
}

/**
 * Check whether an actor holds a capability, accounting for implication rules.
 */
export function hasMailboxCapability(
  actor: Pick<MailboxActorContext, 'capabilities'>,
  cap: MailboxCapability,
): boolean {
  if (actor.capabilities.has(cap)) return true;
  // Check implied capabilities by expanding the set.
  const expanded = expandMailboxCapabilities(actor.capabilities);
  return expanded.has(cap);
}
