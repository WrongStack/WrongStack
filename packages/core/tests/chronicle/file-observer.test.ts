import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChronicleJournal,
  createChronicleContext,
  startChronicleFileObserver,
} from '../../src/chronicle/index.js';
import { EventBus } from '../../src/kernel/events.js';
import type { ChronicleJournalStats } from '../../src/chronicle/journal.js';
import type { ChronicleEventSink } from '../../src/chronicle/sink.js';
import { CHRONICLE_SCHEMA_VERSION } from '../../src/chronicle/types.js';
import type { ChronicleEvent, ChronicleEventInput } from '../../src/chronicle/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Sink double whose `appendBatch` rejects the first `failuresBeforeSuccess`
 * calls, then records normally — a journal write error, or a dead
 * project-server socket, that recovers on the next attempt.
 */
class FlakyBatchSink implements ChronicleEventSink {
  readonly recorded: ChronicleEventInput[] = [];
  failures = 0;
  private readonly failuresBeforeSuccess: number;
  private sequence = 0;

  constructor(failuresBeforeSuccess: number) {
    this.failuresBeforeSuccess = failuresBeforeSuccess;
  }

  append(input: ChronicleEventInput): Promise<ChronicleEvent> {
    return Promise.resolve(this.toEvent(input));
  }

  appendBatch(inputs: readonly ChronicleEventInput[]): Promise<ChronicleEvent[]> {
    if (this.failures < this.failuresBeforeSuccess) {
      this.failures++;
      return Promise.reject(new Error('simulated appendBatch chunk failure'));
    }
    this.recorded.push(...inputs);
    return Promise.resolve(inputs.map((input) => this.toEvent(input)));
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  stats(): ChronicleJournalStats {
    return {
      acceptedEvents: this.recorded.length,
      persistedEvents: this.recorded.length,
      rejectedEvents: 0,
      failedEvents: this.failures,
      batches: this.recorded.length > 0 ? 1 : 0,
      pendingEvents: 0,
      maxObservedPending: 0,
      largestBatch: this.recorded.length,
      partitionRolls: 0,
    };
  }

  private toEvent(input: ChronicleEventInput): ChronicleEvent {
    this.sequence++;
    const at = new Date().toISOString();
    return {
      ...input,
      schemaVersion: CHRONICLE_SCHEMA_VERSION,
      eventId: `evt-${this.sequence}`,
      observedAt: at,
      persistedAt: at,
      sequence: this.sequence,
      previousHash: '',
      hash: '',
    };
  }
}

/**
 * Sink double WITHOUT `appendBatch` — exercises the per-`append` fallback
 * commit path. `append` rejects exactly once for events targeting
 * `failPath`, then records normally.
 */
class FailingAppendSink implements ChronicleEventSink {
  readonly recorded: ChronicleEventInput[] = [];
  private failedOnce = false;
  private readonly failPath: string;
  private sequence = 0;

  constructor(failPath: string) {
    this.failPath = failPath;
  }

  append(input: ChronicleEventInput): Promise<ChronicleEvent> {
    if (!this.failedOnce && input.resource?.path === this.failPath) {
      this.failedOnce = true;
      return Promise.reject(new Error('simulated append failure'));
    }
    this.recorded.push(input);
    return Promise.resolve(this.toEvent(input));
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  stats(): ChronicleJournalStats {
    return {
      acceptedEvents: this.recorded.length,
      persistedEvents: this.recorded.length,
      rejectedEvents: 0,
      failedEvents: this.failedOnce ? 1 : 0,
      batches: 0,
      pendingEvents: 0,
      maxObservedPending: 0,
      largestBatch: this.recorded.length,
      partitionRolls: 0,
    };
  }

  private toEvent(input: ChronicleEventInput): ChronicleEvent {
    this.sequence++;
    const at = new Date().toISOString();
    return {
      ...input,
      schemaVersion: CHRONICLE_SCHEMA_VERSION,
      eventId: `evt-${this.sequence}`,
      observedAt: at,
      persistedAt: at,
      sequence: this.sequence,
      previousHash: '',
      hash: '',
    };
  }
}

/**
 * Sink that ALWAYS rejects — every commit unit fails, so nothing ever
 * lands. Used to prove close() surfaces a failed final drain.
 */
class AlwaysFailSink implements ChronicleEventSink {
  append(): Promise<ChronicleEvent> {
    return Promise.reject(new Error('journal permanently unavailable'));
  }

