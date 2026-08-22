import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChronicleJournal,
  ChronicleMetricsStore,
  isChronicleMetricsAvailable,
} from '../../src/chronicle/index.js';
import { loadDatabaseSync } from '../../src/chronicle/metrics-schema.js';
import type { ChronicleEventInput } from '../../src/chronicle/types.js';

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(
    dirs.splice(0).map((dir) =>
      // maxRetries + retryDelay: Windows holds SQLite WAL sidecar file
      // handles (-shm, -wal) briefly after close(), causing EBUSY on
      // immediate unlink. Linear backoff (200ms × 5 retries) lets the
      // OS release the handles without masking real cleanup failures.
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
    ),
  ),
);

const scope = { installationId: 'i', machineId: 'm', projectId: 'p', sessionId: 'sess-1' };
const correlation = { traceId: 't', spanId: 'sp' };

function input(
  partial: Partial<ChronicleEventInput> & Pick<ChronicleEventInput, 'eventType'>,
): ChronicleEventInput {
  return { scope, correlation, occurredAt: '2026-07-24T10:00:00.000Z', ...partial };
}

describe.skipIf(!isChronicleMetricsAvailable())('ChronicleMetricsStore', { retry: 1 }, () => {
  it('ingests provider, task, file, and cost aggregates incrementally and idempotently', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-metrics-'));
    dirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, '2026-07-24.events.jsonl') });
    const runtime = { providerId: 'openai', modelId: 'model-a' };
    await Promise.all([
      journal.append(input({ eventType: 'provider.attempt.started', runtime, outcome: 'started' })),
      journal.append(
        input({
          eventType: 'provider.attempt.failed',
          runtime,
          outcome: 'failure',
          durationNs: '1000000000',
          attributes: { retryScheduled: true },
        }),
      ),
      journal.append(input({ eventType: 'provider.attempt.started', runtime, outcome: 'started' })),
      journal.append(
        input({
          eventType: 'provider.attempt.completed',
          runtime,
          outcome: 'success',
          durationNs: '2000000000',
          attributes: { usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3 } },
        }),
      ),
      journal.append(
        input({ eventType: 'token.accounted', attributes: { cost: { total: 0.25 } } }),
      ),
      journal.append(
        input({
          eventType: 'token.accounted',
          occurredAt: '2026-07-24T11:00:00.000Z',
          attributes: { cost: { total: 0.75 } },
        }),
      ),
      journal.append(
        input({
          eventType: 'sdd.task.started',
          scope: { ...scope, taskId: 'task-1', agentId: 'worker-1' },
          attributes: { runId: 'run-1' },
        }),
      ),
      journal.append(
        input({
          eventType: 'sdd.task.completed',
          occurredAt: '2026-07-24T10:05:00.000Z',
          scope: { ...scope, taskId: 'task-1' },
          attributes: { runId: 'run-1', durationMs: 300000 },
        }),
      ),
      journal.append(
        input({
          eventType: 'file.event',
          scope: { ...scope, taskId: 'task-1', kanbanBoardId: 'board-1', agentId: 'worker-1' },
          correlation: {
            traceId: 'trace-1',
            spanId: 'span-1',
            logicalRequestId: 'request-1',
            promptManifestId: 'prompt_request_1',
            toolCallId: 'tool-1',
          },
          resource: { kind: 'file', id: 'path:src/app.ts', path: 'src/app.ts' },
          attributes: {
            operation: 'update',
            toolName: 'edit',
            provider: 'openai',
            model: 'model-a',
            runId: 'run-1',
            source: 'tool',
            provenanceConfidence: 'explicit',
          },
        }),
      ),
      journal.append(
        input({
          eventType: 'file.event',
          scope: { ...scope, taskId: 'task-1' },
          resource: { kind: 'file', id: 'path:src/app.ts', path: 'src/app.ts' },
          attributes: { operation: 'read', toolName: 'read' },
        }),
      ),
    ]);
    await journal.flush();

    const store = ChronicleMetricsStore.open(dir);
    try {
      const first = await store.refresh();
      expect(first.ingestedEvents).toBe(10);
      expect(first.invalidLines).toBe(0);

      const providers = store.providerDaily();
      expect(providers).toHaveLength(1);
      expect(providers[0]).toMatchObject({
        day: '2026-07-24',
        providerId: 'openai',
        modelId: 'model-a',
        attempts: 2,
        completed: 1,
        failed: 1,
        retries: 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheWriteTokens: 3,
        avgDurationMs: 1500,
        maxDurationMs: 2000,
      });

      const tasks = store.taskOutcomes();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        taskId: 'task-1',
        runId: 'run-1',
        sessionId: 'sess-1',
        agentId: 'worker-1',
        status: 'completed',
        durationMs: 300000,
        filesTouched: 1,
      });

      // Reads are excluded from lineage; the mutation carries full attribution.
      // Path lookup is case-normalized (Windows), yet display path is original.
      const lineage = store.fileLineage({ path: 'SRC/App.ts' });
      expect(lineage).toHaveLength(1);
      expect(lineage[0]).toMatchObject({
        path: 'src/app.ts',
        operation: 'update',
        sessionId: 'sess-1',
        agentId: 'worker-1',
        taskId: 'task-1',
        boardId: 'board-1',
        runId: 'run-1',
        toolName: 'edit',
        providerId: 'openai',
        modelId: 'model-a',
        logicalRequestId: 'request-1',
        promptManifestId: 'prompt_request_1',
        provenanceConfidence: 'explicit',
        source: 'tool',
      });

      // token.accounted is cumulative — latest snapshot per scope wins.
      expect(store.summary()).toMatchObject({
        providers: { attempts: 2, completed: 1, failed: 1, successRate: 0.5 },
        tasks: { completed: 1 },
        files: { mutations: 1, uniquePaths: 1 },
        estimatedCostUsd: 0.75,
      });

      // Idempotent: nothing new on disk means nothing re-ingested.
      const second = await store.refresh();
      expect(second.ingestedEvents).toBe(0);
      expect(store.summary().providers.attempts).toBe(2);

      // Incremental: appended events are picked up from the stored offset.
      await journal.append(
        input({ eventType: 'provider.attempt.started', runtime, outcome: 'started' }),
      );
      await journal.flush();
      const third = await store.refresh();
      expect(third.ingestedEvents).toBe(1);
      expect(store.summary().providers.attempts).toBe(3);
    } finally {
      store.close();
    }
  });

  it('queries the latest lineage for many paths in one indexed projection', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-metrics-paths-'));
    dirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, '2026-07-24.events.jsonl') });
    await journal.append(input({
      eventType: 'file.event',
      occurredAt: '2026-07-24T10:00:00.000Z',
      resource: { kind: 'file', id: 'a-old', path: 'src/a.ts' },
      attributes: { operation: 'update', source: 'tool' },
    }));
    await journal.append(input({
      eventType: 'file.event',
      occurredAt: '2026-07-24T10:01:00.000Z',
      resource: { kind: 'file', id: 'b-latest', path: 'SRC\\B.TS' },
      attributes: { operation: 'create', source: 'tool' },
    }));
    await journal.append(input({
      eventType: 'file.event',
      occurredAt: '2026-07-24T10:02:00.000Z',
      resource: { kind: 'file', id: 'a-latest', path: 'src/a.ts' },
      attributes: { operation: 'delete', source: 'tool' },
    }));
    await journal.flush();

    const store = ChronicleMetricsStore.open(dir);
    try {
      await store.refresh();
      const rows = store.fileLineage({
        paths: ['SRC\\A.TS', 'src/b.ts'],
        latestPerPath: true,
        limit: 2,
      });

      expect(rows.map((row) => [row.path, row.operation])).toEqual([
        ['src/a.ts', 'delete'],
        ['SRC/B.TS', 'create'],
      ]);
      expect(rows.every((row) => row.provenanceConfidence === 'unknown')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('attributes fallbacks to the from-provider and never manufactures a blank provider row', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-metrics-fb-'));
    dirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, '2026-07-24.events.jsonl') });
    await Promise.all([
      journal.append(
        input({
          eventType: 'provider.attempt.started',
          runtime: { providerId: 'openai', modelId: 'gpt' },
          outcome: 'started',
        }),
      ),
      // provider.fallback carries identity only under attributes.from — the
      // domain adapter leaves runtime empty for it.
      journal.append(
        input({
          eventType: 'provider.fallback',
          outcome: 'success',
          attributes: { from: { providerId: 'openai', model: 'gpt' }, to: { providerId: 'anthropic', model: 'claude' }, status: 529 },
        }),
      ),
      // An identity-less provider event must not create a ('', '') row.
      journal.append(input({ eventType: 'provider.fallback', outcome: 'success', attributes: { status: 500 } })),
    ]);
    await journal.flush();

    const store = ChronicleMetricsStore.open(dir);
    try {
      await store.refresh();
      const rows = store.providerDaily();
      // Only the openai/gpt row exists — no blank-identity phantom.
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ providerId: 'openai', modelId: 'gpt', attempts: 1, fallbacks: 1 });
      expect(rows.some((row) => row.providerId === '' && row.modelId === '')).toBe(false);
    } finally {
      store.close();
    }
  });

  it('survives reopening and rotated partitions', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-metrics-rot-'));
    dirs.push(dir);
    const journal = new ChronicleJournal({
      filePath: path.join(dir, '2026-07-24.events.jsonl'),
      maxPartitionSizeBytes: 512,
      rotationWindowMs: Number.POSITIVE_INFINITY,
    });
    for (let index = 0; index < 8; index++) {
      await journal.append(
        input({
          eventType: 'provider.attempt.started',
          runtime: { providerId: 'p', modelId: 'm' },
          outcome: 'started',
        }),
      );
      await journal.flush();
    }
    const store = ChronicleMetricsStore.open(dir);
    const first = await store.refresh();
    expect(first.ingestedEvents).toBe(8);
    expect(first.sourceFiles).toBeGreaterThan(1);
    store.close();

    const reopened = ChronicleMetricsStore.open(dir);
    try {
      const again = await reopened.refresh();
      expect(again.ingestedEvents).toBe(0);
      expect(reopened.providerDaily()[0]?.attempts).toBe(8);
    } finally {
      reopened.close();
    }
  });

  it('serves a day-bounded ChronicleSummary for the default dashboard view', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-metrics-summary-'));
    dirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, '2026-07-24.events.jsonl') });
    const withAgent = { ...scope, agentId: 'worker-1' };
    await Promise.all([
      journal.append(input({ eventType: 'tool.started', scope: withAgent, correlation: { ...correlation, toolCallId: 'tc-1' } })),
      journal.append(input({ eventType: 'tool.executed', scope: withAgent, correlation: { ...correlation, toolCallId: 'tc-1' }, outcome: 'success', durationNs: '10000000' })),
      journal.append(input({ eventType: 'tool.failed', scope: withAgent, correlation: { ...correlation, toolCallId: 'tc-2' }, outcome: 'failure', durationNs: '5000000' })),
      journal.append(input({ eventType: 'process.started', scope: withAgent })),
      journal.append(input({ eventType: 'process.completed', scope: withAgent, outcome: 'failure' })),
      journal.append(input({ eventType: 'decision.requested', scope: withAgent, attributes: { decisionId: 'd1' } })),
      journal.append(input({ eventType: 'decision.escalated', scope: withAgent, attributes: { decisionId: 'd1' } })),
      journal.append(input({ eventType: 'agent.status_changed', scope: withAgent })),
      journal.append(input({ eventType: 'file.event', scope: withAgent, resource: { kind: 'file', id: 'path:a.ts', path: 'a.ts' }, attributes: { operation: 'update' } })),
      journal.append(input({ eventType: 'file.event', scope: withAgent, resource: { kind: 'file', id: 'path:b.ts', path: 'b.ts' }, attributes: { operation: 'read' } })),
      journal.append(input({
        eventType: 'provider.attempt.completed', scope: withAgent, correlation: { ...correlation, logicalRequestId: 'r1' },
        runtime: { providerId: 'openai', modelId: 'gpt' }, outcome: 'success', durationNs: '20000000',
        attributes: { usage: { input: 10, output: 2 } },
      })),
      // A different day — must be excluded by a from/to window scoped to the 24th.
      journal.append(input({ eventType: 'tool.started', scope: withAgent, occurredAt: '2026-07-25T10:00:00.000Z' })),
    ]);
    await journal.flush();

    const store = ChronicleMetricsStore.open(dir);
    try {
      await store.refresh();
      const bounded = store.defaultSummary({ from: '2026-07-24T00:00:00.000Z', to: '2026-07-24T23:59:59.000Z' });
      expect(bounded).toMatchObject({
        toolCalls: 1,
        completedTools: 1,
        failedTools: 1,
        toolAvgDurationMs: 7.5,
        processes: 1,
        failedProcesses: 1,
        decisions: 1,
        escalations: 1,
        agentEvents: 1,
        uniqueAgents: 1,
        fileEvents: 2,
        uniqueFiles: 2,
        logicalRequests: 1,
        modelAttempts: 0,
        completedAttempts: 1,
        providers: 1,
        models: 1,
        inputTokens: 10,
        outputTokens: 2,
        // tool.failed AND process.completed(failure) are each independently
        // a terminal failure per isTerminalFailure().
        failures: 2,
        cancellations: 0,
      });
      expect(bounded.families.tool).toBeGreaterThan(0);
      expect(bounded.failuresByFamily.tool).toBeGreaterThan(0);

      // Widening the window picks up the 25th's extra tool.started.
      const wide = store.defaultSummary({ from: '2026-07-24T00:00:00.000Z', to: '2026-07-25T23:59:59.000Z' });
      expect(wide.toolCalls).toBe(2);

      // No bound at all — everything.
      expect(store.defaultSummary().toolCalls).toBe(2);
    } finally {
      store.close();
    }
  });

  it('does not commit partial aggregate updates from an event that throws mid-way', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-metrics-savepoint-'));
    dirs.push(dir);

    const valid = input({
      eventType: 'tool.executed',
      outcome: 'success',
      durationNs: '1000000',
      resource: { kind: 'file', id: 'src/a.ts', path: 'src/a.ts' },
    });
    // Deliberately malformed fixture: a numeric path is not a valid
    // ChronicleResourceRef — cross-cast so the runtime can be exercised while
    // the test project stays type-checked.
    const broken = {
      scope,
      correlation,
      occurredAt: '2026-07-24T10:00:00.000Z',
      eventType: 'file.event',
      outcome: 'started',
      resource: { kind: 'file', id: 'broken', path: 123 },
    } as unknown as ChronicleEventInput;
    await writeFile(
      path.join(dir, '2026-07-24.events.jsonl'),
      `${JSON.stringify(valid)}\n${JSON.stringify(broken)}\n`,
      'utf8',
    );

    const store = ChronicleMetricsStore.open(dir);
    const result = await store.refresh();
    expect(result.ingestedEvents).toBe(1);
    expect(result.invalidLines).toBe(1);

    const db = new (loadDatabaseSync())(path.join(dir, 'metrics.db'), { readOnly: true });
    try {
      const counters = db
        .prepare('SELECT file_events_all FROM daily_counters WHERE day = ?')
        .get('2026-07-24') as { file_events_all: number } | undefined;
      // Only the valid event's bump — the broken event's partial bump was
      // rolled back (would be 2 without the per-event savepoint).
      expect(counters?.file_events_all).toBe(1);
      // `signalFamily` returns 'file' for ANY event whose resource.kind ===
      // 'file' (checked before the event-type regex), so the valid event
      // landed in family 'file' (count 1) AND the broken event reached the
      // family upsert before `normalizePathKey` threw — which is exactly why
      // the count would be 2 without the per-event savepoint. No 'tool'
      // family row exists for either event.
      const fileFamily = db
        .prepare('SELECT count FROM family_daily WHERE day = ? AND family = ?')
        .get('2026-07-24', 'file') as { count: number };
      expect(fileFamily.count).toBe(1);
      const toolFamily = db
        .prepare('SELECT count FROM family_daily WHERE day = ? AND family = ?')
        .get('2026-07-24', 'tool');
      expect(toolFamily).toBeUndefined();
    } finally {
      db.close();
      store.close();
    }
  });
});
