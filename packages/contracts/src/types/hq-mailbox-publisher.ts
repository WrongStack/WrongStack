/**
 * The slice of the HQ telemetry publisher that the project mailbox uses.
 *
 * The publisher itself lives in `@wrongstack/hq`, above core. Core's mailbox
 * wiring only needs to connect, mirror mailbox activity and close, so it
 * depends on this port and resolves a factory from the container
 * (`HQ_MAILBOX_PUBLISHER_FACTORY`); the composition root binds the real one.
 *
 * @module types/hq-mailbox-publisher
 */
import type { Logger } from './logger.js';
import type { Mailbox, MailboxAgentStatus, MailboxMessage } from './mailbox.js';

/** Mailbox actions mirrored to HQ (`HqMailboxEventPayload['action']`). */
export type HqMailboxEventAction =
  | 'message.sent'
  | 'message.read'
  | 'message.completed'
  | 'message.updated'
  | 'agent.registered'
  | 'agent.heartbeat'
  | 'agent.offline'
  | 'agent.deregistered';

export interface MailboxHqPublisherPort {
  connect(): void;
  close(): void;
  publishMailboxSnapshot(
    mailbox: Pick<Mailbox, 'query' | 'getAgentStatuses'>,
    options: { mailboxId: string; sessionId?: string; timestamp?: string },
  ): Promise<unknown>;
  publishMailboxEvent(input: {
    mailboxId: string;
    action: HqMailboxEventAction;
    message?: MailboxMessage;
    agent?: MailboxAgentStatus;
    summary?: string;
    previewLength?: number;
    sessionId?: string;
    timestamp?: string;
  }): unknown;
}

export interface MailboxHqPublisherFactoryOptions {
  clientKind: 'cli' | 'webui';
  projectRoot: string;
  logger?: Logger | undefined;
  capabilities: readonly ('telemetry.publish' | 'mailbox.summary')[];
}

/** Returns `undefined` when HQ is disabled or unconfigured. */
export type MailboxHqPublisherFactory = (
  options: MailboxHqPublisherFactoryOptions,
) => MailboxHqPublisherPort | undefined;