  appendBatch(): Promise<ChronicleEvent[]> {
    return Promise.reject(new Error('journal permanently unavailable'));
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  stats(): ChronicleJournalStats {
    return {
      acceptedEvents: 0,
      persistedEvents: 0,
      rejectedEvents: 0,
      failedEvents: 0,
      batches: 0,
      pendingEvents: 0,
      maxObservedPending: 0,
      largestBatch: 0,
      partitionRolls: 0,
    };
  }
}

async function waitForEvent(journal: ChronicleJournal, predicate: (type: string) => boolean) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const found = (await journal.readAll()).find((event) => predicate(event.eventType));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('timed out waiting for Chronicle filesystem event');
}

describe('startChronicleFileObserver', () => {
  it('records external edits and deletes with previous content identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-files-'));
    tempDirs.push(root);
    await mkdir(path.join(root, 'src'));
    const file = path.join(root, 'src', 'value.ts');
    await writeFile(file, 'export const value = 1;\n');
    const journal = new ChronicleJournal({
      filePath: path.join(root, '.wrongstack', 'chronicle.jsonl'),
    });
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', projectId: 'p' },
      'trace',
    );
    const observer = await startChronicleFileObserver({
      projectRoot: root,
      journal,
      context,
      debounceMs: 25,
    });

    await writeFile(file, 'export const value = 2;\n');
    const modified = await waitForEvent(journal, (type) => type === 'file.external.modified');
    expect(modified.resource).toMatchObject({ kind: 'file', path: 'src/value.ts' });
    expect(modified.attributes).toMatchObject({
      actor: 'external',
      operation: 'edit',
      source: 'external',
    });
    expect(modified.attributes?.['previousHash']).toMatch(/^[a-f0-9]{64}$/);

