import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChronicleJournal,
  createChronicleContext,
  wireProviderStreamsToChronicle,
} from '../../src/chronicle/index.js';
import { EventBus } from '../../src/kernel/events.js';
const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
);

describe('provider stream aggregation', () => {
  it('reduces high-frequency deltas to bounded timing, volume and hash metrics', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-stream-'));
    dirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    const off = wireProviderStreamsToChronicle({ events, journal, context });
    events.emit('provider.attempt.started', {
      sessionId: 's',
      logicalRequestId: 'r',
      attemptId: 'a',
      attempt: 0,
      providerId: 'openai',
      model: 'm',
      streaming: true,
      messageCount: 1,
      toolCount: 1,
      startedAt: new Date().toISOString(),
    });
    events.emit('provider.thinking_delta', {
      sessionId: 's',
      ctx: {} as never,
      text: 'private thought',
    });
    events.emit('provider.text_delta', {
      sessionId: 's',
      ctx: {} as never,
      text: 'private answer',
    });
    events.emit('provider.text_delta', { sessionId: 's', ctx: {} as never, text: ' more' });
    events.emit('provider.attempt.completed', {
      sessionId: 's',
      logicalRequestId: 'r',
      attemptId: 'a',
      attempt: 0,
      providerId: 'openai',
      model: 'm',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1,
      stopReason: 'end_turn',
      usage: { input: 1, output: 2 },
    });
    const recorded = await journal.readAll();
    off();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      eventType: 'provider.stream.summarized',
      attributes: { textChunks: 2, thinkingChunks: 1 },
    });
    expect(JSON.stringify(recorded)).not.toContain('private');
  });
});
