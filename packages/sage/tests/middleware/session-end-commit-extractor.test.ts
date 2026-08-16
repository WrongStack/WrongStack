import { describe, expect, it, vi } from 'vitest';
import type { SageDomainTermExtractor } from '../../src/domain-term-extractor.js';
import { subscribeSessionEndCommitExtractor } from '../../src/middleware/session-end-commit-extractor.js';

type Disposable = () => void;
interface FakeBus {
  listeners: Map<string, Set<(payload: unknown) => void>>;
  on(event: string, fn: (payload: unknown) => void): Disposable;
  emit(event: string, payload: unknown): void;
  listenerCount(event: string): number;
}

function createFakeBus(): FakeBus {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    listeners,
    on(event, fn) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
      return () => {
        const live = listeners.get(event);
        if (!live) return;
        live.delete(fn);
        if (live.size === 0) listeners.delete(event);
      };
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const fn of [...set]) fn(payload);
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

interface ExtractorSpy {
  extractFromCommits: ReturnType<typeof vi.fn>;
  persistVia: ReturnType<typeof vi.fn>;
  persistViaAndMirror: ReturnType<typeof vi.fn>;
}

type ExtractorFactory = NonNullable<
  Parameters<typeof subscribeSessionEndCommitExtractor>[1]['createExtractor']
>;