    await unlink(file);
    const deleted = await waitForEvent(journal, (type) => type === 'file.external.deleted');
    expect(deleted.attributes).toMatchObject({ actor: 'external', operation: 'delete' });
    await observer.close();
  });

  it('ignores the tool workspace, including worktrees under .claude', async () => {
    // A git worktree is a full copy of the repository. With `.claude` watched,
    // creating one reported every tracked file as an external creation and
    // removing it reported every file again — on this repo that was 90% of a
    // day's telemetry, all of it the tool observing itself.
    const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-files-workspace-'));
    tempDirs.push(root);
    await mkdir(path.join(root, '.claude', 'worktrees', 'feature', 'src'), { recursive: true });
    await mkdir(path.join(root, 'src'), { recursive: true });
    const journal = new ChronicleJournal({
      filePath: path.join(root, '.wrongstack', 'chronicle.jsonl'),
    });
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', projectId: 'p' },
      'trace',
    );
    const observer = await startChronicleFileObserver({
      projectRoot: root,
      journal,
      context,
      debounceMs: 25,
    });

    await writeFile(path.join(root, '.claude', 'worktrees', 'feature', 'src', 'copy.ts'), 'x\n');
    // A real edit afterwards proves the observer is alive: without it, "no
    // worktree event" would also be satisfied by an observer that saw nothing.
    const real = path.join(root, 'src', 'value.ts');
    await writeFile(real, 'export const value = 1;\n');

    const created = await waitForEvent(journal, (type) => type === 'file.external.created');
    expect(created.resource).toMatchObject({ path: 'src/value.ts' });

    const events = await journal.readAll();
    const worktreeEvents = events.filter((event) =>
      String(event.resource?.path ?? '').includes('worktrees'),
    );
    expect(worktreeEvents).toEqual([]);
    await observer.close();
  });

  it('correlates watcher mutations with a recent tool call and detects rename lineage', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-files-tool-'));
    tempDirs.push(root);
    const original = path.join(root, 'old.ts');
    const renamed = path.join(root, 'new.ts');
    await writeFile(original, 'same content\n');
    const journal = new ChronicleJournal({
      filePath: path.join(root, '.wrongstack', 'chronicle.jsonl'),
    });
    const events = new EventBus();
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', projectId: 'p' },
      'trace',
    );
    const observer = await startChronicleFileObserver({
      projectRoot: root,
      journal,
      context,
      events,
      debounceMs: 40,
    });

    events.emit('tool.progress', {
      sessionId: 'session',
      agentId: 'leader',
      name: 'edit',
      id: 'tool-42',
      event: { type: 'file_changed', path: 'old.ts', operation: 'edit' },
    });
    await writeFile(original, 'changed by tool\n');
    const toolMutation = await waitForEvent(journal, (type) => type === 'file.tool.modified');
    expect(toolMutation.correlation.toolCallId).toBe('tool-42');
    expect(toolMutation.scope).toMatchObject({ sessionId: 'session', agentId: 'leader' });
    expect(toolMutation.attributes).toMatchObject({
      actor: 'agent',
      source: 'tool',
      toolName: 'edit',
    });

    await rename(original, renamed);
    const renameEvent = await waitForEvent(journal, (type) => type === 'file.external.renamed');
    expect(renameEvent.resource?.path).toBe('new.ts');
    expect(renameEvent.attributes).toMatchObject({ previousPath: 'old.ts', operation: 'rename' });
    expect(renameEvent.attributes?.['previousResourceId']).toMatch(/^file_[a-f0-9]{24}$/);
    await observer.close();
  });

  it('never feeds Chronicle runtime storage changes back into its own journal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-files-runtime-'));
    tempDirs.push(root);
    const chronicleDirectory = path.join(root, 'project-state', 'chronicle');
    await mkdir(chronicleDirectory, { recursive: true });
    const journal = new ChronicleJournal({
      filePath: path.join(chronicleDirectory, 'events.jsonl'),
    });
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', projectId: 'p' },
      'trace',
    );
    const observer = await startChronicleFileObserver({
      projectRoot: root,
      journal,
      context,
      excludedPaths: [chronicleDirectory],
      debounceMs: 25,
    });

    await writeFile(path.join(chronicleDirectory, 'server.json'), '{}');
    await writeFile(path.join(root, 'source.ts'), 'export const source = true;\n');
    await waitForEvent(journal, (type) => type === 'file.external.created');
    const events = await journal.readAll();

    expect(events.some((event) => event.resource?.path === 'source.ts')).toBe(true);
    expect(
      events.some((event) => event.resource?.path?.startsWith('project-state/chronicle')),
    ).toBe(false);
    await observer.close();
  });

  it('applies state per committed event and does not re-emit committed events after a partial failure', async () => {
    // Chimera follow-up to the deferred-state fix: when one event's append
    // fails while a sibling's commits, the committed sibling's fingerprint
    // state must advance at ITS commit (not after the whole flush), so the
    // recovery retry re-derives only the failed file. The earlier version
    // deferred state until all chunks landed, which made every retry
    // re-emit already-committed events — duplicates in the audit journal.
    const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-files-append-'));
    tempDirs.push(root);
    const failing = path.join(root, 'failing.ts');
    const sibling = path.join(root, 'sibling.ts');
    await writeFile(failing, 'export const a = 1;\n');
    await writeFile(sibling, 'export const b = 1;\n');

    const sink = new FailingAppendSink('failing.ts');
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', projectId: 'p' },
      'trace',
    );
    const failures: unknown[] = [];
    const observer = await startChronicleFileObserver({
      projectRoot: root,
      journal: sink,
      context,
      debounceMs: 25,
      minFullRescanIntervalMs: 60,
      onError: (error) => failures.push(error),
    });

    await writeFile(failing, 'export const a = 2;\n');
    await writeFile(sibling, 'export const b = 2;\n');

    // Wait until the failed file's event finally lands via the recovery
    // rescan — then assert the committed sibling was never re-emitted.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (sink.recorded.some((input) => input.resource?.path === 'failing.ts')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const paths = sink.recorded.map((input) => input.resource?.path ?? '');
    expect(paths).toContain('failing.ts');
    // Exactly one event for each file — the recovery pass must not
    // duplicate the sibling that already committed before the failure.
    expect(paths.filter((p) => p === 'sibling.ts')).toHaveLength(1);
    expect(paths.filter((p) => p === 'failing.ts')).toHaveLength(1);
    expect(failures.length).toBeGreaterThanOrEqual(1);
    await observer.close();
  });

  it('re-derives audit events after an appendBatch flush failure instead of losing them', async () => {
    // Regression: reconcile used to advance the `known` fingerprint state
    // while it was still building inputs. When the journal flush failed —
    // here the whole first appendBatch; in production, one chunk of a
    // multi-chunk flush — the state was already past those changes and the
    // pending set was drained, so nothing ever re-derived them: the audit
    // events were permanently lost. The fix defers every state update
    // until the flush commits and requeues a bounded full rescan on
    // failure, so the same diff is retried from the un-advanced state.
    const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-files-flaky-'));
    tempDirs.push(root);
    await mkdir(path.join(root, 'src'));
    const edited = path.join(root, 'src', 'edited.ts');
    const added = path.join(root, 'src', 'added.ts');
    await writeFile(edited, 'export const edited = 1;\n');

    const sink = new FlakyBatchSink(1);
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', projectId: 'p' },
      'trace',
    );
    const failures: unknown[] = [];
    const observer = await startChronicleFileObserver({
      projectRoot: root,
      journal: sink,
      context,
      debounceMs: 25,
      // The failure path requeues a full rescan; keep the rate-limit floor
      // tiny so the retry fires within the test's lifetime.
      minFullRescanIntervalMs: 60,
      onError: (error) => failures.push(error),
    });

    await writeFile(edited, 'export const edited = 2;\n');
    await writeFile(added, 'export const added = 1;\n');

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const types = sink.recorded.map((input) => input.eventType);
      if (types.includes('file.external.modified') && types.includes('file.external.created')) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const types = sink.recorded.map((input) => input.eventType);
    expect(types).toContain('file.external.modified');
    expect(types).toContain('file.external.created');
    expect(sink.failures).toBeGreaterThanOrEqual(1);
    expect(failures.length).toBeGreaterThanOrEqual(1);
    await observer.close();
  });

  it('close() rejects when the final drain cannot commit instead of resolving silently', async () => {
    // Chimera c3: close() used to swallow a failed final drain — callers
    // saw a clean shutdown while the audit tail was lost. The fix records
    // the failure from the final drainPending pass and rethrows from
    // close(); a repeated close() stays a silent no-op.
    const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-files-close-'));
    tempDirs.push(root);
    const file = path.join(root, 'tail.ts');
    await writeFile(file, 'export const tail = 1;\n');

    const failures: unknown[] = [];
    const observer = await startChronicleFileObserver({
      projectRoot: root,
      journal: new AlwaysFailSink(),
      context: createChronicleContext(
        { installationId: 'i', machineId: 'm', projectId: 'p' },
        'trace',
      ),
      debounceMs: 10,
      minFullRescanIntervalMs: 0,
      onError: (error) => failures.push(error),
    });

    await writeFile(file, 'export const tail = 2;\n');

    // Every drain fails and immediately requeues a full rescan, so the
    // observer is provably cycling failures — the final drain at close()
    // therefore has pending work that cannot commit.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && failures.length < 3) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(failures.length).toBeGreaterThanOrEqual(3);

    await expect(observer.close()).rejects.toThrow('journal permanently unavailable');
    // Repeated close is an idempotent no-op and does not re-throw.
    await expect(observer.close()).resolves.toBeUndefined();
  });

  it('preserves tool attribution across a failed flush and emits file.activity exactly once', async () => {
    // Chimera medium: the hint used to be consumed at BUILD time, so a
    // failed appendBatch lost it — the recovery rescan re-derived the
    // change as `file.external.*` (correlation gone) while the build-time
    // `file.activity` bus event had already announced it (duplicate once
    // the retry committed). The fix claims hints via peekAttribution,
    // restores them with a fresh `at` on flush failure, and defers the
    // live bus event to the commit callback.
    const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-files-attrib-'));
    tempDirs.push(root);
    const file = path.join(root, 'tool-file.ts');
    await writeFile(file, 'export const value = 1;\n');

    const sink = new FlakyBatchSink(1);
    const bus = new EventBus();
    const activities: Array<{ filePath: string; source: string; toolUseId?: string }> = [];
    bus.on('file.activity', (payload) => activities.push(payload));
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', projectId: 'p' },
      'trace',
    );
    const observer = await startChronicleFileObserver({
      projectRoot: root,
      journal: sink,
      context,
      events: bus,
      debounceMs: 25,
      minFullRescanIntervalMs: 60,
      onError: () => {},
    });

    bus.emit('tool.progress', {
      sessionId: 'session',
      agentId: 'leader',
      name: 'edit',
      id: 'tool-99',
      event: { type: 'file_changed', path: 'tool-file.ts', operation: 'edit' },
    });
    await writeFile(file, 'export const value = 2;\n');

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (sink.recorded.some((input) => input.eventType === 'file.tool.modified')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // The recovery pass re-derived the event WITH its attribution.
    const toolEvent = sink.recorded.find((input) => input.eventType === 'file.tool.modified');
    expect(toolEvent).toBeDefined();
    expect(toolEvent?.resource?.path).toBe('tool-file.ts');
    expect(toolEvent?.correlation.toolCallId).toBe('tool-99');
    expect(toolEvent?.scope).toMatchObject({ sessionId: 'session', agentId: 'leader' });
    // It never degraded to an external mutation.
    expect(
      sink.recorded.some(
        (input) => input.eventType === 'file.external.modified' && input.resource?.path === 'tool-file.ts',
      ),
    ).toBe(false);
    // The failed attempt emitted nothing; the committed retry emitted
    // exactly one live event, tool-attributed.
    const forPath = activities.filter((activity) => activity.filePath.endsWith('tool-file.ts'));
    expect(forPath).toHaveLength(1);
    expect(forPath[0]).toMatchObject({ source: 'tool', toolUseId: 'tool-99' });
    await observer.close();
  });
});
