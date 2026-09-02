import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChronicleJournal,
  createChronicleContext,
  wireProviderAttemptsToChronicle,
} from '../../src/chronicle/index.js';
import { EventBus } from '../../src/kernel/events.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('wireProviderAttemptsToChronicle', () => {
  it('persists one correlated timeline across failed and successful attempts', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-provider-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext(
      {
        installationId: 'install',
        machineId: 'machine',
        projectId: 'project',
        sessionId: 'session',
      },
      'trace',
    );
    const unsubscribe = wireProviderAttemptsToChronicle({ events, journal, context });

    events.emit('provider.attempt.started', {
      sessionId: 'session',
      agentId: 'leader',
      logicalRequestId: 'request-1',
      promptManifestId: 'prompt_request_1',
      attemptId: 'attempt-1',
      attempt: 0,
      providerId: 'openai',
      model: 'model-a',
      streaming: true,
      messageCount: 4,
      toolCount: 12,
      startedAt: '2026-07-18T00:00:00.000Z',
    });
    events.emit('provider.attempt.failed', {
      sessionId: 'session',
      agentId: 'leader',
      logicalRequestId: 'request-1',
      promptManifestId: 'prompt_request_1',
      attemptId: 'attempt-1',
      attempt: 0,
      providerId: 'openai',
      model: 'model-a',
      startedAt: '2026-07-18T00:00:00.000Z',
      endedAt: '2026-07-18T00:00:01.000Z',
      durationMs: 1000,
      status: 429,
      failureKind: 'rate_limit',
      description: 'rate limited',
      retryable: true,
      retryScheduled: true,
      retryDelayMs: 2000,
    });
    events.emit('provider.attempt.completed', {
      sessionId: 'session',
      agentId: 'leader',
      logicalRequestId: 'request-1',
      promptManifestId: 'prompt_request_1',
      attemptId: 'attempt-2',
      attempt: 1,
      providerId: 'openai',
      model: 'model-a',
      startedAt: '2026-07-18T00:00:03.000Z',
      endedAt: '2026-07-18T00:00:04.500Z',
      durationMs: 1500,
      stopReason: 'end_turn',
      usage: { input: 100, output: 20 },
    });

    // EventBus persistence is intentionally non-blocking; readAll waits for
    // the journal's serialized append tail.
    const recorded = await journal.readAll();
    unsubscribe();

    expect(recorded.map((event) => event.eventType)).toEqual([
      'provider.attempt.started',
      'provider.attempt.failed',
      'provider.attempt.completed',
    ]);
    expect(recorded.every((event) => event.correlation.logicalRequestId === 'request-1')).toBe(
      true,
    );
    expect(
      recorded.every((event) => event.correlation.promptManifestId === 'prompt_request_1'),
    ).toBe(true);
    expect(recorded[1]?.attributes).toMatchObject({
      failureKind: 'rate_limit',
      retryDelayMs: 2000,
    });
    expect(recorded[2]?.durationNs).toBe('1500000000');
    expect(recorded[2]?.runtime).toEqual({ providerId: 'openai', modelId: 'model-a' });
    await expect(journal.verify()).resolves.toMatchObject({ ok: true, entries: 3 });
  });

  it('deduplicates tool-manifest names per manifestHash and caps message summaries', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-provider-dedup-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    const unsubscribe = wireProviderAttemptsToChronicle({ events, journal, context });
    const manifest = (id: string, messageCount: number) => ({
      manifestId: id,
      messageCount,
      estimatedMessageTokens: 10,
      contentBytes: 100,
      messages: Array.from({ length: messageCount }, (_, index) => ({
        index,
        role: 'user',
        bytes: 5,
        hash: `h${index}`,
        blocks: { text: 1 },
      })),
      tools: {
        count: 3,
        estimatedDefinitionTokens: 30,
        manifestHash: 'tools-hash-1',
        names: ['read', 'write', 'edit'],
        mutating: 2,
        destructive: 0,
      },
    });
    const emitStarted = (attemptId: string, promptManifest: unknown) =>
      events.emit('provider.attempt.started', {
        sessionId: 's',
        logicalRequestId: 'lr',
        attemptId,
        attempt: 0,
        providerId: 'p',
        model: 'm',
        streaming: true,
        messageCount: 1,
        toolCount: 3,
        startedAt: new Date().toISOString(),
        promptManifest,
      } as never);
    const first = manifest('prompt_1', 2);
    emitStarted('a1', first);
    emitStarted('a2', manifest('prompt_2', 12));
    const recorded = await journal.readAll();
    unsubscribe();
    const manifests = recorded.map(
      (event) => (event.attributes as { promptManifest: Record<string, unknown> }).promptManifest,
    );
    // First occurrence keeps the full name list; repeats carry only the hash ref.
    expect((manifests[0]!.tools as { names?: string[] }).names).toEqual(['read', 'write', 'edit']);
    expect((manifests[1]!.tools as { names?: string[]; namesRef?: string }).names).toBeUndefined();
    expect((manifests[1]!.tools as { namesRef?: string }).namesRef).toBe('tools-hash-1');
    // Long conversations keep only the tail of per-message summaries.
    expect((manifests[1]!.messages as unknown[]).length).toBe(8);
    expect(manifests[1]!.messagesTruncated).toBe(4);
    // The shared bus payload must never be mutated in place.
    expect(first.tools.names).toEqual(['read', 'write', 'edit']);
  });

  it('records taskId/boardId in scope on provider.attempt.started', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-provider-task-start-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', sessionId: 'sess' },
      'trace',
    );
    const unsubscribe = wireProviderAttemptsToChronicle({ events, journal, context });

    events.emit('provider.attempt.started', {
      sessionId: 'sess',
      agentId: 'leader',
      logicalRequestId: 'req-task',
      attemptId: 'att-task',
      attempt: 0,
      providerId: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      streaming: true,
      messageCount: 2,
      toolCount: 5,
      startedAt: new Date().toISOString(),
      taskId: 'task-42',
      boardId: 'board-7',
    });

    const recorded = await journal.readAll();
    unsubscribe();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.scope).toMatchObject({
      sessionId: 'sess',
      agentId: 'leader',
      taskId: 'task-42',
      kanbanBoardId: 'board-7',
    });
    expect(recorded[0]?.runtime).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
    });
  });

  it('records taskId/boardId in scope on provider.attempt.completed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-provider-task-comp-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', sessionId: 'sess' },
      'trace',
    );
    const unsubscribe = wireProviderAttemptsToChronicle({ events, journal, context });

    events.emit('provider.attempt.completed', {
      sessionId: 'sess',
      agentId: 'leader',
      logicalRequestId: 'req-comp',
      attemptId: 'att-comp',
      attempt: 0,
      providerId: 'openai',
      model: 'gpt-4o',
      startedAt: '2026-07-18T00:00:00.000Z',
      endedAt: '2026-07-18T00:00:02.000Z',
      durationMs: 2000,
      stopReason: 'end_turn',
      usage: { input: 50, output: 30 },
      taskId: 'task-99',
      boardId: 'board-7',
    });

    const recorded = await journal.readAll();
    unsubscribe();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.scope).toMatchObject({ taskId: 'task-99', kanbanBoardId: 'board-7' });
  });

  it('records taskId/boardId in scope on provider.attempt.failed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-provider-task-fail-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', sessionId: 'sess' },
      'trace',
    );
    const unsubscribe = wireProviderAttemptsToChronicle({ events, journal, context });

    events.emit('provider.attempt.failed', {
      sessionId: 'sess',
      agentId: 'leader',
      logicalRequestId: 'req-fail',
      attemptId: 'att-fail',
      attempt: 1,
      providerId: 'anthropic',
      model: 'claude-haiku-3',
      startedAt: '2026-07-18T00:00:00.000Z',
      endedAt: '2026-07-18T00:00:05.000Z',
      durationMs: 5000,
      status: 429,
      failureKind: 'rate_limit',
      description: 'rate limited',
      retryable: true,
      retryScheduled: true,
      taskId: 'task-77',
      boardId: 'board-7',
    });

    const recorded = await journal.readAll();
    unsubscribe();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.scope).toMatchObject({ taskId: 'task-77', kanbanBoardId: 'board-7' });
  });

  it('omits taskId/boardId from scope when not provided', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-provider-no-task-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', sessionId: 'sess' },
      'trace',
    );
    const unsubscribe = wireProviderAttemptsToChronicle({ events, journal, context });

    events.emit('provider.attempt.started', {
      sessionId: 'sess',
      agentId: 'leader',
      logicalRequestId: 'req-notask',
      attemptId: 'att-notask',
      attempt: 0,
      providerId: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      streaming: true,
      messageCount: 2,
      toolCount: 3,
      startedAt: new Date().toISOString(),
    });

    const recorded = await journal.readAll();
    unsubscribe();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.scope).not.toHaveProperty('taskId');
    expect(recorded[0]?.scope).not.toHaveProperty('kanbanBoardId');
  });
});
