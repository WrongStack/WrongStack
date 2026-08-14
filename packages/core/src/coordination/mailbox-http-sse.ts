import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MailboxCredentialVerifier } from './mailbox-credential-store.js';
import type { MailboxEventEmitter } from './mailbox-events.js';
import { parseCredentialAuthorization } from './mailbox-http-auth.js';
import type { MailboxActorContext, MailboxAudience } from './mailbox-types.js';
import { isMailboxMessageVisibleTo } from './mailbox-types.js';

export const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

export function mailboxEventRecords(event: unknown): Record<string, unknown>[] {
  if (event === null || typeof event !== 'object') return [];
  const record = event as Record<string, unknown>;
  const records = [record];
  for (const key of ['messageSent', 'ackUpdated'] as const) {
    const nested = record[key];
    if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      records.push(nested as Record<string, unknown>);
    }
  }
  return records;
}

export function extractEventTimestamp(event: unknown): string | undefined {
  for (const record of mailboxEventRecords(event)) {
    const timestamp = record['timestamp'];
    if (typeof timestamp === 'string') return timestamp;
  }
  return undefined;
}

export function isEventOlderThan(event: unknown, minTimestampIso: string): boolean {
  const eventTimestamp = extractEventTimestamp(event);
  if (eventTimestamp === undefined) return false;
  return eventTimestamp < minTimestampIso;
}

export function isMailboxEventVisibleToActor(event: unknown, actor: MailboxActorContext): boolean {
  for (const record of mailboxEventRecords(event)) {
    const from = record['from'];
    const to = record['to'];
    const audience = record['audience'];
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    if (audience !== undefined && audience !== 'all' && audience !== 'leaders') continue;
    const addressedToActor =
      from === actor.actorId ||
      to === actor.actorId ||
      to === '*' ||
      actor.recipientAliases.has(to) ||
      (actor.sessionId !== undefined && to === `@session:${actor.sessionId}`);
    if (
      addressedToActor &&
      isMailboxMessageVisibleTo(
        { audience: audience as MailboxAudience | undefined },
        actor.actorId,
        actor.role,
      )
    ) {
      return true;
    }
  }
  return false;
}

export function createCredentialRevalidator(
  request: IncomingMessage,
  store: MailboxCredentialVerifier,
  actor: MailboxActorContext,
): () => Promise<boolean> {
  const parsed = parseCredentialAuthorization(request);
  if (parsed === undefined) return async () => false;
  return async () => {
    const validation = await store.verifyPersisted(parsed.credentialId, parsed.secret);
    return validation.valid &&
      validation.credential?.principalId === actor.actorId &&
      validation.credential.projectId === actor.projectId;
  };
}

export function handleSse(
  request: IncomingMessage,
  response: ServerResponse,
  eventEmitter: MailboxEventEmitter,
  minTimestampIso: string | undefined,
  closeSseStreams: Set<() => void>,
  actor?: MailboxActorContext,
  revalidateCredential?: () => Promise<boolean>,
): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.write(': connected\n\n');

  let closed = false;
  let unsubscribe: () => void = () => {};
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (keepAlive !== undefined) clearInterval(keepAlive);
    unsubscribe();
    closeSseStreams.delete(close);
    try {
      response.end();
    } catch {
      // The client already closed the stream.
    }
  };

  let deliveryChain = Promise.resolve();
  const enqueue = (operation: () => Promise<void>): void => {
    if (revalidateCredential === undefined) {
      void operation();
      return;
    }
    deliveryChain = deliveryChain.then(operation, operation);
  };

  unsubscribe = eventEmitter.subscribe((event) => {
    enqueue(async () => {
      if (closed) return;
      try {
        if (revalidateCredential !== undefined && !(await revalidateCredential())) {
          close();
          return;
        }
        if (closed) return;
        if (minTimestampIso !== undefined && isEventOlderThan(event, minTimestampIso)) {
          return;
        }
        if (
          actor !== undefined &&
          !isMailboxEventVisibleToActor(event, actor)
        ) {
          return;
        }
        response.write(`data: ${JSON.stringify(event)}\n\n`);
        if (response.writableLength > MAX_SSE_BUFFER_BYTES) {
          close();
        }
      } catch {
        close();
      }
    });
  });
  keepAlive = setInterval(() => {
    enqueue(async () => {
      if (closed) return;
      try {
        if (revalidateCredential !== undefined && !(await revalidateCredential())) {
          close();
          return;
        }
        if (closed) return;
        response.write(': keepalive\n\n');
      } catch {
        close();
      }
    });
  }, 15_000);

  closeSseStreams.add(close);
  request.once('close', close);
}
