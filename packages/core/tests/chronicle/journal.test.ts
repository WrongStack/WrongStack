import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  childChronicleContext,
  ChronicleJournal,
  createChronicleContext,
} from '../../src/chronicle/index.js';

const tempDirs: string[] = [];
const T0 = '2026-07-17T20:42:18.381Z';

async function makeJournal(): Promise<ChronicleJournal> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-chronicle-'));
  tempDirs.push(dir);
  let id = 0;
  return new ChronicleJournal({
    filePath: path.join(dir, 'events.jsonl'),
    now: () => new Date('2026-07-17T20:42:18.381Z'),
    monotonicNow: () => 42n,
    idFactory: () => `event-${++id}`,
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ChronicleJournal', () => {
  it('persists ordered, hash-chained project events', async () => {
    const journal = await makeJournal();
    const context = createChronicleContext(
      {
        installationId: 'install-1',
        machineId: 'machine-1',
        projectId: 'project-1',
        sessionId: 'session-1',
      },
      'trace-1',
    );

    const first = await journal.append({
      eventType: 'provider.attempt.started',
      ...context,
      outcome: 'started',
      runtime: { providerId: 'openai', modelId: 'model-a' },
    });
    const second = await journal.append({
      eventType: 'file.read.completed',
      ...childChronicleContext(context, { correlation: { toolCallId: 'tool-1' } }),
      outcome: 'success',
      resource: { kind: 'file', id: 'file-1', path: 'src/auth.ts', lineStart: 40, lineEnd: 120 },
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(second.previousHash).toBe(first.hash);
    expect(second.scope.projectId).toBe('project-1');
    expect(second.correlation.parentSpanId).toBe(context.correlation.spanId);
    await expect(journal.verify()).resolves.toMatchObject({
      ok: true,
      entries: 2,
      lastSequence: 2,
    });
  });

  it('serializes concurrent appends without losing sequence numbers', async () => {
    const journal = await makeJournal();
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        journal.append({
          eventType: 'tool.progress',
          ...context,
          attributes: { index },
        }),
      ),
    );
    const entries = await journal.readAll();
    expect(entries.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(journal.stats()).toMatchObject({
      acceptedEvents: 12,
      persistedEvents: 12,
      batches: 1,
      largestBatch: 12,
      pendingEvents: 0,
    });
    await expect(journal.verify()).resolves.toMatchObject({ ok: true, entries: 12 });
  });

  it('applies bounded backpressure without blocking the caller thread', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-chronicle-pressure-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({
      filePath: path.join(dir, 'events.jsonl'),
      maxPending: 2,
      batchWindowMs: 25,
    });
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    const first = journal.append({ eventType: 'one', ...context });
    const second = journal.append({ eventType: 'two', ...context });
    await expect(journal.append({ eventType: 'three', ...context })).rejects.toThrow(
      'backpressure limit',
    );
    await Promise.all([first, second]);
    expect(journal.stats()).toMatchObject({
      acceptedEvents: 2,
      persistedEvents: 2,
      rejectedEvents: 1,
    });
  });

  it('continues the hash chain after rotation and process restart', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-chronicle-restart-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, '2026-07-18.events.jsonl');
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    const options = {
      filePath,
      maxPartitionSizeBytes: 1,
      rotationWindowMs: Infinity,
      batchWindowMs: 0,
    };

    const firstProcess = new ChronicleJournal(options);
    const first = await firstProcess.append({ eventType: 'first', ...context });
    const second = await firstProcess.append({ eventType: 'second', ...context });
    expect(second.sequence).toBe(2);
    expect(firstProcess.path).toContain('.00001.jsonl');

    const restarted = new ChronicleJournal(options);
    const third = await restarted.append({ eventType: 'third', ...context });
    expect(third.sequence).toBe(3);
    expect(third.previousHash).toBe(second.hash);
    expect(first.sequence).toBe(1);
    await expect(restarted.verify()).resolves.toMatchObject({
      ok: true,
      entries: 3,
      lastSequence: 3,
    });
  });

  it('serializes independent journal instances through one base lock', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-chronicle-instances-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, '2026-07-18.events.jsonl');
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    const options = { filePath, batchWindowMs: 0, rotationWindowMs: Infinity };
    const left = new ChronicleJournal(options);
    const right = new ChronicleJournal(options);

    const events = await Promise.all([
      left.append({ eventType: 'left', ...context }),
      right.append({ eventType: 'right', ...context }),
    ]);

    expect(events.map((event) => event.sequence).sort((a, b) => a - b)).toEqual([1, 2]);
    await expect(left.verify()).resolves.toMatchObject({ ok: true, entries: 2, lastSequence: 2 });
  });

  it('invalidates cached state after another instance appends and rotates', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-chronicle-interleaved-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, '2026-07-18.events.jsonl');
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    const options = {
      filePath,
      batchWindowMs: 0,
      rotationWindowMs: Infinity,
      maxPartitionSizeBytes: 1,
    };
    const left = new ChronicleJournal(options);
    const right = new ChronicleJournal(options);

    const first = await left.append({ eventType: 'left.first', ...context });
    const second = await right.append({ eventType: 'right.second', ...context });
    const third = await left.append({ eventType: 'left.third', ...context });

    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3]);
    expect(third.previousHash).toBe(second.hash);
    expect(left.path).toContain('.00002.jsonl');
    await expect(left.verify()).resolves.toMatchObject({ ok: true, entries: 3, lastSequence: 3 });
  });

  it('detects post-hoc payload tampering', async () => {
    const journal = await makeJournal();
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    await journal.append({
      eventType: 'tool.completed',
      ...context,
      attributes: { output: 'safe' },
    });

    const raw = await readFile(journal.path, 'utf8');
    await writeFile(journal.path, raw.replace('safe', 'tampered'), 'utf8');

    await expect(journal.verify()).resolves.toMatchObject({
      ok: false,
      brokenAt: 0,
      reason: 'entry hash mismatch',
    });
  });

  it('purge dry-run reports the oldest removable prefix without deleting it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-purge-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({
      filePath: path.join(dir, 'test.events.jsonl'),
      maxPartitionSizeBytes: 1,
      rotationWindowMs: Infinity,
      batchWindowMs: 0,
    });
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    await journal.append({ eventType: 'old', ...context });
    await journal.append({ eventType: 'recent', ...context });
    await journal.append({ eventType: 'active', ...context });

    const oldest = path.join(dir, 'test.events.jsonl');
    const recent = path.join(dir, 'test.events.00001.jsonl');
    const { utimes } = await import('node:fs/promises');
    await utimes(oldest, new Date(Date.now() - 5 * 86400000), new Date(Date.now() - 5 * 86400000));
    await utimes(recent, new Date(Date.now() - 2 * 86400000), new Date(Date.now() - 2 * 86400000));

    const result = await journal.purge({ retentionDays: 3, dryRun: true, files: [oldest, recent] });

    expect(result).toMatchObject({ deletedCount: 0, candidates: [oldest] });
    await expect(readFile(oldest, 'utf8')).resolves.toBeTruthy();
    await expect(readFile(recent, 'utf8')).resolves.toBeTruthy();
  });

  it('purge deletes old rotated partitions and preserves the active partition', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-purge-hard-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({
      filePath: path.join(dir, 'active.events.jsonl'),
      maxPartitionSizeBytes: 1,
      rotationWindowMs: Infinity,
      batchWindowMs: 0,
    });
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    await journal.append({ eventType: 'old', ...context });
    await journal.append({ eventType: 'active', ...context });

    const activePath = journal.path;
    const oldFile = path.join(dir, 'active.events.jsonl');
    const { utimes } = await import('node:fs/promises');
    await utimes(
      oldFile,
      new Date(Date.now() - 30 * 86400000),
      new Date(Date.now() - 30 * 86400000),
    );

    const result = await journal.purge({ retentionDays: 7, files: [activePath, oldFile] });

    expect(result).toMatchObject({ deletedCount: 1, skippedCount: 1, errors: [] });
    await expect(readFile(activePath, 'utf8')).resolves.toBeTruthy();
    await expect(readFile(oldFile, 'utf8')).rejects.toThrow();
    await expect(journal.verify()).resolves.toMatchObject({
      ok: true,
      entries: 1,
      lastSequence: 2,
    });

    const restarted = new ChronicleJournal({
      filePath: oldFile,
      maxPartitionSizeBytes: 1,
      rotationWindowMs: Infinity,
      batchWindowMs: 0,
    });
    const next = await restarted.append({ eventType: 'after-retention', ...context });
    expect(next).toMatchObject({ sequence: 3 });
    await expect(restarted.verify()).resolves.toMatchObject({
      ok: true,
      entries: 2,
      lastSequence: 3,
    });
  });

  it('validates checkpoint-covered bytes that remain after a purge interruption', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-purge-recovery-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'recovery.events.jsonl');
    const journal = new ChronicleJournal({
      filePath,
      maxPartitionSizeBytes: 1,
      rotationWindowMs: Infinity,
      batchWindowMs: 0,
    });
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    await journal.append({ eventType: 'old', ...context, attributes: { value: 'safe' } });
    await journal.append({ eventType: 'active', ...context });
    const retainedBytes = await readFile(filePath, 'utf8');
    const { utimes } = await import('node:fs/promises');
    await utimes(filePath, new Date(0), new Date(0));

    await journal.purge({ retentionDays: 1, files: [filePath] });
    // Model a crash/failure after the checkpoint rename but before unlink:
    // the checkpoint exists, yet its source partition is visible again.
    await writeFile(filePath, retainedBytes, 'utf8');
    await expect(journal.verify()).resolves.toMatchObject({ ok: true, lastSequence: 2 });

    await writeFile(filePath, retainedBytes.replace('safe', 'evil'), 'utf8');
    await expect(journal.verify()).resolves.toMatchObject({
      ok: false,
      reason: 'entry hash mismatch',
    });
  });

  it('rejects caller-supplied files outside the Chronicle partition boundary', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-purge-boundary-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'active.events.jsonl') });
    const victim = path.join(dir, 'victim.txt');
    await writeFile(victim, 'keep me', 'utf8');
    const { utimes } = await import('node:fs/promises');
    await utimes(victim, new Date(0), new Date(0));

    const result = await journal.purge({ retentionDays: 1, files: [victim] });

    expect(result).toMatchObject({ deletedCount: 0, skippedCount: 1 });
    expect(result.errors[0]?.reason).toMatch(/not a Chronicle journal partition/);
    await expect(readFile(victim, 'utf8')).resolves.toBe('keep me');
  });

  it('auto-purge discovers old daily journal families and preserves the active day', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-autopurge-'));
    tempDirs.push(dir);
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    const oldPath = path.join(dir, '2026-07-15.events.jsonl');
    const oldJournal = new ChronicleJournal({ filePath: oldPath, batchWindowMs: 0 });
    await oldJournal.append({ eventType: 'old', ...context });
    const { utimes } = await import('node:fs/promises');
    await utimes(
      oldPath,
      new Date(Date.now() - 30 * 86400000),
      new Date(Date.now() - 30 * 86400000),
    );

    const journal = new ChronicleJournal({
      filePath: path.join(dir, '2026-07-18.events.jsonl'),
      retentionDays: 1,
      autoPurgeIntervalMs: 0,
      batchWindowMs: 0,
      now: () => new Date(T0),
    });
    await journal.append({ eventType: 'fresh', ...context });

    await expect
      .poll(async () =>
        readFile(oldPath, 'utf8').then(
          () => false,
          () => true,
        ),
      )
      .toBe(true);
    await expect(readFile(journal.path, 'utf8')).resolves.toBeTruthy();
  });
});
