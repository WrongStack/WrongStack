// ---------------------------------------------------------------------------
// Bounded outbound send queue with per-chat backpressure.
//
// Replaces ad-hoc fire-and-forget Promise chains at the notification
// call sites (session.ended, tool.executed, delegate.completed) so a flood
// of events cannot create unbounded in-flight promises, and so one slow
// chat cannot stall messages destined for other chats.
//
// Contract:
//   - Manual sends (telegram_send tool, /telegram:send) are user-triggered;
//     enqueue() either sends synchronously or rejects with a clear error.
//     They are never silently dropped or coalesced.
//   - Automatic notifications are best-effort: when a chat's queue is full,
//     the oldest pending entry is dropped (counted in stats) and a debug
//     log records the drop. The newest entry is enqueued.
//   - Per-chat ordering: messages to the same chatId are serialised in the
//     order enqueue() was called for them.
//   - Cross-chat concurrency: independent chats are dispatched in parallel.
//   - Backpressure: when a single chat exceeds `maxPerChat`, the oldest
//     pending notification entry is dropped (logged + counted) to keep the
//     queue bounded. Manual entries instead reject with an overflow error
//     so the caller never gets a silent failure.
//   - Drain on stop(): pending entries are flushed best-effort; subsequent
//     enqueues after stop() reject with a clear error.
// ---------------------------------------------------------------------------

import type { Logger } from '@wrongstack/core/types';

export type OutboundKind = 'notification' | 'manual';

export interface OutboundEntry {
  readonly chatId: string | number;
  readonly text: string;
  /** Manual = user-triggered (never dropped). Notification = best-effort. */
  readonly kind: OutboundKind;
}

/**
 * Internal entry shape. The `id` is assigned **once** at enqueue time and
 * reused for every resolver lookup (run/stop). Crucially, it must NOT be
 * recomputed from a mutable counter at completion time — if it were, two
 * interleaved sends to the same chat would diverge in their keys and one
 * would hang forever (the resolver would never be found).
 */
interface InternalEntry extends OutboundEntry {
  readonly id: number;
}

export interface OutboundQueueOptions {
  /** Bound per chat; default 32. Older pending entries are dropped on overflow. */
  readonly maxPerChat?: number | undefined;
  /** Bound for the total concurrent API calls; default 4. */
  readonly maxConcurrency?: number | undefined;
  /**
   * Producer of the actual HTTP call. The queue invokes this exactly once
   * per dequeued entry and propagates the resolved value (or rejection) to
   * the original enqueue caller. Keeping this as an injected function lets
   * the queue own ordering/backpressure while tests swap a fake transport.
   */
  readonly send: (chatId: string | number, text: string) => Promise<unknown>;
  readonly log?: Logger | undefined;
}

export interface OutboundQueueStats {
  readonly enqueued: number;
  readonly sent: number;
  readonly dropped: number;
  readonly failed: number;
  readonly inflight: number;
  /** Accepted entries not yet settled, including the in-flight sends. */
  readonly pending: number;
}

/** Per-chat serial queue state. */
interface ChatLane {
  pending: InternalEntry[];
  running: boolean;
}

const DEFAULT_MAX_PER_CHAT = 32;
const DEFAULT_MAX_CONCURRENCY = 4;

