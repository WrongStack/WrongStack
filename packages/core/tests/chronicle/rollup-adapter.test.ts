import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChronicleJournal,
  createChronicleContext,
  wireRollupsToChronicle,
} from '../../src/chronicle/index.js';
import { EventBus } from '../../src/kernel/events.js';
const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
);

describe('Chronicle rollups', () => {
  it('turns process chunks and gauges into bounded aggregates and discards raw samples', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-rollup-'));
    dirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    const off = wireRollupsToChronicle({ events, journal, context, windowMs: 60_000 });
    for (const [bytes, hash] of [
      [10, 'a'],
      [30, 'b'],
      [20, 'c'],
    ] as const)
      events.emit('process.output', {
        sessionId: 's',
        toolCallId: 'tc',
        toolName: 'bash',
        parentPid: 1,
        stream: 'stdout',
        bytes,
        chunkHash: hash,
        at: new Date().toISOString(),
      } as never);
    events.emit('process.completed', {
      sessionId: 's',
      toolCallId: 'tc',
      toolName: 'bash',
      parentPid: 1,
      exitCode: 0,
      durationMs: 10,
      stdoutBytes: 60,
      stderrBytes: 0,
      timedOut: false,
      endedAt: new Date().toISOString(),
    } as never);
    events.emit('ctx.pct', { sessionId: 's', load: 0.2, tokens: 20, maxContext: 100 });
    events.emit('ctx.pct', { sessionId: 's', load: 0.8, tokens: 80, maxContext: 100 });
    off();
    const recorded = await journal.readAll();
    expect(recorded).toHaveLength(2);
    expect(recorded.every((event) => event.eventType === 'metrics.rollup')).toBe(true);
    expect(recorded[0]).toMatchObject({
      attributes: {
        signal: 'process.output',
        samples: 3,
        stats: { bytes: { sum: 60, min: 10, max: 30, avg: 20 } },
        rawEventsRetained: false,
      },
    });
    expect(recorded[1]).toMatchObject({
      attributes: {
        signal: 'ctx.pct',
        samples: 2,
        stats: { load: { min: 0.2, max: 0.8, avg: 0.5 }, tokens: { sum: 100, last: 80 } },
      },
    });
  });

  it('aggregates fleet snapshots and completed network requests into windows', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-rollup2-'));
    dirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    const off = wireRollupsToChronicle({ events, journal, context, windowMs: 60_000 });
    const agent = (over: Record<string, unknown>) => ({
      id: 'a',
      name: 'a',
      status: 'running',
      iterations: 1,
      toolCalls: 2,
      costUsd: 0.5,
      tokensIn: 100,
      tokensOut: 10,
      ...over,
    });
    events.emit('session.agents_updated', {
      sessionId: 's',
      agents: [agent({}), agent({ id: 'b', status: 'done' })],
    } as never);
    events.emit('session.agents_updated', {
      sessionId: 's',
      agents: [agent({ toolCalls: 4 })],
    } as never);
    for (const [statusCode, durationMs] of [
      [200, 10],
      [200, 30],
      [500, 50],
    ] as const) {
      events.emit('network.request.completed', {
        sessionId: 's',
        requestId: `r${durationMs}`,
        initiator: 'provider',
        operationName: 'op',
        method: 'POST',
        scheme: 'https',
        serverAddress: 'api.example.com',
        pathHash: 'h',
        statusCode,
        durationMs,
        completedAt: new Date().toISOString(),
      });
    }
    off();
    const recorded = await journal.readAll();
    const bySignal = new Map(
      recorded.map((event) => [(event.attributes as { signal: string }).signal, event]),
    );
    expect(bySignal.get('session.agents')).toMatchObject({
      attributes: {
        samples: 2,
        stats: {
          agents: { sum: 3, last: 1 },
          running: { sum: 2 },
          toolCalls: { sum: 8, max: 4 },
          costUsd: { sum: 1.5 },
        },
      },
    });
    expect(bySignal.get('network.request')).toMatchObject({
      attributes: {
        samples: 3,
        dimensions: { initiator: 'provider', serverAddress: 'api.example.com' },
        stats: { durationMs: { sum: 90, min: 10, max: 50, avg: 30 } },
        categories: { '2xx': 2, '5xx': 1 },
      },
    });
  });

  it('windows periodic health samples into one aggregate per session', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-rollup-health-'));
    dirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    const off = wireRollupsToChronicle({ events, journal, context, windowMs: 60_000 });
    const sample = (utilization: number, heapUsedBytes: number) => ({
      sessionId: 's',
      uptimeSeconds: 10,
      eventLoop: {
        utilization,
        activeMs: 1,
        idleMs: 1,
        delayMeanMs: 1,
        delayP95Ms: 2,
        delayMaxMs: 3,
      },
      cpu: { userMicros: 100, systemMicros: 10 },
      memory: {
        rssBytes: 1,
        heapTotalBytes: 2,
        heapUsedBytes,
        externalBytes: 0,
        arrayBuffersBytes: 0,
      },
      chronicle: { pendingEvents: 5, rejectedEvents: 1 },
    });
    events.emit('runtime.health.sampled' as never, sample(0.2, 1_000) as never);
    events.emit('runtime.health.sampled' as never, sample(0.6, 2_000) as never);
    off();
    const recorded = await journal.readAll();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      eventType: 'metrics.rollup',
      attributes: {
        signal: 'runtime.health',
        samples: 2,
        stats: {
          'eventLoop.utilization': { min: 0.2, max: 0.6, last: 0.6, avg: 0.4 },
          'memory.heapUsedBytes': { min: 1_000, max: 2_000, last: 2_000 },
          'chronicle.pendingEvents': { last: 5 },
          'chronicle.rejectedEvents': { last: 1 },
        },
      },
    });
  });

  it('windows per-call resource observations into one bounded rollup, keyed consistently with file.mutation.observed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-rollup-resource-'));
    dirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    const off = wireRollupsToChronicle({ events, journal, context, windowMs: 60_000 });
    events.emit('tool.executed', {
      sessionId: 's',
      agentId: 'leader',
      id: 'tc-1',
      name: 'grep',
      durationMs: 5,
      ok: true,
      metadata: {
        toolUseId: 'tc-1',
        toolName: 'grep',
        ok: true,
        summary: 's',
        errors: [],
        status: 'seen',
        referenceCount: 0,
        seenAt: 1,
        files: ['src/a.ts', 'src/b.ts'],
        symbols: ['Foo.bar'],
        commands: [],
      },
    } as never);
    // A tool call with no evidence at all must not produce an empty rollup.
    events.emit('tool.executed', {
      sessionId: 's',
      id: 'tc-2',
      name: 'noop',
      durationMs: 1,
      ok: true,
    } as never);
    off();
    const recorded = await journal.readAll();
    const rollup = recorded.find(
      (event) => (event.attributes as { signal?: string })?.signal === 'tool.resource.observed',
    );
    expect(rollup).toBeDefined();
    expect(rollup).toMatchObject({
      eventType: 'metrics.rollup',
      correlation: { toolCallId: 'tc-1' },
      attributes: {
        samples: 3,
        categories: { file: 2, symbol: 1 },
        resourceCount: 3,
        dimensions: { toolName: 'grep' },
      },
    });
    const resources = (
      rollup!.attributes as { resources: Array<{ id: string; kind: string; path?: string }> }
    ).resources;
    expect(resources).toHaveLength(3);
    expect(
      resources
        .filter((r) => r.kind === 'file')
        .map((r) => r.path)
        .sort(),
    ).toEqual(['src/a.ts', 'src/b.ts']);
    expect(recorded.filter((event) => event.eventType === 'tool.resource.observed')).toHaveLength(
      0,
    );
  });
});
