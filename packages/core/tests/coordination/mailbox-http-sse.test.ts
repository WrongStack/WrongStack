import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MailboxEventEmitter,
  type MailboxEvent,
} from '../../src/coordination/mailbox-events.js';
import {
  handleSse,
  MAX_PENDING_SSE_OPERATIONS,
  SSE_REVALIDATION_TIMEOUT_MS,
} from '../../src/coordination/mailbox-http-sse.js';

function makeRequest(): IncomingMessage {
  const stream = new PassThrough();
  Object.assign(stream, {
    method: 'GET',
    url: '/mailbox/events',
    headers: {},
  });
  return stream as unknown as IncomingMessage;
}

interface ResponseRecorder {
  response: ServerResponse;
  readonly chunks: string[];
  ended: boolean;
}

function makeResponse(): ResponseRecorder {
  const chunks: string[] = [];
  const recorder: ResponseRecorder = {
    response: undefined as unknown as ServerResponse,
    chunks,
    ended: false,
  };
  const response = {
    writeHead() {
      return response;
    },
    write(chunk: string | Buffer) {
      chunks.push(String(chunk));
      return true;
    },
    end() {
      recorder.ended = true;
      return response;
    },
    writableLength: 0,
  };
  recorder.response = response as unknown as ServerResponse;
  return recorder;
}

function makeEvent(overrides: Partial<MailboxEvent> = {}): MailboxEvent {
  return {
    type: 'message.sent',
    messageId: 'msg-1',
    from: 'external-a',
    to: 'agent-b',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** A revalidator whose promise never settles — models a wedged IPC round-trip. */
function neverSettlingRevalidation(): Promise<boolean> {
  return new Promise<boolean>(() => {});
}

describe('handleSse credential revalidation hardening', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers events when revalidation settles true', async () => {
    const emitter = new MailboxEventEmitter();
    const closeSseStreams = new Set<() => void>();
    const recorder = makeResponse();

    handleSse(
      makeRequest(),
      recorder.response,
      emitter,
      undefined,
      closeSseStreams,
      undefined,
      async () => true,
    );
    emitter.emit(makeEvent());
    await vi.advanceTimersByTimeAsync(0);

    expect(recorder.ended).toBe(false);
    expect(recorder.chunks.join('')).toContain('"messageId":"msg-1"');
    expect(closeSseStreams.size).toBe(1);

    // A second delivery after the first operation settled proves the pending
    // counter drains back down (no drift toward a premature cap close).
    emitter.emit(makeEvent({ messageId: 'msg-2' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(recorder.ended).toBe(false);
    expect(recorder.chunks.join('')).toContain('"messageId":"msg-2"');
  });

  it('closes the stream when revalidation never settles (regression)', async () => {
    const emitter = new MailboxEventEmitter();
    const closeSseStreams = new Set<() => void>();
    const recorder = makeResponse();

    handleSse(
      makeRequest(),
      recorder.response,
      emitter,
      undefined,
      closeSseStreams,
      undefined,
      neverSettlingRevalidation,
    );
    emitter.emit(makeEvent());
    await vi.advanceTimersByTimeAsync(0);

    // The delivery is parked behind the never-settling revalidation, but the
    // stream must not have been torn down before the timeout expires.
    expect(recorder.ended).toBe(false);
    expect(recorder.chunks.join('')).not.toContain('data:');

    await vi.advanceTimersByTimeAsync(SSE_REVALIDATION_TIMEOUT_MS + 1);

    // The timeout race rejects, the operation's catch closes the stream, and
    // every held resource (listener, interval, closeSseStreams entry) is gone.
    expect(recorder.ended).toBe(true);
    expect(recorder.chunks.join('')).not.toContain('data:');
    expect(emitter.subscriberCount).toBe(0);
    expect(closeSseStreams.size).toBe(0);
  });

  it('closes the stream when a keepalive revalidation never settles', async () => {
    const emitter = new MailboxEventEmitter();
    const closeSseStreams = new Set<() => void>();
    const recorder = makeResponse();

    handleSse(
      makeRequest(),
      recorder.response,
      emitter,
      undefined,
      closeSseStreams,
      undefined,
      neverSettlingRevalidation,
    );

    // First keepalive fires at 15s; its revalidation never settles; the
    // timeout race must close the stream at +10s after that.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(recorder.ended).toBe(false);

    await vi.advanceTimersByTimeAsync(SSE_REVALIDATION_TIMEOUT_MS + 1);
    expect(recorder.ended).toBe(true);
    expect(recorder.chunks.join('')).not.toContain(': keepalive');
    expect(emitter.subscriberCount).toBe(0);
  });

  it('closes the stream when the delivery queue overflows', async () => {
    const emitter = new MailboxEventEmitter();
    const closeSseStreams = new Set<() => void>();
    const recorder = makeResponse();

    handleSse(
      makeRequest(),
      recorder.response,
      emitter,
      undefined,
      closeSseStreams,
      undefined,
      neverSettlingRevalidation,
    );

    // Fill the queue without flushing microtasks, so every operation is still
    // parked: the (cap + 1)-th enqueue must close the stream synchronously,
    // before any revalidation timeout has a chance to fire.
    for (let i = 0; i <= MAX_PENDING_SSE_OPERATIONS; i += 1) {
      emitter.emit(makeEvent({ messageId: `msg-${i}` }));
    }

    expect(recorder.ended).toBe(true);
    expect(closeSseStreams.size).toBe(0);
    expect(emitter.subscriberCount).toBe(0);

    await vi.advanceTimersByTimeAsync(SSE_REVALIDATION_TIMEOUT_MS + 1);
    expect(recorder.chunks.join('')).not.toContain('data:');
    expect(recorder.chunks.join('')).not.toContain(': keepalive');
  });

  it('closes the stream when revalidation resolves false', async () => {
    const emitter = new MailboxEventEmitter();
    const closeSseStreams = new Set<() => void>();
    const recorder = makeResponse();

    handleSse(
      makeRequest(),
      recorder.response,
      emitter,
      undefined,
      closeSseStreams,
      undefined,
      async () => false,
    );
    emitter.emit(makeEvent());
    await vi.advanceTimersByTimeAsync(0);

    expect(recorder.ended).toBe(true);
    expect(recorder.chunks.join('')).not.toContain('data:');
    expect(emitter.subscriberCount).toBe(0);
    expect(closeSseStreams.size).toBe(0);
  });
});
