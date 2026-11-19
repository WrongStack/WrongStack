import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChronicleJournal,
  createChronicleContext,
  wireProviderStreamsToChronicle,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('wireProviderStreamsToChronicle attemptId fencing and startedAt fallback', () => {
  it('ignores stale attempt completions when a newer attempt is active and flushes superseded attempts', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-stream-attempt-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', sessionId: 's1' },
      'trace-1',
    );
    const off = wireProviderStreamsToChronicle({ events, journal, context });

    try {
      events.emit('provider.attempt.started', {
        sessionId: 's1',
        agentId: 'leader',
        attemptId: 'a1',
        logicalRequestId: 'r1',
        providerId: 'openai',
        model: 'gpt-5',
        startedAt: new Date().toISOString(),
      } as never);
      events.emit('provider.text_delta', {
        sessionId: 's1',
        ctx: { agentId: 'leader' },
        text: 'stale',
      } as never);
      events.emit('provider.attempt.started', {
        sessionId: 's1',
        agentId: 'leader',
        attemptId: 'a2',
        logicalRequestId: 'r1',
        providerId: 'openai',
        model: 'gpt-5',
        startedAt: new Date().toISOString(),
      } as never);
      events.emit('provider.text_delta', {
        sessionId: 's1',
        ctx: { agentId: 'leader' },
        text: 'hello ',
      } as never);
      events.emit('provider.attempt.failed', {
        sessionId: 's1',
        agentId: 'leader',
        attemptId: 'a1',
      } as never);
      events.emit('provider.text_delta', {
        sessionId: 's1',
        ctx: { agentId: 'leader' },
        text: 'world',
      } as never);
      events.emit('provider.attempt.completed', {
        sessionId: 's1',
        agentId: 'leader',
        attemptId: 'a2',
      } as never);

      await journal.flush();
      const recorded = await journal.readAll();
      const a1 = recorded.find((e) => e.correlation.attemptId === 'a1');
      const a2 = recorded.find((e) => e.correlation.attemptId === 'a2');
      expect(a1?.outcome).toBe('failure');
      expect(a1?.attributes?.['textChunks']).toBe(1);
      expect(a2?.outcome).toBe('success');
      expect(a2?.attributes?.['textChunks']).toBe(2);
    } finally {
      off();
    }
  });

  it('falls back to finite startedAtMs when startedAt is unparseable', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-stream-nan-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', sessionId: 's2' },
      'trace-2',
    );
    const off = wireProviderStreamsToChronicle({ events, journal, context });

    try {
      events.emit('provider.attempt.started', {
        sessionId: 's2',
        agentId: 'leader',
        attemptId: 'a-bad-ts',
        logicalRequestId: 'r2',
        providerId: 'openai',
        model: 'gpt-5',
        startedAt: 'not-a-timestamp',
      } as never);
      events.emit('provider.text_delta', {
        sessionId: 's2',
        ctx: { agentId: 'leader' },
        text: 'hi',
      } as never);
      events.emit('provider.attempt.completed', {
        sessionId: 's2',
        agentId: 'leader',
        attemptId: 'a-bad-ts',
      } as never);

      await journal.flush();
      const recorded = await journal.readAll();
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.durationNs).not.toBe('NaN');
      expect(Number.isFinite(Number(recorded[0]?.durationNs))).toBe(true);
      expect(Number.isFinite(Number(recorded[0]?.attributes?.['firstChunkLatencyMs']))).toBe(true);
    } finally {
      off();
    }
  });
});
