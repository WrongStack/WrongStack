/**
 * rAF-batched stream coalescer.
 *
 * Provider chunks (text_delta / thinking_delta / tool.progress) arrive far
 * faster than the screen refreshes — sometimes dozens per frame. Pushing each
 * one straight into the zustand store triggers a store broadcast + a full
 * ChatView re-render + a regroup per chunk, which is the dominant CPU cost
 * while a long reply streams.
 *
 * This coalescer buffers incoming text per key and flushes at most once per
 * animation frame via a single combined write. The visible result is identical
 * (text still appears in order) but the store mutates ~60×/s instead of
 * once-per-token. Callers that need the buffer drained synchronously (run
 * end, finalize, tool result) call `flush(key)` or `flushAll()`.
 *
 * Falls back to a microtask when requestAnimationFrame is unavailable (e.g.
 * jsdom under vitest) so behaviour stays deterministic in tests.
 */

type FlushFn = (key: string, text: string) => void;

interface Pending {
  buffer: string;
  flush: FlushFn;
}

const raf: (cb: () => void) => void =
  typeof requestAnimationFrame === 'function'
    ? (cb) => {
        requestAnimationFrame(cb);
      }
    : (cb) => {
        queueMicrotask(cb);
      };

export class StreamCoalescer {
  private pending = new Map<string, Pending>();
  private scheduled = false;

  /**
   * Queue `text` under `key`, to be flushed via `flush(key, joinedText)` on the
   * next frame. Repeated calls for the same key before a flush concatenate.
   * The `flush` callback is captured per key from the latest push.
   */
  push(key: string, text: string, flush: FlushFn): void {
    if (!text) return;
    const existing = this.pending.get(key);
    if (existing) {
      existing.buffer += text;
      existing.flush = flush;
    } else {
      this.pending.set(key, { buffer: text, flush });
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    raf(() => {
      this.scheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.pending.size === 0) return;
    // Snapshot then clear, so a flush callback that re-enters push() (re-arming
    // the next frame) doesn't lose or double-emit the current batch.
    const batch = Array.from(this.pending.entries());
    this.pending.clear();
    for (const [key, p] of batch) {
      if (p.buffer) p.flush(key, p.buffer);
    }
  }

  /** Discard a key's buffered text without flushing. Used when the thinking
   *  buffer is cleared (model started replying) so a pending thinking delta
   *  can't re-populate it a frame later. */
  drop(key: string): void {
    this.pending.delete(key);
  }

  /** Drain a single key immediately (if buffered). Safe to call when empty. */
  flush(key: string): void {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    if (p.buffer) p.flush(key, p.buffer);
  }

  /** Drain every buffered key immediately. Call at run end / before finalize. */
  flushAll(): void {
    this.drain();
  }
}

/** Shared singleton used by the WS handlers. */
export const streamCoalescer = new StreamCoalescer();
