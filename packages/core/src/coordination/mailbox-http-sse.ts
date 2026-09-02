import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MailboxCredentialVerifier } from './mailbox-credential-store.js';
import type { MailboxEventEmitter } from './mailbox-events.js';
import { parseCredentialAuthorization } from './mailbox-http-auth.js';
import type { MailboxActorContext, MailboxAudience } from './mailbox-types.js';
import { isMailboxMessageVisibleTo } from './mailbox-types.js';

export const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * How long a single mid-stream credential revalidation may take before the
 * stream is closed. Revalidation shares the serialized delivery queue with
 * event deliveries and keepalives, so a call that never settles (wedged
 * project server, dropped IPC) would otherwise stall that queue forever:
 * everything after it queues behind it, nothing is written, and `close()`
 * never runs. The timeout turns a wedged stream into a closed one.
 */
export const SSE_REVALIDATION_TIMEOUT_MS = 10_000;

/**
 * Maximum operations (event deliveries + keepalives) allowed to sit in the
 * serialized delivery queue. {@link MAX_SSE_BUFFER_BYTES} bounds the socket
 * buffer, not this in-memory chain: past this cap the stream is closed,
 * because a queue this deep means the client cannot keep up or revalidation
 * is wedged — accumulating closures (each retaining its event payload) is
 * the one failure mode the socket-buffer cap cannot see.
 */
export const MAX_PENDING_SSE_OPERATIONS = 256;

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
    return (
      validation.valid &&
      validation.credential?.principalId === actor.actorId &&
      validation.credential.projectId === actor.projectId
    );
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

  /**
   * Race one revalidation against {@link SSE_REVALIDATION_TIMEOUT_MS}. A
   * revalidation that never settles would otherwise hold the delivery queue
   * forever (a later keepalive cannot rescue it — it queues behind the same
   * chain); rejecting here makes the operation's catch close the stream.
   */
  const revalidate = async (): Promise<boolean> => {
    if (revalidateCredential === undefined) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        revalidateCredential(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('mailbox SSE credential revalidation timed out')),
            SSE_REVALIDATION_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  let deliveryChain = Promise.resolve();
  let pendingOperations = 0;
  const enqueue = (operation: () => Promise<void>): void => {
    if (revalidateCredential === undefined) {
      void operation();
      return;
    }
    // The queue is in-memory and unbounded by MAX_SSE_BUFFER_BYTES, which only
    // sees the socket. Cap it and close rather than accumulate closures (each
    // retaining its event payload) when the stream cannot keep up.
    if (pendingOperations >= MAX_PENDING_SSE_OPERATIONS) {
      close();
      return;
    }
    pendingOperations += 1;
    deliveryChain = deliveryChain.then(operation, operation).finally(() => {
      pendingOperations -= 1;
    });
  };

  unsubscribe = eventEmitter.subscribe((event) => {
    enqueue(async () => {
      if (closed) return;
      try {
        // Conditional await: with no revalidator the write must stay
        // synchronous (callers rely on it); the timeout race only applies
        // when a real revalidation is in play.
        if (revalidateCredential !== undefined && !(await revalidate())) {
          close();
          return;
        }
        if (closed) return;
        if (minTimestampIso !== undefined && isEventOlderThan(event, minTimestampIso)) {
          return;
        }
        if (actor !== undefined && !isMailboxEventVisibleToActor(event, actor)) {
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
        // Conditional await: with no revalidator the write must stay
        // synchronous (callers rely on it); the timeout race only applies
        // when a real revalidation is in play.
        if (revalidateCredential !== undefined && !(await revalidate())) {
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