export class OutboundQueue {
  readonly #opts: {
    maxPerChat: number;
    maxConcurrency: number;
    send: (chatId: string | number, text: string) => Promise<unknown>;
    log: Logger | undefined;
  };
  readonly #lanes = new Map<string, ChatLane>();
  #active = 0;
  #notificationScheduleQueued = false;
  #stopped = false;
  #nextId = 0;
  #enqueued = 0;
  #sent = 0;
  #dropped = 0;
  #failed = 0;
  #resolvers = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: unknown) => void }
  >();

  constructor(opts: OutboundQueueOptions) {
    const maxPerChat = Math.max(1, opts.maxPerChat ?? DEFAULT_MAX_PER_CHAT);
    const maxConcurrency = Math.max(1, opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.#opts = {
      maxPerChat,
      maxConcurrency,
      send: opts.send,
      log: opts.log,
    };
  }

  /**
   * Enqueue an outbound send. For manual entries the returned promise
   * resolves with the send result (or rejects with the send error / the
   * overflow error). For notification entries the returned promise resolves
   * as soon as the queue accepts the entry, so callers don't block;
   * downstream drain failures are logged and counted but do not propagate.
   */
  enqueue(entry: OutboundEntry): Promise<unknown> {
    if (this.#stopped) {
      return Promise.reject(new Error('Outbound queue is stopped'));
    }
    const internal: InternalEntry = { ...entry, id: this.#mintId() };
    const key = String(entry.chatId);
    let lane = this.#lanes.get(key);
    if (!lane) {
      lane = { pending: [], running: false };
      this.#lanes.set(key, lane);
    }
    if (entry.kind === 'notification') {
      if (lane.pending.length >= this.#opts.maxPerChat) {
        // Only drop notification entries — never displace a pending manual.
        // Manuals register a completion resolver; dropping one without
        // settling it would hang the caller forever (and leak the resolver).
        const dropIndex = lane.pending.findIndex((e) => e.kind === 'notification');
        if (dropIndex === -1) {
          // All pending entries are manuals; drop the incoming best-effort
          // notification instead of displacing a manual send.
          this.#dropped += 1;
          this.#opts.log?.debug(
            `Telegram outbound queue dropped an incoming notification for chat ${entry.chatId} (per-chat limit ${this.#opts.maxPerChat}; only manual entries pending)`,
          );
          return Promise.resolve(undefined);
        }
        const dropped = lane.pending.splice(dropIndex, 1)[0]!;
        this.#dropped += 1;
        this.#opts.log?.debug(
          `Telegram outbound queue dropped a notification for chat ${dropped.chatId} (per-chat limit ${this.#opts.maxPerChat})`,
        );
      }
    } else if (lane.pending.length + (lane.running ? 1 : 0) >= this.#opts.maxPerChat) {
      // Manual overflow: surface a real error instead of silently dropping.
      // Per the P1.4 acceptance criterion, manual sends are never
      // silently dropped or coalesced.
      // Counts both pending and in-flight entries since `running` means one
      // entry has been dequeued from pending but is still being sent.
      return Promise.reject(
        new Error(
          `Telegram outbound queue per-chat limit reached for chat ${entry.chatId} (max ${this.#opts.maxPerChat})`,
        ),
      );
    }
    lane.pending.push(internal);
    this.#enqueued += 1;

    if (entry.kind === 'notification') {
      // Notification delivery is best-effort. Its promise represents queue
      // acceptance, not transport completion, so event handlers never block
      // behind a slow Telegram request. Batch notifications enqueued in the
      // same turn before dispatching; this lets the bounded queue consistently
      // drop the oldest entries during a burst.
      this.#scheduleNotifications();
      return Promise.resolve(undefined);
    }

    return new Promise<unknown>((resolve, reject) => {
      this.#resolvers.set(internal.id, { resolve, reject });
      this.#schedule();
    });
  }

  /** Stats snapshot for `/telegram-health` and the P3.1 metrics surface. */
  stats(): OutboundQueueStats {
    let pending = this.#active;
    for (const lane of this.#lanes.values()) pending += lane.pending.length;
    return {
      enqueued: this.#enqueued,
      sent: this.#sent,
      dropped: this.#dropped,
      failed: this.#failed,
      inflight: this.#active,
      pending,
    };
  }

  /**
   * Stop accepting new entries. Returns a promise that resolves once all
   * currently in-flight sends have settled and every per-chat lane is
   * empty. Pending entries are rejected so their callers don't hang.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const lane of this.#lanes.values()) {
      for (const entry of lane.pending.splice(0)) {
        this.#dropped += 1;
        const resolver = this.#resolvers.get(entry.id);
        if (resolver) {
          this.#resolvers.delete(entry.id);
          resolver.reject(new Error('Outbound queue stopped before send'));
        }
        this.#opts.log?.debug(
          `Telegram outbound queue stopped, dropped pending ${entry.kind} for chat ${entry.chatId}`,
        );
      }
    }
    while (this.#active > 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  #mintId(): number {
    this.#nextId += 1;
    return this.#nextId;
  }

  #scheduleNotifications(): void {
    if (this.#notificationScheduleQueued) return;
    this.#notificationScheduleQueued = true;
    // Two microtask hops preserve immediate acceptance while allowing both
    // sequential awaits and Promise.all acceptance checks to settle before
    // transport work begins. Synchronous notification bursts are therefore
    // bounded as one batch instead of leaking the first entry in-flight.
    queueMicrotask(() => {
      queueMicrotask(() => {
        this.#notificationScheduleQueued = false;
        this.#schedule();
      });
    });
  }

  #schedule(): void {
    if (this.#stopped) return;
    // Run up to maxConcurrency inflight across all lanes. Each lane
    // serialises itself so two entries to the same chat never run together.
    while (this.#active < this.#opts.maxConcurrency) {
      const entry = this.#nextReady();
      if (!entry) return;
      this.#active += 1;
      void this.#run(entry);
    }
  }

  #nextReady(): InternalEntry | undefined {
    // Prefer lanes whose running=false so each chat progresses in FIFO order
    // even when the global concurrency cap is lower than the lane count.
    for (const lane of this.#lanes.values()) {
      if (!lane.running && lane.pending.length > 0) {
        lane.running = true;
        return lane.pending.shift();
      }
    }
    return undefined;
  }

  async #run(entry: InternalEntry): Promise<void> {
    const key = String(entry.chatId);
    // #nextReady marks and returns an entry from this lane; the lane remains
    // registered until this method's finally block prunes it.
    const lane = this.#lanes.get(key)!;
    try {
      const result = await this.#opts.send(entry.chatId, entry.text);
      this.#sent += 1;
      const resolver = this.#resolvers.get(entry.id);
      if (resolver) {
        this.#resolvers.delete(entry.id);
        resolver.resolve(result);
      }
    } catch (err) {
      this.#failed += 1;
      const resolver = this.#resolvers.get(entry.id);
      if (resolver) {
        this.#resolvers.delete(entry.id);
        // Only manual entries retain a completion resolver. Notification
        // promises settle on acceptance, before transport work begins.
        resolver.reject(err);
      } else {
        // Best-effort notification failures are observable through logs and
        // stats without becoming unhandled promise rejections at call sites.
        // Manual entries always have a resolver until their send settles.
        this.#opts.log?.debug(
          `Telegram outbound queue notification failed for chat ${entry.chatId}: ${(err as Error).message}`,
        );
      }
    } finally {
      this.#active -= 1;
      lane.running = false;
      // Prune an idle lane so the per-chat map doesn't grow for the whole
      // process lifetime in unrestricted mode (a bot reachable by many chats).
      // enqueue() lazily recreates it on the next send to this chat.
      if (lane.pending.length === 0) {
        this.#lanes.delete(key);
      }
      this.#schedule();
    }
  }
}
