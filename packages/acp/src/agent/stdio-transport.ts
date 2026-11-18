/**
 * StdioTransport — bidirectional stdin/stdout communication for ACP.
 *
 * ACP uses newline-delimited JSON-RPC 2.0 messages over stdio:
 *   client → agent:  JSON-RPC request/notification on stdin
 *   agent  → client: JSON-RPC response/notification on stdout
 *
 * Legacy startup marker support remains for older internal harnesses, but
 * standard ACP agents must not write non-JSON data to stdout.
 */
import { expectDefined } from '@wrongstack/core/utils';
import type { ACPMessage } from '../types/acp-messages.js';
import type { QueuedMessage } from './client-transport.js';
import {
  DEFAULT_MAX_FRAME_CHARS,
  DEFAULT_MAX_QUEUED_CHARS,
  DEFAULT_MAX_QUEUED_MESSAGES,
  positiveLimit,
  spawnInvocation,
  takeLines,
  verbatimOptions,
} from './client-transport.js';

export type {
  ACPChildProcess,
  ACPClientTransport,
  ClientTransportOptions,
} from './client-transport.js';
export { ClientTransport } from './client-transport.js';

export interface AgentServerTransport {
  send(msg: ACPMessage): Promise<void>;
  sendRaw(chunk: string): void;
  read(): Promise<ACPMessage | null>;
  /**
   * Register an observer that fires for every inbound message — including
   * messages that resolve a parked `read()` call.
   *
   * Dual-fire contract: a message is delivered to BOTH the `read()`
   * promise (if one is parked) AND every handler registered here. The
   * legacy behavior was "no fire while read() is parked"; the new
   * behavior was adopted to fix a deadlock when a JSON-RPC reply
   * arrived before the next read() call (handlers that correlate
   * responses to outbound requests would never see it). Handlers MUST
   * tolerate being called for every inbound message and MUST NOT
   * assume the message has not also been delivered to read().
   *
   * To consume a message exclusively (prevent it from being enqueued for
   * read()), use `onMessageClaim()` instead. Most observers want
   * `onMessage`; correlation handlers and the protocol layer want
   * `onMessageClaim`.
   */
  onMessage(handler: (msg: ACPMessage) => void): () => void;
  /**
   * Register a handler that MAY claim a message by returning `true`.
   * Claimed messages are NOT enqueued for the read() loop. Required
   * for the server transport so the correlation handler (which always
   * fires) doesn't starve the read loop of pipelined requests and
   * notifications. See `onMessageClaim` on the implementations.
   */
  onMessageClaim?(handler: (msg: ACPMessage) => boolean): () => void;
}

export class StdioTransport implements AgentServerTransport {
  private readonly stdin = process.stdin;
  private readonly stdout = process.stdout;
  private readonly stderr = process.stderr;

  private buffer = '';
  private readonly handlers = new Set<(msg: ACPMessage) => void>();
  private readonly claimHandlers = new Set<(msg: ACPMessage) => boolean>();
  private closed = false;
  /** stdin ended: queued requests are still read and answered, then read() ends. */
  private inputEnded = false;
  private readonly pendingReads: Array<(msg: ACPMessage | null) => void> = [];
  private messageQueue: QueuedMessage[] = [];
  private queuedChars = 0;
  private readonly maxFrameChars: number;
  private readonly maxQueuedMessages: number;
  private readonly maxQueuedChars: number;
  private readonly onStdinData = (chunk: string): void => this.onData(chunk);
  private readonly onStdinEnd = (): void => this.handleClose();
  private readonly onStdinError = (err: Error): void => this.failAll(err);

  constructor(
    opts: { maxFrameChars?: number; maxQueuedMessages?: number; maxQueuedChars?: number } = {},
  ) {
    this.maxFrameChars = positiveLimit(opts.maxFrameChars, DEFAULT_MAX_FRAME_CHARS);
    this.maxQueuedMessages = positiveLimit(opts.maxQueuedMessages, DEFAULT_MAX_QUEUED_MESSAGES);
    this.maxQueuedChars = positiveLimit(opts.maxQueuedChars, DEFAULT_MAX_QUEUED_CHARS);
    this.stdin.resume();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', this.onStdinData);
    this.stdin.on('end', this.onStdinEnd);
    this.stdin.on('error', this.onStdinError);
  }

  sendStartupMarker(): void {
    this.stdout.write('[wstack-acp]\n', 'utf8');
  }

