import { mkdtemp, mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChronicleJournal,
  ChroniclePartitionRangeCache,
  ChronicleQueryEngine,
  createChronicleContext,
} from '../../src/chronicle/index.js';

const tempDirs: string[] = [];
afterEach(async () => Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('ChronicleQueryEngine', () => {
  it('queries partitions by causal, runtime, resource and nested attribute fields', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-query-'));
    tempDirs.push(dir);
    const partition = path.join(dir, 'chronicle', '2026-07-18.events.jsonl');
    const journal = new ChronicleJournal({ filePath: partition });
    const context = createChronicleContext({ installationId: 'i', machineId: 'm', projectId: 'p', sessionId: 's' }, 'trace');
    await journal.append({ eventType: 'tool.executed', scope: context.scope,
      correlation: { ...context.correlation, promptManifestId: 'prompt_1', toolCallId: 'tc-1' }, runtime: { providerId: 'openai', modelId: 'gpt-x' },
      resource: { kind: 'file', id: 'file:a', path: 'src/a.ts', lineStart: 10, lineEnd: 20 },
      outcome: 'success', occurredAt: '2026-07-18T10:00:00.000Z', attributes: { tool: { name: 'read' } } });
    await journal.append({ eventType: 'provider.attempt.failed', scope: context.scope,
      correlation: { ...context.correlation, attemptId: 'a-1' }, runtime: { providerId: 'openai', modelId: 'gpt-x' },
      outcome: 'failure', occurredAt: '2026-07-18T10:01:00.000Z' });
    await mkdir(path.join(dir, 'bad'), { recursive: true });
    await writeFile(path.join(dir, 'bad', '2026-07-17.events.jsonl'), '{bad}\n', 'utf8');

    const engine = await ChronicleQueryEngine.fromDirectory(dir);
    const result = await engine.query({ path: 'SRC\\A.TS', line: 15, attributes: { 'tool.name': 'read' } });

    expect(result.events.map((event) => event.eventType)).toEqual(['tool.executed']);
    expect(result).toMatchObject({ total: 1, scannedEvents: 2, sourceFiles: 2, invalidLines: 1 });
    expect(await engine.facet('eventType')).toEqual([
      { value: 'provider.attempt.failed', count: 1 },
      { value: 'tool.executed', count: 1 },
    ]);
    expect(engine.diagnostics.invalidLines).toBe(1);
    expect((await engine.query({ promptManifestId: 'prompt_1' })).events).toHaveLength(1);
  });

  it('discovers rolled partitions and preserves their numeric order', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-rolled-query-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({
      filePath: path.join(dir, '2026-07-18.events.jsonl'),
      maxPartitionSizeBytes: 1,
      rotationWindowMs: Infinity,
      batchWindowMs: 0,
    });
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    await journal.append({ eventType: 'base', ...context });
    await journal.append({ eventType: 'rolled-1', ...context });
    await journal.append({ eventType: 'rolled-2', ...context });

    const result = await (await ChronicleQueryEngine.fromDirectory(dir)).query({ order: 'asc' });
    expect(result.events.map((event) => event.eventType)).toEqual(['base', 'rolled-1', 'rolled-2']);
    expect(result.sourceFiles).toBe(3);
  });

  it('supports deterministic order and cursor pagination', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-page-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, '2026-07-18.events.jsonl') });
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    for (let index = 0; index < 3; index++) await journal.append({ eventType: `e${index}`, scope: context.scope,
      correlation: context.correlation, occurredAt: `2026-07-18T10:0${index}:00.000Z` });
    const engine = await ChronicleQueryEngine.fromDirectory(dir);
    const first = await engine.query({ order: 'asc', limit: 2 });
    expect(first.nextCursor).toBeDefined();
    const second = await engine.query({ order: 'asc', limit: 2, cursor: first.nextCursor! });
    expect(first.events.map((event) => event.eventType)).toEqual(['e0', 'e1']);
    expect(second.events.map((event) => event.eventType)).toEqual(['e2']);
  });

  it('paginates over a stable snapshot when the live journal grows', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-live-page-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, '2026-07-18.events.jsonl') });
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    for (let index = 0; index < 3; index++) await journal.append({
      eventType: `e${index}`,
      scope: context.scope,
      correlation: context.correlation,
      occurredAt: `2026-07-18T10:0${index}:00.000Z`,
    });
    const engine = await ChronicleQueryEngine.fromDirectory(dir);
    const first = await engine.query({ order: 'desc', limit: 2 });

    await journal.append({
      eventType: 'e3',
      scope: context.scope,
      correlation: context.correlation,
      occurredAt: '2026-07-18T10:03:00.000Z',
    });

    const second = await engine.query({ order: 'desc', limit: 2, cursor: first.nextCursor! });
    const fresh = await engine.query({ order: 'desc', limit: 2 });
    expect(first.events.map((event) => event.eventType)).toEqual(['e2', 'e1']);
    expect(second.events.map((event) => event.eventType)).toEqual(['e0']);
    expect(second.total).toBe(3);
    expect(fresh.events.map((event) => event.eventType)).toEqual(['e3', 'e2']);
  });

  it('rejects legacy deep-offset cursors instead of allocating offset-sized page state', async () => {
    const engine = await ChronicleQueryEngine.fromFiles([]);
    const deepOffset = Buffer.from(String(Number.MAX_SAFE_INTEGER), 'utf8').toString('base64url');
    await expect(engine.query({ cursor: deepOffset, limit: 1 })).rejects.toThrow('Invalid Chronicle cursor');
  });

  it('rejects cursor snapshots with duplicate or excessive partition IDs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-cursor-validation-'));
    tempDirs.push(dir);
    const partition = path.join(dir, 'cursor.events.jsonl');
    const journal = new ChronicleJournal({ filePath: partition });
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    await journal.append({ eventType: 'e0', ...context });
    await journal.append({ eventType: 'e1', ...context });
    const engine = await ChronicleQueryEngine.fromFiles([partition]);
    const first = await engine.query({ order: 'asc', limit: 1 });
    const cursor = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')) as {
      snapshot: Array<{ id: string; size: number }>;
    };

    cursor.snapshot.push({ ...cursor.snapshot[0]! });
    const duplicateCursor = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
    await expect(engine.query({ order: 'asc', limit: 1, cursor: duplicateCursor }))
      .rejects.toThrow('Invalid Chronicle cursor');

    cursor.snapshot = Array.from({ length: 10_001 }, (_, index) => ({ id: `partition-${index}`, size: 0 }));
    const excessiveCursor = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
    await expect(engine.query({ order: 'asc', limit: 1, cursor: excessiveCursor }))
      .rejects.toThrow('Invalid Chronicle cursor');
  });

  it('counts malformed envelopes and continues with later events in the partition', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-malformed-envelope-'));
    tempDirs.push(dir);
    const partition = path.join(dir, 'malformed.events.jsonl');
    const occurredAt = '2026-07-18T10:00:00.000Z';
    const validEvent = {
      schemaVersion: 1,
      eventId: 'valid',
      eventType: 'custom.event',
      scope: { installationId: 'i', machineId: 'm' },
      correlation: { traceId: 'trace', spanId: 'span' },
      occurredAt,
      observedAt: occurredAt,
      persistedAt: occurredAt,
      sequence: 2,
      previousHash: 'h1',
      hash: 'h2',
    };
    await writeFile(partition, [
      JSON.stringify({ eventId: 'malformed', eventType: 'custom.event', occurredAt }),
      JSON.stringify({ ...validEvent, eventId: 'bad-resource', sequence: 1,
        resource: { kind: 'file', id: 'file:bad', path: 42 } }),
      JSON.stringify(validEvent),
    ].join('\n') + '\n', 'utf8');

    const engine = await ChronicleQueryEngine.fromFiles([partition]);
    const result = await engine.query({ order: 'asc' });
    expect(result.events.map((event) => event.eventId)).toEqual(['valid']);
    expect(result).toMatchObject({ total: 1, scannedEvents: 1, invalidLines: 2 });
    expect(await engine.facet('eventType')).toEqual([{ value: 'custom.event', count: 1 }]);
    expect(engine.diagnostics.invalidLines).toBe(2);
  });

  it('computes multiple facets in one partition scan', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-facets-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'facets.events.jsonl') });
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    await journal.append({
      eventType: 'tool.executed',
      ...context,
      outcome: 'success',
      runtime: { providerId: 'openai' },
    });
    await journal.append({
      eventType: 'tool.executed',
      ...context,
      outcome: 'failure',
      runtime: { providerId: 'anthropic' },
    });
    await journal.append({
      eventType: 'provider.attempt.completed',
      ...context,
      outcome: 'success',
      runtime: { providerId: 'openai' },
    });

    const engine = await ChronicleQueryEngine.fromDirectory(dir);
    const facets = await engine.facets(['eventType', 'outcome', 'providerId']);

    expect(facets.eventType).toEqual([
      { value: 'tool.executed', count: 2 },
      { value: 'provider.attempt.completed', count: 1 },
    ]);
    expect(facets.outcome).toEqual([
      { value: 'success', count: 2 },
      { value: 'failure', count: 1 },
    ]);
    expect(facets.providerId).toEqual([
      { value: 'openai', count: 2 },
      { value: 'anthropic', count: 1 },
    ]);
  });

  it('orders the complete match set before applying pagination', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-order-'));
    tempDirs.push(dir);
    const earlyPartition = path.join(dir, 'early.events.jsonl');
    const latePartition = path.join(dir, 'late.events.jsonl');
    const event = (eventId: string, occurredAt: string, sequence: number) => ({
      schemaVersion: 1,
      eventId,
      eventType: 'custom.event',
      scope: { installationId: 'i', machineId: 'm' },
      correlation: { traceId: 'trace', spanId: `span-${sequence}` },
      occurredAt,
      observedAt: occurredAt,
      persistedAt: occurredAt,
      sequence,
      previousHash: '',
      hash: `h${sequence}`,
    });
    await writeFile(earlyPartition, [
      event('middle', '2026-07-18T10:02:00.000Z', 3),
      event('earliest', '2026-07-18T10:01:00.000Z', 2),
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    await writeFile(latePartition,
      `${JSON.stringify(event('latest', '2026-07-18T10:03:00.000Z', 1))}\n`);

    const engine = await ChronicleQueryEngine.fromFiles([latePartition, earlyPartition]);
    const ascending = await engine.query({ order: 'asc', limit: 1 });
    const descending = await engine.query({ order: 'desc', limit: 1 });
    expect(ascending.events[0]?.eventId).toBe('earliest');
    expect(descending.events[0]?.eventId).toBe('latest');
  });

  it('derives operation metrics from all matches without double-counting retries or cumulative cost snapshots', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-summary-')); tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.events.jsonl') });
    const context = createChronicleContext({ installationId: 'i', machineId: 'm', projectId: 'p', sessionId: 's' }, 'trace');
    const base = { scope: context.scope, occurredAt: '2026-07-18T10:00:00.000Z' };
    await journal.append({ ...base, eventType: 'provider.attempt.started', correlation: { ...context.correlation, logicalRequestId: 'r1', attemptId: 'a1' }, runtime: { providerId: 'p1', modelId: 'm1' } });
    await journal.append({ ...base, eventType: 'provider.attempt.failed', outcome: 'failure', durationNs: '100000000', correlation: { ...context.correlation, logicalRequestId: 'r1', attemptId: 'a1' }, runtime: { providerId: 'p1', modelId: 'm1' }, attributes: { retryScheduled: true } });
    await journal.append({ ...base, eventType: 'provider.attempt.started', correlation: { ...context.correlation, logicalRequestId: 'r1', attemptId: 'a2' }, runtime: { providerId: 'p1', modelId: 'm1' } });
    await journal.append({ ...base, eventType: 'provider.attempt.completed', outcome: 'success', durationNs: '300000000', correlation: { ...context.correlation, logicalRequestId: 'r1', attemptId: 'a2' }, runtime: { providerId: 'p1', modelId: 'm1' }, attributes: { usage: { input: 100, output: 20, cacheRead: 50 } } });
    await journal.append({ ...base, eventType: 'token.accounted', correlation: context.correlation, attributes: { cost: { total: 0.01 } } });
    await journal.append({ ...base, eventType: 'token.accounted', correlation: context.correlation, occurredAt: '2026-07-18T10:01:00.000Z', attributes: { cost: { total: 0.02 } } });
    await journal.append({ ...base, eventType: 'tool.failed', outcome: 'failure', correlation: { ...context.correlation, toolCallId: 't1' } });
    await journal.append({ ...base, eventType: 'tool.executed', outcome: 'failure', correlation: { ...context.correlation, toolCallId: 't1' } });
    const result = await (await ChronicleQueryEngine.fromDirectory(dir)).query({ limit: 1 });
    expect(result.events).toHaveLength(1);
    expect(result.summary).toMatchObject({ logicalRequests: 1, modelAttempts: 2, completedAttempts: 1,
      failedAttempts: 1, scheduledRetries: 1, inputTokens: 100, outputTokens: 20,
      cacheReadTokens: 50, estimatedCostUsd: 0.02, failedTools: 1, failures: 1,
      providerAvgDurationMs: 200, providerP95DurationMs: 300 });
  });

  it('uses deterministic cost snapshot ordering and allows a later zero reset', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-cost-order-'));
    tempDirs.push(dir);
    const partition = path.join(dir, 'cost.events.jsonl');
    const timestamp = '2026-07-18T10:00:00.000Z';
    const costEvent = (eventId: string, cost: number, sequence: number) => ({
      schemaVersion: 1,
      eventId,
      eventType: 'token.accounted',
      scope: { installationId: 'i', machineId: 'm', projectId: 'p' },
      correlation: { traceId: 'trace', spanId: `span-${sequence}` },
      attributes: { cost: { total: cost } },
      occurredAt: timestamp,
      observedAt: timestamp,
      persistedAt: timestamp,
      sequence,
      previousHash: '',
      hash: `h${sequence}`,
    });
    await writeFile(partition, [costEvent('cost', 3, 1), costEvent('reset', 0, 2)]
      .map((entry) => JSON.stringify(entry)).join('\n') + '\n');

    const engine = await ChronicleQueryEngine.fromFiles([partition]);
    expect((await engine.query({ order: 'asc' })).summary.estimatedCostUsd).toBe(0);
    expect((await engine.query({ order: 'desc' })).summary.estimatedCostUsd).toBe(0);
  });

  it('keeps the requested page and exact summary beyond the former buffer cap', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-large-'));
    tempDirs.push(dir);
    const partition = path.join(dir, 'large.events.jsonl');
    const handle = await open(partition, 'w');
    const total = 200_001;
    try {
      for (let index = 0; index < total; index += 1_000) {
        const lines: string[] = [];
        for (let offset = 0; offset < Math.min(1_000, total - index); offset++) {
          const sequence = index + offset;
          lines.push(JSON.stringify({
            schemaVersion: 1,
            eventId: `e${sequence}`,
            eventType: 'provider.attempt.started',
            scope: { installationId: 'i', machineId: 'm' },
            correlation: { traceId: 'trace', spanId: `span-${sequence}` },
            occurredAt: new Date(sequence).toISOString(),
            observedAt: new Date(sequence).toISOString(),
            persistedAt: new Date(sequence).toISOString(),
            sequence,
            previousHash: '',
            hash: `h${sequence}`,
          }));
        }
        await handle.write(`${lines.join('\n')}\n`);
      }
    } finally {
      await handle.close();
    }

    const engine = await ChronicleQueryEngine.fromFiles([partition]);
    const ascending = await engine.query({ order: 'asc', limit: 1 });
    const descending = await engine.query({ order: 'desc', limit: 1 });

    expect(ascending.events[0]?.eventId).toBe('e0');
    expect(descending.events[0]?.eventId).toBe(`e${total - 1}`);
    expect(ascending.summary.modelAttempts).toBe(total);
  });

  it('preserves UTF-8 characters that cross a reverse-read chunk boundary', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-utf8-'));
    tempDirs.push(dir);
    const partition = path.join(dir, 'utf8.events.jsonl');
    const marker = '🙂';
    const makeEvent = (eventId: string, text: string, sequence: number) => ({
      schemaVersion: 1,
      eventId,
      eventType: 'custom.event',
      scope: { installationId: 'i', machineId: 'm' },
      correlation: { traceId: 'trace', spanId: `span-${sequence}` },
      attributes: { text },
      occurredAt: new Date(sequence).toISOString(),
      observedAt: new Date(sequence).toISOString(),
      persistedAt: new Date(sequence).toISOString(),
      sequence,
      previousHash: '',
      hash: `h${sequence}`,
    });
    const suffixLine = JSON.stringify(makeEvent('suffix', 'suffix', 2));
    const serializedBoundary = JSON.stringify(makeEvent('boundary', '__PAYLOAD__', 1));
    const placeholderIndex = serializedBoundary.indexOf('__PAYLOAD__');
    expect(placeholderIndex).toBeGreaterThanOrEqual(0);
    const basePrefix = serializedBoundary.slice(0, placeholderIndex);
    const baseSuffix = serializedBoundary.slice(placeholderIndex + '__PAYLOAD__'.length);
    const tailBytes = Buffer.byteLength(`${baseSuffix}\n${suffixLine}\n`);
    const paddingLength = 64 * 1024 + 1 - Buffer.byteLength(marker) - tailBytes;
    const boundaryLine = `${basePrefix}${marker}${'x'.repeat(paddingLength)}${baseSuffix}`;
    const contents = `${boundaryLine}\n${suffixLine}\n`;
    expect(Buffer.byteLength(contents) - 64 * 1024).toBe(Buffer.byteLength(basePrefix) + 1);
    await writeFile(partition, contents, 'utf8');

    const result = await (await ChronicleQueryEngine.fromFiles([partition])).query({
      order: 'desc',
      text: marker,
      limit: 1,
    });

    expect(result.total).toBe(1);
    expect(result.events[0]?.eventId).toBe('boundary');
    expect(result.invalidLines).toBe(0);
  });

  it('builds typed causal edges without using timestamp proximity', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-graph-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, '2026-07-18.events.jsonl') });
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace-a');
    await journal.append({ eventType: 'decision.requested', scope: context.scope,
      correlation: { ...context.correlation, promptManifestId: 'prompt_graph' },
      attributes: { decisionId: 'decision-1' }, occurredAt: '2026-07-18T10:00:00.000Z' });
    await journal.append({ eventType: 'tool.executed', scope: context.scope,
      correlation: { ...context.correlation, promptManifestId: 'prompt_graph', toolCallId: 'tool-1' }, attributes: { decisionId: 'decision-1' },
      resource: { kind: 'file', id: 'file:a', path: 'a.ts' }, occurredAt: '2026-07-18T10:00:01.000Z' });
    await journal.append({ eventType: 'file.edited', scope: context.scope,
      correlation: { ...context.correlation, promptManifestId: 'prompt_graph', toolCallId: 'tool-1' }, resource: { kind: 'file', id: 'file:a', path: 'a.ts' },
      occurredAt: '2026-07-18T10:00:02.000Z' });
    const engine = await ChronicleQueryEngine.fromDirectory(dir);
    const graph = await engine.graph({ eventTypes: ['decision.requested'] });
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'decision', confidence: 'explicit' }),
      expect.objectContaining({ kind: 'tool_call', confidence: 'explicit' }),
      expect.objectContaining({ kind: 'prompt_manifest', confidence: 'explicit' }),
      expect.objectContaining({ kind: 'resource_lineage', confidence: 'inferred' }),
    ]));
  });

  it('derives resource_lineage edges from a windowed tool.resource.observed rollup', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-graph-rollup-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, '2026-07-18.events.jsonl') });
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace-b');
    // A mutation event for a.ts (as file.mutation.observed would record it)...
    await journal.append({ eventType: 'file.edited', scope: context.scope,
      correlation: { ...context.correlation, toolCallId: 'tool-2' }, resource: { kind: 'file', id: 'file_shared', path: 'a.ts' },
      occurredAt: '2026-07-18T11:00:00.000Z' });
    // ...and a windowed observation rollup (as rollup-adapter.ts now emits
    // instead of one raw tool.resource.observed event per file) that
    // references the SAME resource id plus a second, unrelated resource.
    await journal.append({ eventType: 'metrics.rollup', scope: context.scope,
      correlation: { ...context.correlation, toolCallId: 'tool-3' },
      attributes: { signal: 'tool.resource.observed', resources: [
        { id: 'file_shared', kind: 'file', path: 'a.ts' },
        { id: 'file_other', kind: 'file', path: 'b.ts' },
      ] },
      occurredAt: '2026-07-18T11:00:01.000Z' });
    const engine = await ChronicleQueryEngine.fromDirectory(dir);
    const graph = await engine.graph({ eventTypes: ['file.edited'] }, 1);
    expect(graph.nodes.map((node) => node.eventType).sort()).toEqual(['file.edited', 'metrics.rollup']);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'resource_lineage', confidence: 'inferred' }),
    ]));
  });

  describe('partition range pruning', () => {
    const rawEvent = (eventId: string, occurredAt: string, sequence: number) => ({
      schemaVersion: 1,
      eventId,
      eventType: 'custom.event',
      scope: { installationId: 'i', machineId: 'm' },
      correlation: { traceId: 'trace', spanId: `span-${sequence}` },
      occurredAt,
      observedAt: occurredAt,
      persistedAt: occurredAt,
      sequence,
      previousHash: '',
      hash: `h${sequence}`,
    });

    it('prunes closed partitions by their real observed occurredAt range, not by filename', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-range-prune-'));
      tempDirs.push(dir);
      // Closed file named for an old day but containing an event backdated
      // into the future — proves pruning can't rely on the filename's date.
      await writeFile(path.join(dir, '2020-01-01.events.jsonl'), [
        rawEvent('old-outside-window', '2020-01-01T00:00:00.000Z', 1),
        rawEvent('future-in-old-file', '2099-06-01T00:00:00.000Z', 2),
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      // A second closed file whose real content is entirely outside the window.
      await writeFile(path.join(dir, '2015-01-01.events.jsonl'),
        `${JSON.stringify(rawEvent('unrelated', '2015-01-01T00:00:00.000Z', 1))}\n`);
      // Active (last-sorted) file — always scanned; empty so it contributes nothing.
      await writeFile(path.join(dir, '2099-06-02.events.jsonl'), '');

      const engine = await ChronicleQueryEngine.fromDirectory(dir);
      const result = await engine.query({
        from: '2099-05-01T00:00:00.000Z',
        to: '2099-07-01T00:00:00.000Z',
      });

      expect(result.events.map((event) => event.eventId)).toEqual(['future-in-old-file']);
      expect(result.total).toBe(1);
    });

    it('never trusts a cached range for the active (still-open) partition', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-range-active-'));
      tempDirs.push(dir);
      const timestamp = '2050-03-01T00:00:00.000Z';
      await writeFile(path.join(dir, '2010-01-01.events.jsonl'), ''); // closed, empty, irrelevant
      const activeFilePath = path.join(dir, '2099-01-01.events.jsonl'); // sorts last -> active
      const activeContent = `${JSON.stringify(rawEvent('active-event', timestamp, 1))}\n`;
      await writeFile(activeFilePath, activeContent, 'utf8');

      const cache = new ChroniclePartitionRangeCache(dir);
      // Fabricate a range for the active file claiming it can't overlap the
      // query window below. If it were ever trusted, the real event would
      // be silently dropped.
      cache.set(activeFilePath, {
        size: Buffer.byteLength(activeContent, 'utf8'),
        minOccurredAt: '1999-01-01T00:00:00.000Z',
        maxOccurredAt: '1999-01-02T00:00:00.000Z',
      });

      const engine = await ChronicleQueryEngine.fromDirectory(dir, { rangeCache: cache });
      const result = await engine.query({
        from: '2050-01-01T00:00:00.000Z',
        to: '2050-12-31T00:00:00.000Z',
      });

      expect(result.events.map((event) => event.eventId)).toEqual(['active-event']);
    });

    it('trusts a closed partition\'s cached range instead of re-reading its contents', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-range-trust-'));
      tempDirs.push(dir);
      const timestamp = '2035-05-01T00:00:00.000Z';
      const closedFilePath = path.join(dir, '2020-04-01.events.jsonl');
      await writeFile(closedFilePath, `${JSON.stringify(rawEvent('real-match', timestamp, 1))}\n`, 'utf8');
      await writeFile(path.join(dir, '2099-04-02.events.jsonl'), ''); // active, empty

      const closedSize = (await stat(closedFilePath)).size;
      const cache = new ChroniclePartitionRangeCache(dir);
      // Fabricate a non-overlapping range even though the file's real content
      // (unread by this point) does contain a match for the query below.
      cache.set(closedFilePath, {
        size: closedSize,
        minOccurredAt: '1999-01-01T00:00:00.000Z',
        maxOccurredAt: '1999-01-02T00:00:00.000Z',
      });
      const query = { from: '2035-01-01T00:00:00.000Z', to: '2035-12-31T00:00:00.000Z' };

      const first = await ChronicleQueryEngine.fromDirectory(dir, { rangeCache: cache });
      expect((await first.query(query)).total).toBe(0);

      // A fresh engine sharing the same in-memory cache instance (mirrors
      // project-server.ts rebuilding ChronicleQueryEngine on every append)
      // must still trust the fabricated range without re-reading the file.
      const second = await ChronicleQueryEngine.fromDirectory(dir, { rangeCache: cache });
      expect((await second.query(query)).total).toBe(0);

      // A brand-new cache instance (simulating a process restart) reading
      // the persisted sidecar from disk must also still trust it.
      const thirdCache = new ChroniclePartitionRangeCache(dir);
      const third = await ChronicleQueryEngine.fromDirectory(dir, { rangeCache: thirdCache });
      expect((await third.query(query)).total).toBe(0);
    });

    it('leaves fromFiles-constructed engines fully unpruned', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-range-fromfiles-'));
      tempDirs.push(dir);
      const inWindow = path.join(dir, 'in-window.events.jsonl');
      const outOfWindow = path.join(dir, 'out-of-window.events.jsonl');
      await writeFile(inWindow, `${JSON.stringify(rawEvent('in-window', '2040-01-01T00:00:00.000Z', 1))}\n`);
      await writeFile(outOfWindow, `${JSON.stringify(rawEvent('out-of-window', '2010-01-01T00:00:00.000Z', 1))}\n`);

      const engine = await ChronicleQueryEngine.fromFiles([inWindow, outOfWindow]);
      const result = await engine.query({ from: '2039-01-01T00:00:00.000Z', to: '2041-01-01T00:00:00.000Z' });

      expect(result.events.map((event) => event.eventId)).toEqual(['in-window']);
      await expect(stat(path.join(dir, 'range-cache.json'))).rejects.toThrow();
    });
  });
});