function createExtractorSpy(extractImpl: () => Promise<unknown[]>): {
  factory: ExtractorFactory;
  spy: ExtractorSpy;
} {
  const extractFromCommits = vi.fn(extractImpl);
  const persistVia = vi.fn(async () => ({
    added: 0,
    updated: 0,
    skipped: 0,
    outcomes: [],
  }));
  const persistViaAndMirror = vi.fn(async () => ({
    report: {
      added: 0,
      updated: 0,
      skipped: 0,
      outcomes: [],
    },
    mirrorPath: null,
  }));
  return {
    factory: () =>
      ({
        extractFromCommits,
        persistVia,
        persistViaAndMirror,
      }) as unknown as SageDomainTermExtractor,
    spy: { extractFromCommits, persistVia, persistViaAndMirror },
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('subscribeSessionEndCommitExtractor', () => {
  it('calls extractFromCommits + persistViaAndMirror when terms are non-empty', async () => {
    const bus = createFakeBus();
    const memoryPort = { marker: Symbol('memory-port') };
    const { factory, spy } = createExtractorSpy(async () => [
      { term: 'Mailbox Bridge', confidence: 0.82, sources: ['commit'] },
    ]);

    const unsubscribe = subscribeSessionEndCommitExtractor(
      bus as unknown as Parameters<typeof subscribeSessionEndCommitExtractor>[0],
      {
        memory: memoryPort as unknown as Parameters<
          typeof subscribeSessionEndCommitExtractor
        >[1]['memory'],
        projectRoot: '/tmp/repo',
        createExtractor: factory,
      },
    );

    expect(bus.listenerCount('session.ended')).toBe(1);

    bus.emit('session.ended', {
      id: 'session-1',
      sessionId: 'session-1',
      usage: { input: 0, output: 0 },
    });
    await flushMicrotasks();

    expect(spy.extractFromCommits).toHaveBeenCalledTimes(1);
    expect(spy.extractFromCommits).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: '/tmp/repo' }),
    );
    expect(spy.persistViaAndMirror).toHaveBeenCalledTimes(1);
    // Domain-term persistence was removed: the third argument is
    // now `{ projectRoot }` only — no `sourceRefs`, because there is
    // no memory write to attribute the source to. The mirror refresh
    // is still driven from the in-memory terms of the current pass.
    expect(spy.persistViaAndMirror).toHaveBeenCalledWith(
      memoryPort,
      expect.arrayContaining([expect.objectContaining({ term: 'Mailbox Bridge' })]),
      expect.objectContaining({ projectRoot: '/tmp/repo' }),
    );

    unsubscribe();
    expect(bus.listenerCount('session.ended')).toBe(0);
  });

  it('skips persistence when no terms are extracted (cheap no-op path)', async () => {
    const bus = createFakeBus();
    const memoryPort = { marker: Symbol('memory-port') };
    const { factory, spy } = createExtractorSpy(async () => []);

    subscribeSessionEndCommitExtractor(
      bus as unknown as Parameters<typeof subscribeSessionEndCommitExtractor>[0],
      {
        memory: memoryPort as unknown as Parameters<
          typeof subscribeSessionEndCommitExtractor
        >[1]['memory'],
        projectRoot: '/tmp/repo',
        createExtractor: factory,
      },
    );

    bus.emit('session.ended', { id: 'session-2', sessionId: 'session-2' });
    await flushMicrotasks();

    expect(spy.extractFromCommits).toHaveBeenCalledTimes(1);
    expect(spy.persistVia).not.toHaveBeenCalled();
    expect(spy.persistViaAndMirror).not.toHaveBeenCalled();
  });

  it('registers the in-flight extraction with payload.waitUntil when the host supplies a join hook', async () => {
    const bus = createFakeBus();
    const memoryPort = { marker: Symbol('memory-port') };
    let resolveExtract: (value: unknown[]) => void = () => undefined;
    const { factory, spy } = createExtractorSpy(
      () =>
        new Promise<unknown[]>((resolve) => {
          resolveExtract = resolve;
        }),
    );

    subscribeSessionEndCommitExtractor(
      bus as unknown as Parameters<typeof subscribeSessionEndCommitExtractor>[0],
      {
        memory: memoryPort as unknown as Parameters<
          typeof subscribeSessionEndCommitExtractor
        >[1]['memory'],
        projectRoot: '/tmp/repo',
        createExtractor: factory,
      },
    );

    const tracked: Array<Promise<void>> = [];
    bus.emit('session.ended', {
      id: 'session-3',
      sessionId: 'session-3',
      waitUntil: (work: Promise<void>) => {
        tracked.push(work);
      },
    });

    // The listener must have called waitUntil synchronously and
    // registered the in-flight extraction promise before resolving it.
    expect(tracked.length).toBe(1);
    resolveExtract([{ term: 'Board Projector', confidence: 0.9, sources: ['commit'] }]);
    await tracked[0]!;
    expect(spy.persistViaAndMirror).toHaveBeenCalledTimes(1);
  });

  it('falls back to fire-and-forget when payload.waitUntil is absent (older host shape)', async () => {
    const bus = createFakeBus();
    const memoryPort = { marker: Symbol('memory-port') };
    const { factory, spy } = createExtractorSpy(async () => [
      { term: 'Glossary Renderer', confidence: 0.7, sources: ['commit'] },
    ]);

    subscribeSessionEndCommitExtractor(
      bus as unknown as Parameters<typeof subscribeSessionEndCommitExtractor>[0],
      {
        memory: memoryPort as unknown as Parameters<
          typeof subscribeSessionEndCommitExtractor
        >[1]['memory'],
        projectRoot: '/tmp/repo',
        createExtractor: factory,
      },
    );

    // No waitUntil in the payload — must not throw.
    expect(() =>
      bus.emit('session.ended', { id: 'session-4', sessionId: 'session-4' }),
    ).not.toThrow();
    await flushMicrotasks();
    expect(spy.extractFromCommits).toHaveBeenCalledTimes(1);
    expect(spy.persistViaAndMirror).toHaveBeenCalledTimes(1);
  });

  it('swallows extractor errors so a failed commit scan does not abort the session', async () => {
    const bus = createFakeBus();
    const memoryPort = { marker: Symbol('memory-port') };
    const { factory, spy } = createExtractorSpy(async () => {
      throw new Error('git not found');
    });

    subscribeSessionEndCommitExtractor(
      bus as unknown as Parameters<typeof subscribeSessionEndCommitExtractor>[0],
      {
        memory: memoryPort as unknown as Parameters<
          typeof subscribeSessionEndCommitExtractor
        >[1]['memory'],
        projectRoot: '/tmp/repo',
        createExtractor: factory,
      },
    );

    expect(() =>
      bus.emit('session.ended', { id: 'session-5', sessionId: 'session-5' }),
    ).not.toThrow();
    await flushMicrotasks();
    expect(spy.extractFromCommits).toHaveBeenCalledTimes(1);
    expect(spy.persistVia).not.toHaveBeenCalled();
    expect(spy.persistViaAndMirror).not.toHaveBeenCalled();
  });
});