  send(msg: ACPMessage): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const line = JSON.stringify(msg) + '\n';
      this.stdout.write(line, 'utf8', () => resolve());
    });
  }

  sendRaw(chunk: string): void {
    this.stdout.write(chunk, 'utf8');
  }

  read(): Promise<ACPMessage | null> {
    if (this.messageQueue.length > 0) {
      const queued = expectDefined(this.messageQueue.shift());
      this.queuedChars = Math.max(0, this.queuedChars - queued.chars);
      return Promise.resolve(queued.message);
    }
    if (this.closed || this.inputEnded) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.pendingReads.push(resolve);
    });
  }

  onMessage(handler: (msg: ACPMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Register a handler that MAY claim a message by returning `true`.
   * Claimed messages are NOT enqueued for the read() loop — they are
   * considered fully consumed by the handler. This is how the ACP
   * server transport prevents the correlation handler (which always
   * fires on every message but only actually correlates responses)
   * from starving the read() loop of pipelined requests, notifications,
   * and any message the handler chose to ignore. See dispatch() for
   * the gating logic.
   */
  onMessageClaim(handler: (msg: ACPMessage) => boolean): () => void {
    this.claimHandlers.add(handler);
    return () => this.claimHandlers.delete(handler);
  }

  close(): void {
    this.closed = true;
    this.stdin.off('data', this.onStdinData);
    this.stdin.off('end', this.onStdinEnd);
    this.stdin.off('error', this.onStdinError);
    this.stdin.pause();
    for (const resolve of this.pendingReads.splice(0)) resolve(null);
    this.buffer = '';
    this.messageQueue.length = 0;
    this.queuedChars = 0;
    this.handlers.clear();
    this.claimHandlers.clear();
  }

  private onData(chunk: string): void {
    if (this.closed) return;
    const { lines, pending } = takeLines(this.buffer, chunk);
    this.buffer = pending;
    if (this.buffer.length > this.maxFrameChars) {
      this.stderr.write(
        `[wstack-acp frame error] pending frame exceeds ${this.maxFrameChars} characters\n`,
        'utf8',
      );
      this.close();
      return;
    }

    for (const raw of lines) {
      if (this.closed) return;
      if (!raw.trim()) continue;
      if (raw.length > this.maxFrameChars) {
        this.stderr.write(
          `[wstack-acp frame error] frame exceeds ${this.maxFrameChars} characters\n`,
          'utf8',
        );
        this.close();
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        // A `null`/primitive frame would reach read() as a falsy message, which
        // the agent read loop takes as end-of-stream and shuts down.
        if (parsed === null || typeof parsed !== 'object') {
          throw new Error('frame is not a JSON-RPC object');
        }
        this.dispatch(parsed as ACPMessage, raw.length);
      } catch (err) {
        this.stderr.write(`[wstack-acp parse error] ${err}\n`, 'utf8');
      }
    }
  }

  private dispatch(msg: ACPMessage, chars = JSON.stringify(msg).length): void {
    const resolve = this.pendingReads.shift();
    if (resolve) {
      resolve(msg);
    } else {
      // Claim handlers run first and MAY consume a message exclusively by
      // returning `true`; claimed messages are NOT enqueued for read().
      // The previous `handlers.size === 0` gate silently dropped messages
      // whenever ACPProtocolHandler had registered its correlation handler
      // (it always does), starving the read() loop of pipelined requests,
      // notifications, and any message a handler chose to ignore. Gate on
      // consumption, not presence: if no claim handler consumed the
      // message, buffer it for the read() loop.
      //
      // Claim handlers signal consumption by returning `true` from a
      // wrapper registered via `onMessageClaim()`. The legacy `onMessage()`
      // contract stays void-returning for backwards compatibility; a
      // handler that wants to both observe AND claim wraps itself in the
      // claim variant. This avoids forcing every existing call site to
      // change its signature.
      let claimed = false;
      for (const handler of this.claimHandlers) {
        try {
          if (handler(msg)) claimed = true;
        } catch (err) {
          this.stderr.write(`[wstack-acp handler error] ${err}\n`, 'utf8');
        }
      }
      if (this.closed) return;
      if (!claimed) {
        if (
          this.messageQueue.length >= this.maxQueuedMessages ||
          this.queuedChars + chars > this.maxQueuedChars
        ) {
          this.stderr.write(
            `[wstack-acp queue error] pending message queue exceeds ${this.maxQueuedMessages} entries or ${this.maxQueuedChars} characters\n`,
            'utf8',
          );
          this.close();
          return;
        }
        this.messageQueue.push({ message: msg, chars });
        this.queuedChars += chars;
      }
    }
    // Dual-fire: notify EVERY registered observer for every inbound message
    // — including one that just resolved a parked read(). This matches the
    // onMessage contract (see the interface doc) and ClientTransport.dispatch,
    // and is what lets ACPProtocolHandler's correlation handler
    // (maybeResolvePending) resolve a pending server→client request whose
    // reply arrives while read() is parked. Running the observer loop only
    // in the non-parked branch (the previous shape) delivered such a reply
    // solely to the read() loop — which ignores responses — so the outbound
    // request timed out despite the comment above the parked branch claiming
    // listeners were still notified.
    for (const handler of this.handlers) {
      try {
        handler(msg);
      } catch (err) {
        this.stderr.write(`[wstack-acp handler error] ${err}\n`, 'utf8');
      }
    }
  }

  /**
   * End of input is not the end of the connection: requests that already
   * arrived stay queued for read(), and their replies (and those of prompts
   * still running) are still written. The agent closes the transport once
   * read() has drained the queue and reported the end.
   */
  private handleClose(): void {
    // A last frame without its newline is still a complete request at EOF.
    if (this.buffer.trim()) this.onData('\n');
    this.inputEnded = true;
    this.stdin.off('data', this.onStdinData);
    this.stdin.off('end', this.onStdinEnd);
    for (const resolve of this.pendingReads.splice(0)) resolve(null);
  }

  private failAll(err: Error): void {
    this.stderr.write(`[wstack-acp stdin error] ${err.message}\n`, 'utf8');
    this.close();
  }
}

// ---------------------------------------------------------------------------
// ClientTransport — spawns a child ACP agent process (DIR-1)
// ---------------------------------------------------------------------------

/** Direct-module test seam; not re-exported by the package barrel. */
export const stdioTransportCoverage = { positiveLimit, spawnInvocation, verbatimOptions };
