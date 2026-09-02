import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChronicleJournal,
  ChronicleQueryEngine,
  createChronicleContext,
  wireToolsToChronicle,
} from '../../src/chronicle/index.js';
import { EventBus } from '../../src/kernel/events.js';
import { ToolErrorCategory } from '../../src/types/tool.js';

const tempDirs: string[] = [];
const scrubber = {
  scrub: (value: string) => value.replaceAll('SECRET', '[REDACTED]'),
  scrubObject: <T>(obj: T): T => obj,
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('wireToolsToChronicle', () => {
  it('records scrubbed lifecycle data (resource edges are windowed by rollup-adapter.ts, not persisted raw here)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-tool-'));
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
    const unsubscribe = wireToolsToChronicle({ events, journal, context, scrubber });

    events.emit('tool.started', {
      sessionId: 'session',
      traceId: 'trace',
      agentId: 'leader',
      name: 'read',
      id: 'tool-1',
      input: { path: 'src/auth.ts', token: 'SECRET' },
    });
    events.emit('tool.progress', {
      sessionId: 'session',
      traceId: 'trace',
      agentId: 'leader',
      name: 'edit',
      id: 'tool-1',
      event: {
        type: 'file_changed',
        path: 'src/auth.ts',
        operation: 'edit',
        line: 72,
        endLine: 91,
      },
    });
    events.emit('tool.executed', {
      sessionId: 'session',
      traceId: 'trace',
      agentId: 'leader',
      id: 'tool-1',
      name: 'read',
      durationMs: 12.5,
      ok: true,
      output: 'result SECRET',
      outputBytes: 20,
      outputTokens: 5,
      outputLines: 2,
      metadata: {
        toolUseId: 'tool-1',
        toolName: 'read',
        ok: true,
        summary: 'read auth',
        files: ['src/auth.ts'],
        symbols: ['AuthService.login'],
        commands: ['rg SECRET src'],
        errors: [],
        status: 'seen',
        referenceCount: 0,
        seenAt: 1,
      },
    });

    const recorded = await journal.readAll();
    unsubscribe();

    expect(recorded.map((event) => event.eventType)).toEqual([
      'tool.started',
      'file.mutation.observed',
      'tool.executed',
    ]);
    expect(recorded[0]?.attributes?.['input']).toContain('[REDACTED]');
    expect(recorded[2]?.attributes?.['outputPreview']).toBe('result [REDACTED]');
    expect(recorded[1]?.resource).toMatchObject({
      kind: 'file',
      path: 'src/auth.ts',
      lineStart: 72,
      lineEnd: 91,
    });
    // tool.executed still carries the raw metadata so rollup-adapter.ts can
    // window it into a bounded tool.resource.observed rollup.
    expect(recorded[2]?.attributes?.['metadata']).toMatchObject({
      files: ['src/auth.ts'],
      symbols: ['AuthService.login'],
      commands: ['rg SECRET src'],
    });
    expect(recorded.every((event) => event.correlation.toolCallId === 'tool-1')).toBe(true);
    await expect(journal.verify()).resolves.toMatchObject({ ok: true, entries: 3 });
  });

  it('records executor failures separately from model-facing tool results', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-tool-failure-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    wireToolsToChronicle({ events, journal, context, scrubber });

    events.emit('tool.failed', {
      name: 'bash',
      id: 'tool-fail',
      sessionId: 'session',
      agentId: 'leader',
      durationMs: 300,
      category: ToolErrorCategory.TRANSIENT,
      retryable: true,
      detail: 'timed out',
    });

    const recorded = await journal.readAll();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      eventType: 'tool.failed',
      outcome: 'failure',
      durationNs: '300000000',
    });
    expect(recorded[0]?.attributes).toMatchObject({
      toolName: 'bash',
      category: 'transient',
      retryable: true,
    });
  });

  it('records permission provenance without persisting raw tool arguments', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-permission-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'permission.events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', projectId: 'p' },
      'trace',
    );
    const unsubscribe = wireToolsToChronicle({ events, journal, context, scrubber });

    events.emit('permission.evaluated', {
      sessionId: 'session',
      traceId: 'trace',
      agentId: 'leader',
      name: 'bash',
      id: 'tool-permission',
      inputHash: 'a'.repeat(64),
      policyDecision: 'auto',
      effectiveDecision: 'confirm',
      decisionSource: 'trust',
      reason: 'matched SECRET rule',
      riskTier: 'destructive',
      yoloEnabled: false,
      boundaryDecision: 'confirm',
      boundaryReason: 'SECRET boundary',
      capabilityDowngraded: true,
    });

    const recorded = await journal.readAll();
    const query = await ChronicleQueryEngine.fromDirectory(dir);
    const summary = (await query.query({ eventTypes: ['permission.evaluated'] })).summary;
    unsubscribe();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      eventType: 'permission.evaluated',
      outcome: 'success',
      correlation: { traceId: 'trace', toolCallId: 'tool-permission' },
      attributes: {
        toolName: 'bash',
        inputHash: 'a'.repeat(64),
        policyDecision: 'auto',
        effectiveDecision: 'confirm',
        decisionSource: 'trust',
        reason: 'matched [REDACTED] rule',
        riskTier: 'destructive',
        yoloEnabled: false,
        boundaryDecision: 'confirm',
        boundaryReason: '[REDACTED] boundary',
        capabilityDowngraded: true,
      },
    });
    expect(JSON.stringify(recorded[0])).not.toContain('SECRET');
    expect(summary.families.decision).toBe(1);
  });

  it('truncates output previews exceeding 2048 bytes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-tool-trunc-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    const unsubscribe = wireToolsToChronicle({ events, journal, context, scrubber });

    // Generate output exceeding the 2048-byte preview cap
    const largeOutput = 'x'.repeat(3000);

    events.emit('tool.executed', {
      sessionId: 'session',
      traceId: 'trace',
      agentId: 'leader',
      id: 'tool-trunc',
      name: 'read',
      durationMs: 5,
      ok: true,
      output: largeOutput,
      outputBytes: 3000,
      outputTokens: 750,
      outputLines: 1,
      metadata: {
        toolUseId: 'tool-trunc',
        toolName: 'read',
        ok: true,
        summary: 'large read',
        files: [],
        symbols: [],
        commands: [],
        errors: [],
        status: 'seen',
        referenceCount: 0,
        seenAt: 1,
      },
    });

    const recorded = await journal.readAll();
    unsubscribe();

    expect(recorded).toHaveLength(1);
    const preview = recorded[0]?.attributes?.['outputPreview'];
    // Should be a truncation object, not the full string
    expect(typeof preview).toBe('object');
    const truncObj = preview as { preview: string; truncated: true; totalBytes: number };
    expect(truncObj.truncated).toBe(true);
    expect(truncObj.totalBytes).toBe(3000);
    expect(Buffer.byteLength(truncObj.preview, 'utf8')).toBeLessThanOrEqual(2048);
  });

  it('preserves short output as-is (no truncation)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-tool-short-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    const unsubscribe = wireToolsToChronicle({ events, journal, context, scrubber });

    events.emit('tool.executed', {
      sessionId: 'session',
      traceId: 'trace',
      agentId: 'leader',
      id: 'tool-short',
      name: 'read',
      durationMs: 1,
      ok: true,
      output: 'short output',
      outputBytes: 12,
      outputTokens: 2,
      outputLines: 1,
      metadata: {
        toolUseId: 'tool-short',
        toolName: 'read',
        ok: true,
        summary: 'small read',
        files: [],
        symbols: [],
        commands: [],
        errors: [],
        status: 'seen',
        referenceCount: 0,
        seenAt: 1,
      },
    });

    const recorded = await journal.readAll();
    unsubscribe();

    expect(recorded).toHaveLength(1);
    // Short output should be preserved as a plain string
    expect(recorded[0]?.attributes?.['outputPreview']).toBe('short output');
  });

  it('records taskId/boardId in scope and provider/model in runtime on tool.started', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-task-scope-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', sessionId: 'sess' },
      'trace',
    );
    const unsubscribe = wireToolsToChronicle({ events, journal, context, scrubber });

    events.emit('tool.started', {
      sessionId: 'sess',
      traceId: 'trace',
      agentId: 'leader',
      name: 'grep',
      id: 'tool-task',
      input: { pattern: 'TODO' },
      taskId: 'task-42',
      boardId: 'board-7',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
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

  it('records taskId/boardId in scope and provider/model in runtime on tool.executed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-task-exec-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', sessionId: 'sess' },
      'trace',
    );
    const unsubscribe = wireToolsToChronicle({ events, journal, context, scrubber });

    events.emit('tool.executed', {
      sessionId: 'sess',
      traceId: 'trace',
      agentId: 'leader',
      id: 'tool-exec-task',
      name: 'edit',
      durationMs: 50,
      ok: true,
      output: 'patched file',
      outputBytes: 12,
      outputTokens: 3,
      outputLines: 2,
      metadata: {
        toolUseId: 'tool-exec-task',
        toolName: 'edit',
        ok: true,
        summary: 'edit file',
        files: [],
        symbols: [],
        commands: [],
        errors: [],
        status: 'seen',
        referenceCount: 0,
        seenAt: 1,
      },
      taskId: 'task-99',
      boardId: 'board-7',
      provider: 'openai',
      model: 'gpt-4o',
    });

    const recorded = await journal.readAll();
    unsubscribe();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.scope).toMatchObject({ taskId: 'task-99', kanbanBoardId: 'board-7' });
    expect(recorded[0]?.runtime).toMatchObject({ providerId: 'openai', modelId: 'gpt-4o' });
  });

  it('records taskId/boardId/provider/model on tool.failed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-task-fail-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', sessionId: 'sess' },
      'trace',
    );
    const unsubscribe = wireToolsToChronicle({ events, journal, context, scrubber });

    events.emit('tool.failed', {
      name: 'bash',
      id: 'tool-fail-task',
      sessionId: 'sess',
      agentId: 'leader',
      durationMs: 5000,
      category: ToolErrorCategory.TRANSIENT,
      retryable: true,
      detail: 'command timed out',
      taskId: 'task-77',
      boardId: 'board-7',
      provider: 'anthropic',
      model: 'claude-haiku-3',
    });

    const recorded = await journal.readAll();
    unsubscribe();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.scope).toMatchObject({ taskId: 'task-77', kanbanBoardId: 'board-7' });
    expect(recorded[0]?.runtime).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-haiku-3',
    });
  });

  it('records taskId/boardId/provider/model on permission.evaluated', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-perm-task-'));
    tempDirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', sessionId: 'sess' },
      'trace',
    );
    const unsubscribe = wireToolsToChronicle({ events, journal, context, scrubber });

    events.emit('permission.evaluated', {
      sessionId: 'sess',
      agentId: 'leader',
      name: 'bash',
      id: 'perm-task',
      inputHash: 'b'.repeat(64),
      policyDecision: 'auto',
      effectiveDecision: 'auto',
      decisionSource: 'trust',
      yoloEnabled: false,
      capabilityDowngraded: false,
      taskId: 'task-55',
      boardId: 'board-7',
      provider: 'google',
      model: 'gemini-2.0-flash',
    });

    const recorded = await journal.readAll();
    unsubscribe();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.scope).toMatchObject({ taskId: 'task-55', kanbanBoardId: 'board-7' });
    expect(recorded[0]?.runtime).toMatchObject({
      providerId: 'google',
      modelId: 'gemini-2.0-flash',
    });
  });
});
