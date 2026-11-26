import { describe, expect, it } from 'vitest';
import { OutboundQueue } from '../../src/outbound-queue.js';

function createGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('OutboundQueue manual preemption over pending notifications', () => {
  it('evicts oldest pending notifications to admit a manual send at per-chat limit, and rejects only when no notifications remain', async () => {
    const started = createGate();
    const release = createGate();
    const sent: string[] = [];

    const queue = new OutboundQueue({
      maxConcurrency: 1,
      maxPerChat: 3,
      send: async (_chatId, text) => {
        if (text === 'm0') {
          started.resolve();
          await release.promise;
        }
        sent.push(text);
        return { ok: true, text };
      },
    });

    const p0 = queue.enqueue({ chatId: 10, text: 'm0', kind: 'manual' });
    await started.promise;

    await queue.enqueue({ chatId: 10, text: 'n1', kind: 'notification' });
    await queue.enqueue({ chatId: 10, text: 'n2', kind: 'notification' });
    await queue.enqueue({ chatId: 10, text: 'n3', kind: 'notification' });

    const p1 = queue.enqueue({ chatId: 10, text: 'm1', kind: 'manual' });
    const p2 = queue.enqueue({ chatId: 10, text: 'm2', kind: 'manual' });
    await expect(
      queue.enqueue({ chatId: 10, text: 'm3-overflow', kind: 'manual' }),
    ).rejects.toThrow(/per-chat limit reached/);

    release.resolve();
    await Promise.all([p0, p1, p2]);
    await queue.stop();

    expect(sent).toEqual(['m0', 'm1', 'm2']);
    expect(queue.stats().dropped).toBe(3);
  });
});

it.each([
  { maxPerChat: 1, drops: 0, next: 'notification' },
  { maxPerChat: 2, drops: 1, next: 'second manual' },
])(
  'only evicts a notification if a manual send fits (limit $maxPerChat)',
  async ({ maxPerChat, drops, next }) => {
    const release = Promise.withResolvers<void>();
    const sent: string[] = [];
    const queue = new OutboundQueue({
      maxPerChat,
      maxConcurrency: 1,
      send: async (_chatId, text) => {
        if (text === 'first manual') await release.promise;
        sent.push(text);
        return text;
      },
    });

    const first = queue.enqueue({ chatId: 10, text: 'first manual', kind: 'manual' });
    try {
      expect(queue.stats().inflight).toBe(1);
      await queue.enqueue({ chatId: 10, text: 'notification', kind: 'notification' });
      expect(queue.stats().pending).toBe(2);
      const second = queue.enqueue({ chatId: 10, text: 'second manual', kind: 'manual' });

      if (maxPerChat === 1) {
        await expect(second).rejects.toThrow(/per-chat limit reached/);
      } else {
        release.resolve();
        await expect(second).resolves.toBe('second manual');
      }
      release.resolve();
      await expect(first).resolves.toBe('first manual');
      expect(sent).toEqual(['first manual', next]);
      expect(queue.stats().dropped).toBe(drops);
    } finally {
      release.resolve();
      await first;
      await queue.stop();
    }
  },
);
