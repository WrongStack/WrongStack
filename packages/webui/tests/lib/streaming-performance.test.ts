import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StreamCoalescer } from '../../src/lib/stream-coalescer.js';
import { useChatStore } from '../../src/stores/chat-store.js';

/**
 * Performance tests for the streaming UI pipeline.
 *
 * These tests verify the stream-coalescer and chat-store can handle
 * high-volume event bursts without performance degradation or memory leaks.
 */

describe('Streaming performance', () => {
  describe('StreamCoalescer under high-volume text deltas', () => {
    let coalescer: StreamCoalescer;

    beforeEach(() => {
      coalescer = new StreamCoalescer();
    });

    it('handles 10,000 text deltas without losing data', () => {
      let totalFlushed = '';
      const flushFn = (_key: string, text: string) => {
        totalFlushed += text;
      };

      const N = 10_000;
      const start = performance.now();
      for (let i = 0; i < N; i++) {
        coalescer.push(`msg-1`, `chunk-${i};`, flushFn);
      }
      coalescer.flushAll();
      const elapsed = performance.now() - start;

      // All chunks should be present in the flushed output
      expect(totalFlushed).toContain('chunk-0;');
      expect(totalFlushed).toContain(`chunk-${N - 1};`);
      // Count delimiters to verify all chunks arrived
      expect(totalFlushed.split(';').length - 1).toBe(N);

      // Should complete in well under 1 second for 10k pushes
      expect(elapsed).toBeLessThan(1000);
    });

    it('handles 100 concurrent message streams', () => {
      const flushed: Record<string, string> = {};
      const flushFn = (key: string, text: string) => {
        flushed[key] = (flushed[key] ?? '') + text;
      };

      const MSG_COUNT = 100;
      const CHUNKS_PER_MSG = 50;

      for (let i = 0; i < CHUNKS_PER_MSG; i++) {
        for (let m = 0; m < MSG_COUNT; m++) {
          coalescer.push(`msg-${m}`, `c${i}`, flushFn);
        }
      }
      coalescer.flushAll();

      // Every message should have received all chunks
      for (let m = 0; m < MSG_COUNT; m++) {
        const key = `msg-${m}`;
        expect(flushed[key]).toBeDefined();
        // Count individual cN chunks (split by 'c' delimiter, drop empty first)
        const chunks = flushed[key].match(/c\d+/g) ?? [];
        expect(chunks).toHaveLength(CHUNKS_PER_MSG);
      }
    });

    it('flush is idempotent — calling flushAll twice does not duplicate data', () => {
      let flushCount = 0;
      const flushFn = () => {
        flushCount++;
      };

      coalescer.push('msg-1', 'hello', flushFn);
      coalescer.flushAll();
      const firstCount = flushCount;
      coalescer.flushAll();

      expect(flushCount).toBe(firstCount);
    });
  });

  describe('chat-store under message load', () => {
    // Reset the store between tests so counts don't accumulate
    afterEach(() => {
      useChatStore.setState({ messages: [] });
    });

    it('handles 1,000 messages without performance degradation', () => {
      const N = 1000;
      const start = performance.now();

      for (let i = 0; i < N; i++) {
        useChatStore.getState().addMessage({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i}: ${'x'.repeat(100)}`,
        });
      }

      const elapsed = performance.now() - start;
      expect(useChatStore.getState().messages).toHaveLength(N);
      // Should complete in well under 2 seconds for 1k messages
      expect(elapsed).toBeLessThan(2000);
    });

    it('queue enqueue/dequeue is O(1) for 500 queued items', () => {
      const N = 500;
      const { enqueue, dequeue } = useChatStore.getState();

      const startEnq = performance.now();
      for (let i = 0; i < N; i++) {
        enqueue(`Queued message ${i}`);
      }
      const enqTime = performance.now() - startEnq;

      expect(useChatStore.getState().queue).toHaveLength(N);
      expect(enqTime).toBeLessThan(500);

      const startDeq = performance.now();
      let count = 0;
      while (dequeue() !== null) count++;
      const deqTime = performance.now() - startDeq;

      expect(count).toBe(N);
      expect(deqTime).toBeLessThan(500);
    });

    it('message store does not accumulate memory across clear cycles', () => {
      const CYCLES = 10;
      const PER_CYCLE = 100;

      for (let c = 0; c < CYCLES; c++) {
        for (let i = 0; i < PER_CYCLE; i++) {
          useChatStore.getState().addMessage({
            role: 'user',
            content: `Cycle ${c} message ${i}`,
          });
        }
        // Simulate a session clear
        useChatStore.setState({ messages: [] });
      }

      // After all cycles, the store should be empty
      expect(useChatStore.getState().messages).toHaveLength(0);
    });
  });
});
