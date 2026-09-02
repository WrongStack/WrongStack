/**
 * Tests for chronicle/project-server-client.ts — isChronicleProjectServerAvailable
 * and ChronicleRemoteJournal batching logic with a mocked client.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  ChronicleRemoteJournal,
  isChronicleProjectServerAvailable,
  resolveChronicleProjectServerUrl,
} from '../../src/chronicle/project-server-client.js';
import type { ChronicleEventInput } from '../../src/chronicle/types.js';

// ── isChronicleProjectServerAvailable ────────────────────────────────────────

describe('isChronicleProjectServerAvailable', () => {
  it('returns a boolean', () => {
    const result = isChronicleProjectServerAvailable();
    expect(typeof result).toBe('boolean');
  });

  it.each([
    [
      'regular chronicle module',
      'file:///C:/repo/dist/chronicle/project-server-client.js',
      'file:///C:/repo/dist/chronicle/project-server.js',
    ],
    [
      'plugin bundle',
      'file:///C:/repo/dist/plugin/index.js',
      'file:///C:/repo/dist/chronicle/project-server.js',
    ],
    [
      'root bundle',
      'file:///C:/repo/dist/index.js',
      'file:///C:/repo/dist/chronicle/project-server.js',
    ],
  ])('resolves the detached server from the %s layout', (_label, moduleUrl, expectedUrl) => {
    const expectedPath = fileURLToPath(expectedUrl);
    const resolved = resolveChronicleProjectServerUrl(
      moduleUrl,
      (candidate) => candidate === expectedPath,
    );

    expect(resolved).not.toBeNull();
    expect(fileURLToPath(resolved!)).toBe(expectedPath);
  });
});

// ── ChronicleRemoteJournal ───────────────────────────────────────────────────

function makeMockClient() {
  let seq = 0;
  return {
    call: vi.fn(async (_op: string, args: { inputs?: unknown[] }) => {
      // Return one recorded event per input to satisfy the length check
      const count = args.inputs?.length ?? 0;
      return Array.from({ length: count }, () => ({
        eventId: `evt-${++seq}`,
        sequence: seq,
        hash: `hash-${seq}`,
        previousHash: seq === 1 ? '0'.repeat(64) : `hash-${seq - 1}`,
        occurredAt: new Date().toISOString(),
        observedAt: new Date().toISOString(),
        persistedAt: new Date().toISOString(),
        monotonicNs: String(seq),
      }));
    }),
    close: vi.fn(async () => {}),
  };
}

function makeJournalOpts(overrides: Record<string, unknown> = {}) {
  return {
    projectRoot: path.resolve('.'),
    globalRoot: path.resolve('.state'),
    projectId: 'project',
    projectDir: path.resolve('.state', 'project'),
    workspaceId: 'workspace',
    batchWindowMs: 10,
    maxPending: 100,
    ...overrides,
  };
}

function makeEventInput(overrides: Partial<ChronicleEventInput> = {}): ChronicleEventInput {
  return {
    eventType: 'test.event',
    scope: { projectId: 'p1', sessionId: 's1' },
    ...overrides,
  } as ChronicleEventInput;
}

describe('ChronicleRemoteJournal', { retry: 1 }, () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('batches events and flushes after the batch window', async () => {
    const client = makeMockClient();
    const journal = new ChronicleRemoteJournal(
      makeJournalOpts({ batchWindowMs: 10 }),
      client as never,
    );

    journal.append(makeEventInput({ eventType: 'event.1' }));
    journal.append(makeEventInput({ eventType: 'event.2' }));

    // Events are queued, not yet sent
    expect(client.call).not.toHaveBeenCalled();

    // Advance past the batch window
    await vi.advanceTimersByTimeAsync(15);

    // Now the batch should have been flushed
    expect(client.call).toHaveBeenCalledTimes(1);
    const [op, args] = client.call.mock.calls[0]!;
    expect(op).toBe('append');
    expect((args as { inputs: unknown[] }).inputs).toHaveLength(2);

    await journal.dispose();
  });

  it('tracks accepted event count', async () => {
    const client = makeMockClient();
    const journal = new ChronicleRemoteJournal(
      makeJournalOpts({ batchWindowMs: 5 }),
      client as never,
    );

    journal.append(makeEventInput());
    journal.append(makeEventInput());
    journal.append(makeEventInput());

    const stats = journal.stats();
    expect(stats.acceptedEvents).toBe(3);

    await journal.dispose();
  });

  it('dispose flushes remaining pending events', async () => {
    const client = makeMockClient();
    const journal = new ChronicleRemoteJournal(
      makeJournalOpts({ batchWindowMs: 1000 }),
      client as never,
    );

    journal.append(makeEventInput());
    journal.append(makeEventInput());

    // Dispose should flush immediately
    await journal.dispose();

    expect(client.call).toHaveBeenCalled();
  });

  it('dispose is idempotent', async () => {
    const client = makeMockClient();
    const journal = new ChronicleRemoteJournal(makeJournalOpts(), client as never);

    await journal.dispose();
    await journal.dispose(); // second call should not throw
  });

  it('stats returns counter snapshot', () => {
    const client = makeMockClient();
    const journal = new ChronicleRemoteJournal(makeJournalOpts(), client as never);

    const stats = journal.stats();
    expect(stats.acceptedEvents).toBe(0);
    expect(stats.persistedEvents).toBe(0);
    expect(stats.rejectedEvents).toBe(0);
    expect(stats.failedEvents).toBe(0);
    expect(stats.batches).toBe(0);
  });

  it('reports batch size in stats after flush', async () => {
    const client = makeMockClient();
    const journal = new ChronicleRemoteJournal(
      makeJournalOpts({ batchWindowMs: 5 }),
      client as never,
    );

    journal.append(makeEventInput());
    journal.append(makeEventInput());

    await vi.advanceTimersByTimeAsync(10);

    const stats = journal.stats();
    expect(stats.batches).toBe(1);
    expect(stats.largestBatch).toBe(2);

    await journal.dispose();
  });
});
