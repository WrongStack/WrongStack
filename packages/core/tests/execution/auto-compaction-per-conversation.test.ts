/**
 * Auto-compaction is a per-tab preference, applied by one shared middleware.
 *
 * The WebUI used to express "off" by REMOVING the middleware from the shared
 * context-window pipeline. With four tabs on one runtime that is a process
 * switch driven by a per-tab setting: turning auto-compaction off in one tab
 * stopped it for the three running beside it, and turning it back on re-armed
 * it for all of them — including conversations the user had deliberately left
 * un-compacted.
 *
 * The middleware now stays installed and decides per conversation, the same
 * way the permission policy decides YOLO.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { AutoCompactionMiddleware } from '../../src/execution/auto-compaction-middleware.js';

/** A context big enough to be over every threshold, with its own meta bag. */
function conversation(meta: Record<string, unknown>): Context {
  const messages = Array.from({ length: 400 }, () => ({
    role: 'user' as const,
    content: 'x'.repeat(4000),
  }));
  return {
    meta,
    messages,
    systemPrompt: [],
    tools: [],
    state: { messages, replaceMessages: vi.fn(), setMeta: vi.fn(), deleteMeta: vi.fn() },
    session: { id: 'sess' },
    clearFileTracking: vi.fn(),
    readFiles: new Set<string>(),
    fileMtimes: new Map<string, number>(),
  } as unknown as Context;
}

function middleware(compact: ReturnType<typeof vi.fn>) {
  return new AutoCompactionMiddleware({ compact } as never, 1000, undefined as never, {
    warn: 0.1,
    soft: 0.2,
    hard: 0.3,
  });
}

describe('auto-compaction decides per conversation', () => {
  it('skips the tab that turned it off while the instance is on', async () => {
    const compact = vi.fn(async () => ({ before: 100, after: 10 }));
    const mw = middleware(compact);
    mw.setEnabled(true);
    const next = vi.fn(async () => undefined);

    await mw.handler()(conversation({ contextAutoCompact: false }), next as never);

    expect(compact).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('still runs for the tab that left it on', async () => {
    const compact = vi.fn(async () => ({ before: 100, after: 10 }));
    const mw = middleware(compact);
    mw.setEnabled(false);
    const next = vi.fn(async () => undefined);

    await mw.handler()(conversation({ contextAutoCompact: true }), next as never);

    // The instance flag says off; this conversation says on, and it wins.
    expect(compact).toHaveBeenCalled();
  });

  it('falls back to the instance flag when a conversation states nothing', async () => {
    const compact = vi.fn(async () => ({ before: 100, after: 10 }));
    const mw = middleware(compact);
    mw.setEnabled(false);
    const next = vi.fn(async () => undefined);

    await mw.handler()(conversation({}), next as never);

    // A CLI or TUI keeps no per-session value, so its runtime switch is the
    // whole answer.
    expect(compact).not.toHaveBeenCalled();
  });
});
