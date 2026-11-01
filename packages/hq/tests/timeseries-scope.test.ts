/**
 * Per-project and per-machine trend series: every cost and tool signal is
 * also attributed to where it came from, survives a flush and reload, and the
 * scoped view replaces fleet totals with that one breakdown.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HqTimeseriesStore, scopeTimeseriesSamples } from '../src/persistence.js';

const BUCKET_MS = 60_000;
let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-ts-scope-'));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

function fill(store: HqTimeseriesStore): void {
  store.record({ ts: 1_000, costUsd: 1, inputTokens: 10, projectId: 'alpha', machineKey: 'desk' });
  store.record({ ts: 2_000, costUsd: 2, inputTokens: 20, projectId: 'beta', machineKey: 'lab' });
  store.record({ ts: 3_000, toolCalls: 1, projectId: 'beta', machineKey: 'lab' });
  store.record({ ts: 61_000, costUsd: 4, projectId: 'alpha', machineKey: 'lab' });
  // A signal with no origin still counts toward the fleet total only.
  store.record({ ts: 62_000, costUsd: 8 });
}

describe('per-project and per-machine trend series', () => {
  it('attributes cost, tokens and tool calls to project and machine', async () => {
    const store = new HqTimeseriesStore({ dataDir, bucketMs: BUCKET_MS });
    await store.load();
    fill(store);
    const [first, second] = await store.read();
    expect(first?.costUsd).toBe(3);
    expect(first?.byProject).toEqual({
      alpha: { costUsd: 1, inputTokens: 10, outputTokens: 0 },
      beta: { costUsd: 2, inputTokens: 20, outputTokens: 0, toolCalls: 1 },
    });
    expect(first?.byMachine?.lab).toEqual({
      costUsd: 2,
      inputTokens: 20,
      outputTokens: 0,
      toolCalls: 1,
    });
    expect(second?.costUsd).toBe(12);
    expect(second?.byMachine).toEqual({ lab: { costUsd: 4, inputTokens: 0, outputTokens: 0 } });
  });

  it('keeps the breakdowns across a flush and a reload', async () => {
    const store = new HqTimeseriesStore({ dataDir, bucketMs: BUCKET_MS });
    await store.load();
    fill(store);
    store.flush();
    await store.drain();

    const reloaded = new HqTimeseriesStore({ dataDir, bucketMs: BUCKET_MS });
    await reloaded.load();
    const [first] = await reloaded.read();
    expect(first?.byProject?.beta?.toolCalls).toBe(1);
    expect(first?.byMachine?.desk?.costUsd).toBe(1);
  });

  it('narrows the series to one project or machine, zero where it was idle', async () => {
    const store = new HqTimeseriesStore({ dataDir, bucketMs: BUCKET_MS });
    await store.load();
    fill(store);
    const samples = await store.read();
    expect(scopeTimeseriesSamples(samples, { machineKey: 'lab' })).toEqual([
      { ts: 0, costUsd: 2, inputTokens: 20, outputTokens: 0, toolCalls: 1 },
      { ts: 60_000, costUsd: 4, inputTokens: 0, outputTokens: 0, toolCalls: 0 },
    ]);
    expect(scopeTimeseriesSamples(samples, { projectId: 'beta' })[1]).toEqual({
      ts: 60_000,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
    });
    expect(scopeTimeseriesSamples(samples, {})).toHaveLength(2);
  });
});

describe('breakdown keys come from clients', () => {
  it('keeps a "__proto__" key as data instead of rewriting the prototype', async () => {
    const store = new HqTimeseriesStore({ dataDir, bucketMs: BUCKET_MS });
    await store.load();
    store.record({ ts: 1_000, costUsd: 1, model: '__proto__', projectId: '__proto__' });
    store.record({ ts: 2_000, costUsd: 2, model: '__proto__', projectId: '__proto__' });
    const [sample] = await store.read();
    expect(Object.hasOwn(sample?.byModel ?? {}, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(sample?.byModel, '__proto__')?.value.costUsd).toBe(3);
    expect(scopeTimeseriesSamples([sample!], { projectId: '__proto__' })[0]?.costUsd).toBe(3);
    // A key that was never recorded reads as idle, not as the prototype.
    expect(scopeTimeseriesSamples([sample!], { projectId: 'constructor' })[0]?.costUsd).toBe(0);
  });
});
