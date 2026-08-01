import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChronicleJournal, createChronicleContext, wireDomainEventsToChronicle } from '../../src/chronicle/index.js';
import { EventBus } from '../../src/kernel/events.js';
const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('domain lifecycle bridge', () => {
  it('captures uncovered domains, scopes identities and redacts prose', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-domain-')); dirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext({ installationId: 'i', machineId: 'm', projectId: 'p' }, 'trace');
    const off = wireDomainEventsToChronicle({ events, journal, context });
    events.emit('memory.candidate_rejected', { candidateId: 'memory-1', sessionId: 's', traceId: 'memory-trace', reason: 'private reason' });
    events.emit('sdd.task.retrying', { sessionId: 's', runId: 'run-1', taskId: 'task-1', attempt: 2, maxRetries: 3 });
    events.emit('worktree.committed', { sessionId: 's', handleId: 'wt-1', ownerId: 'agent-1', branch: 'feature', committed: true, insertions: 12, deletions: 2, files: 3, sha: 'abc' });
    // UI/client presence is a derived display concern, not a coding signal.
    events.emit('client.status', { sessionId: 's', clientType: 'webui', clientId: 'c', projectHash: 'p', agentCount: 1, model: 'm', mode: 'code', toolCalls: 2, inputTokens: 10, outputTokens: 4, cacheTokens: 0, costUsd: 0.01, timestamp: Date.now(), projectSlug: 'p' });
    const recorded = await journal.readAll(); off();
    expect(recorded.map((event) => event.eventType)).toEqual(['memory.candidate_rejected', 'sdd.task.retrying', 'worktree.committed']);
    expect(recorded[0]).toMatchObject({ scope: { sessionId: 's' }, correlation: { traceId: 'memory-trace' }, resource: { kind: 'other' } });
    expect(recorded[1]).toMatchObject({ scope: { taskId: 'task-1' }, resource: { kind: 'task' }, outcome: 'started' });
    expect(recorded[2]).toMatchObject({ resource: { kind: 'artifact', id: 'worktreeId:wt-1' }, outcome: 'success' });
    expect(JSON.stringify(recorded)).not.toContain('private reason');
  });

  it('truncates recentMail and recentTools arrays to 5 entries', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-trunc-')); dirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    const off = wireDomainEventsToChronicle({ events, journal, context });
    const mail = Array.from({ length: 20 }, (_, i) => ({
      id: `msg-${i}`, direction: 'incoming', from: 'agent-x', to: '*',
      type: 'status', subject: `event #${i}`, at: Date.now(),
    }));
    events.emit('agent.status_changed', {
      sessionId: 's',
      agents: [{
        id: 'leader', name: 'leader',
        recentMail: mail,
        recentTools: Array.from({ length: 10 }, (_, i) => ({ name: `tool-${i}`, durationMs: i * 100 })),
      }],
    } as never);
    const recorded = await journal.readAll(); off();
    const attrs = recorded[0]!.attributes as Record<string, unknown>;
    const agents = (attrs['agents'] as Array<Record<string, unknown>>) ?? [];
    expect(agents).toHaveLength(1);
    const leader = agents[0]!;
    // recentMail truncated to 5
    const recentMail = leader['recentMail'] as { items: unknown[]; total: number; truncated: true };
    expect(recentMail.items).toHaveLength(5);
    expect(recentMail.total).toBe(20);
    expect(recentMail.truncated).toBe(true);
    expect((recentMail.items[0] as Record<string, unknown>).subject).toBe('event #0');
    // recentTools truncated to 5
    const recentTools = leader['recentTools'] as { items: unknown[]; total: number; truncated: true };
    expect(recentTools.items).toHaveLength(5);
    expect(recentTools.total).toBe(10);
    expect(recentTools.truncated).toBe(true);
    // General arrays still allow 20 items (agents, etc.)
    expect(agents).toHaveLength(1); // only 1 agent in fixture
    off();
  });

  it('excludes rollup-owned snapshots and network chatter from raw persistence', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-excl-')); dirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    const off = wireDomainEventsToChronicle({ events, journal, context });
    events.emit('session.agents_updated', { sessionId: 's', agents: [] });
    events.emit('network.request.started', { sessionId: 's', requestId: 'r1', initiator: 'provider', operationName: 'op', method: 'POST', scheme: 'https', serverAddress: 'api.example.com', pathHash: 'h', queryKeys: [], startedAt: new Date().toISOString() });
    events.emit('network.request.completed', { sessionId: 's', requestId: 'r1', initiator: 'provider', operationName: 'op', method: 'POST', scheme: 'https', serverAddress: 'api.example.com', pathHash: 'h', statusCode: 200, durationMs: 12, completedAt: new Date().toISOString() });
    events.emit('network.request.failed', { sessionId: 's', requestId: 'r2', initiator: 'tool', operationName: 'op', method: 'GET', scheme: 'https', serverAddress: 'api.example.com', pathHash: 'h', durationMs: 5, errorName: 'ECONNRESET', failedAt: new Date().toISOString() });
    events.emit('runtime.health.sampled' as never, { sessionId: 's', eventLoop: { utilization: 0.1 } } as never);
    events.emit('provider.tool_use_start' as never, { id: 'call-1', name: 'read' } as never);
    events.emit('provider.tool_use_stop' as never, { id: 'call-1', name: 'read' } as never);
    const recorded = await journal.readAll(); off();
    expect(recorded.map((event) => event.eventType)).toEqual(['network.request.failed']);
  });

  it('dedupes memory.injector_run entries that are both activated and injected', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-memdedup-')); dirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace');
    const off = wireDomainEventsToChronicle({ events, journal, context });
    const shared = { id: 'mem-1', kind: 'fact', score: 0.9 };
    const onlyInjected = { id: 'mem-2', kind: 'fact', score: 0.5 };
    events.emit('memory.injector_run' as never, {
      sessionId: 's',
      activated: [shared, { id: 'mem-3', kind: 'fact', score: 0.7 }],
      injected: [shared, onlyInjected],
    } as never);
    const recorded = await journal.readAll(); off();
    const attrs = recorded[0]!.attributes as Record<string, unknown>;
    const injected = attrs['injected'] as Array<Record<string, unknown>>;
    expect(injected).toEqual([{ id: 'mem-1', ref: 'activated' }, { id: 'mem-2', kind: 'fact', score: 0.5 }]);
    const activated = attrs['activated'] as Array<Record<string, unknown>>;
    expect(activated).toHaveLength(2);
    expect(activated[0]).toMatchObject({ id: 'mem-1', kind: 'fact', score: 0.9 });
  });

  it('persists file.event mutations with task/board scope and skips reads', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-filev-')); dirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext({ installationId: 'i', machineId: 'm', projectId: 'p' }, 'trace');
    const off = wireDomainEventsToChronicle({ events, journal, context });
    const base = {
      absPath: '/repo/src/app.ts', sessionId: 's', agentId: 'worker-1', agentName: 'Worker',
      provider: 'openai', model: 'model-a', toolUseId: 'tu-1',
      scope: 'task' as const, taskId: 'task-9', boardId: 'board-3', runId: 'run-7',
      timestamp: new Date().toISOString(),
    };
    events.emit('file.event', { ...base, operation: 'update', filePath: 'src/app.ts', toolName: 'edit' });
    events.emit('file.event', { ...base, operation: 'read', filePath: 'src/other.ts', toolName: 'read' });
    events.emit('kanban.task_moved' as never, { sessionId: 's', taskId: 'task-9', boardId: 'board-3', from: 'doing', to: 'done' } as never);
    const recorded = await journal.readAll(); off();
    expect(recorded.map((event) => event.eventType)).toEqual(['file.event', 'kanban.task_moved']);
    expect(recorded[0]).toMatchObject({
      scope: { sessionId: 's', agentId: 'worker-1', taskId: 'task-9', kanbanBoardId: 'board-3' },
      resource: { kind: 'file', path: 'src/app.ts' },
      runtime: { providerId: 'openai', modelId: 'model-a' },
    });
    expect(recorded[1]).toMatchObject({ scope: { taskId: 'task-9', kanbanBoardId: 'board-3' } });
    // provider is intentionally stripped from attributes by sanitize (childKey === 'provider' continue);
    // model is preserved by PRESERVE_STRING_KEY and should survive sanitize.
    expect((recorded[0].attributes as Record<string, unknown>).model).toBe('model-a');
  });

  it('extracts provider/model into runtime from any domain event payload', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-domain-runtime-')); dirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, 'events.jsonl') });
    const events = new EventBus();
    const context = createChronicleContext({ installationId: 'i', machineId: 'm', sessionId: 'sess' }, 'trace');
    const off = wireDomainEventsToChronicle({ events, journal, context });

    // Emit an arbitrary domain event carrying provider/model — simulates
    // subagent events that include these fields in their payload.
    events.emit('agent.status_changed' as never, {
      sessionId: 'sess',
      subagentId: 'sub-1',
      agentName: 'BugHunter',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      status: 'running',
      ts: new Date().toISOString(),
    } as never);

    const recorded = await journal.readAll(); off();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.runtime).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
    });
    // provider is intentionally stripped from attributes by sanitize;
    // model is preserved by PRESERVE_STRING_KEY.
    expect((recorded[0].attributes as Record<string, unknown>).model).toBe('claude-sonnet-4-20250514');
  });
});
