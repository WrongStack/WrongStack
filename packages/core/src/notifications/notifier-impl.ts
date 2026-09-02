/**
 * NotifierImpl — concrete implementation of the Notifier interface.
 *
 * Holds a registry of named NotificationChannel instances and dispatches
 * notify() calls to the matching channels. Tracks delivery counters per
 * channel for diagnostics and health reporting.
 *
 * Thread-safe: all public methods are re-entrant. `notify()` may be called
 * concurrently for different messages; each channel's `deliver()` runs in
 * its own Promise (no serialisation).
 *
 * @module notifications
 * @public
 */

import type { NotificationChannel, NotificationMessage, NotificationResult } from './types.js';
import type { NotificationChannelStatus, Notifier, NotifierCounters } from './notifier.js';

// ---------------------------------------------------------------------------
// Internal counter state
// ---------------------------------------------------------------------------

interface ChannelCounters {
  attempted: number;
  delivered: number;
  failed: number;
  suppressed: number;
}

function emptyCounters(): ChannelCounters {
  return { attempted: 0, delivered: 0, failed: 0, suppressed: 0 };
}

// ---------------------------------------------------------------------------
// NotifierImpl
// ---------------------------------------------------------------------------

export class NotifierImpl implements Notifier {
  readonly #channels = new Map<string, NotificationChannel>();
  readonly #counters = new Map<string, ChannelCounters>();
  /** Soft cap for #counters — prevents unbounded growth if channels are
   *  repeatedly registered with distinct names. */
  static readonly #MAX_COUNTERS = 100;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  notify(channels: string | string[], message: NotificationMessage): Promise<NotificationResult[]> {
    const names = typeof channels === 'string' ? [channels] : channels;
    if (names.length === 0) return Promise.resolve([]);

    const results: Promise<NotificationResult>[] = [];

    for (const name of names) {
      const channel = this.#channels.get(name);
      if (!channel) continue; // unknown names silently skipped

      const counters = this.#counters.get(name) ?? emptyCounters();
      counters.attempted += 1;
      this.#counters.set(name, counters);

      results.push(
        channel.deliver(message).then(
          (result) => {
            if (result.ok) {
              counters.delivered += 1;
            } else {
              counters.failed += 1;
            }
            return result;
          },
          (err: unknown) => {
            // Channel threw instead of returning { ok: false, error: "…" }.
            // Catch the rejection to prevent a single crashing channel from
            // tearing down every parallel delivery in the same notify() call.
            counters.failed += 1;
            const error = err instanceof Error ? err.message : 'unknown rejection';
            return {
              ok: false,
              channel: name,
              error: `threw: ${error}`,
              deliveredAt: new Date().toISOString(),
            } satisfies NotificationResult;
          },
        ),
      );
    }

    return Promise.all(results);
  }

  registerChannel(channel: NotificationChannel): void {
    this.#channels.set(channel.name, channel);
    if (!this.#counters.has(channel.name)) {
      // Evict oldest entry when at capacity to prevent unbounded growth.
      if (this.#counters.size >= NotifierImpl.#MAX_COUNTERS) {
        const oldest = this.#counters.keys().next();
        if (!oldest.done && oldest.value !== undefined) {
          this.#counters.delete(oldest.value);
        }
      }
      this.#counters.set(channel.name, emptyCounters());
    }
  }

  unregisterChannel(name: string): void {
    this.#channels.delete(name);
    // Keep counters for diagnostics even after unregistration.
  }

  async channels(): Promise<NotificationChannelStatus[]> {
    const entries = Array.from(this.#channels.entries());
    const results = await Promise.allSettled(
      entries.map(async ([name, channel]) => {
        try {
          const ping = await channel.ping();
          return { name, type: channel.type, ok: ping.ok, error: ping.error };
        } catch {
          return { name, type: channel.type, ok: false, error: 'ping threw' };
        }
      }),
    );
    return results.map((r) =>
      r.status === 'fulfilled'
        ? r.value
        : { name: 'unknown', type: 'unknown', ok: false, error: 'unhandled ping rejection' },
    );
  }

  counters(): NotifierCounters {
    let attempted = 0;
    let delivered = 0;
    let failed = 0;
    let suppressed = 0;
    for (const c of this.#counters.values()) {
      attempted += c.attempted;
      delivered += c.delivered;
      failed += c.failed;
      suppressed += c.suppressed;
    }
    return { attempted, delivered, failed, suppressed };
  }

  /**
   * Return per-channel counters for detailed diagnostics.
   * Not part of the `Notifier` interface — available on the concrete class.
   */
  perChannelCounters(): Record<string, { attempted: number; delivered: number; failed: number }> {
    const result: Record<string, { attempted: number; delivered: number; failed: number }> = {};
    for (const [name, c] of this.#counters) {
      result[name] = {
        attempted: c.attempted,
        delivered: c.delivered,
        failed: c.failed,
      };
    }
    return result;
  }
}
