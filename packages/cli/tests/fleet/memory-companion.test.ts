import { EventBus } from '@wrongstack/contracts/kernel';
import type { SubagentConfig, TaskResult } from '@wrongstack/contracts/types';
import type { Director } from '@wrongstack/core/coordination';
import type { Sage, SageSurface } from '@wrongstack/sage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostMemoryCompanion } from '../../src/fleet/host-memory-companion.js';
import type { MemoryEvidenceSnapshot } from '../../src/fleet/memory-companion-evidence.js';

const quote = 'export const retryQuota = 3;';
const evidence: MemoryEvidenceSnapshot = {
  fingerprint: 'hash1',
  files: [{ path: 'src/retry.ts', hash: 'sha', text: quote }],
  unavailable: [],
  changedAnchor: false,
};
function record(id = 'm1'): Sage {
  return {
    id,
    revision: 1,
    text: 'Transport retries have no quota.',
    kind: 'fact',
    scope: 'project',
    status: 'active',
    importance: 0.9,
    confidence: 0.8,
    freshness: 1,
    tags: [],
    anchors: [{ type: 'file', path: 'src/retry.ts' }],
    sources: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
const instances: HostMemoryCompanion[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.stop();
});
function harness(timeoutMs?: number, ioTimeoutMs?: number) {
  const events = new EventBus();
  let completed: (event: { result: TaskResult }) => void = () => {};
  let current = record();
  let enabled = true;
  const note = vi.fn();
  const snapshot = vi.fn(async () => evidence);
  const getSage = vi.fn(async (id: string) => ({ ...current, id }));
  const retrieveForPath = vi.fn(async () => [] as Sage[]);
  const spawn = vi.fn(async (_config: SubagentConfig) => 'worker');
  const assignInternal = vi.fn(
    async (_task: { id: string; subagentId: string; description: string }) => {},
  );
  const terminate = vi.fn(async () => {});
  const director = {
    spawnCompanion: spawn,
    assignInternal,
    terminate,
    status: () => ({ subagents: [{ id: 'worker' }] }),
    on: (_event: string, handler: typeof completed) => {
      completed = handler;
      return () => {};
    },
  } as unknown as Director;
  const companion = new HostMemoryCompanion({
    director,
    events,
    projectRoot: '/project',
    roster: { 'memory-curator': { name: 'Memory Curator', tools: ['memory_delete'] } },
    memory: () => ({ getSage, retrieveForPath }) as unknown as SageSurface,
    enabled: () => enabled,
    scrub: (text) => text.replaceAll('secret-fixture', '[redacted]'),
    note,
    snapshot,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(ioTimeoutMs === undefined ? {} : { ioTimeoutMs }),
  });
  instances.push(companion);
  companion.ensure('leader');
  const emit = (sessionId = 'leader', ids = ['m1'], paths: string[] = [], contextPressure = 0) =>
    events.emit('memory.injector_run', {
      sessionId,
      contextPressure,
      injected: ids.map((id) => ({ id })),
      paths,
    } as never);
  const finish = (
    body: object = {
      verdict: 'contradicted',
      summary: 'The current source defines a quota.',
      evidence: [{ path: 'src/retry.ts', quote }],
    },
  ) => {
    const task = assignInternal.mock.calls.at(-1)![0];
    completed({
      result: {
        taskId: task.id,
        subagentId: 'worker',
        status: 'success',
        result: JSON.stringify(body),
      } as TaskResult,
    });
  };
  const finishWithProseSummary = (body: object) => {
    const task = assignInternal.mock.calls.at(-1)![0];
    completed({
      result: {
        taskId: task.id,
        subagentId: 'worker',
        status: 'success',
        report: {
          summary: 'Checked retry.ts and found a contradictive quota constant.',
          findings: [],
          files_examined: ['src/retry.ts'],
          confidence: 0.95,
          suggested_next_steps: [],
        },
        result: JSON.stringify(body),
        iterations: 1,
        toolCalls: 0,
        durationMs: 1,
      } as TaskResult,
    });
  };
  return {
    events,
    companion,
    emit,
    finish,
    finishWithProseSummary,
    note,
    snapshot,
    spawn,
    assignInternal,
    terminate,
    getSage,
    retrieveForPath,
    setRecord: (next: Sage) => {
      current = next;
    },
    disable: () => {
      enabled = false;
    },
  };
}

describe('Memory Companion', () => {
  it('carries conditional applicability to the worker and leader without treating source matches as proof', async () => {
    const h = harness();
    const m = record();
    m.lastVerifiedAt = new Date().toISOString();
    m.validity = {
      statement: 'Only when no session override is configured.',
      checks: [{ type: 'source_contains', path: 'src/retry.ts', text: quote }],
    };
    h.setRecord(m);
    const validityChecks = [{ path: 'src/retry.ts', text: quote, status: 'satisfied' as const }];
    h.snapshot.mockResolvedValue({ ...evidence, validityChecks });
    const published: unknown[] = [];
    h.events.onPattern('memory.companion_review', (_name, payload) => published.push(payload));
    h.emit();
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    expect(h.assignInternal.mock.calls[0]![0].description).toContain(m.validity.statement);
    h.finish();
    await vi.waitFor(() =>
      expect(h.note.mock.calls.some((call) => call[1] === '[memory:review]')).toBe(true),
    );
    const review = JSON.parse(h.note.mock.calls.find((call) => call[1] === '[memory:review]')![2]);
    expect(review.validityChecks).toEqual(validityChecks);
    expect(review.applicability).toContain('unknown');
    expect(review.validity).toEqual(m.validity);
    expect(published[0]).toMatchObject({
      memoryId: 'm1',
      observedRevision: 1,
      sessionId: 'leader',
      verdict: 'contradicted',
    });
  });
  it('reviews an unchanged challenged memory even after a useful judgment', async () => {
    const h = harness();
    const m = record();
    m.lastVerifiedAt = new Date().toISOString();
    m.feedback = [
      {
        verdict: 'incorrect',
        observedRevision: 1,
        evidence: 'Source contradicts this claim.',
        at: new Date().toISOString(),
      },
      {
        verdict: 'useful',
        observedRevision: 1,
        evidence: 'Useful context for another task.',
        at: new Date().toISOString(),
      },
    ];
    h.setRecord(m);
    h.emit();
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    expect(h.note.mock.calls.some((call) => call[2].includes('model_challenged'))).toBe(true);
    h.finish();
    await vi.waitFor(() =>
      expect(h.note.mock.calls.some((call) => call[1] === '[memory:review]')).toBe(true),
    );
  });
  it('does not let a hung preflight read block the following queued memory', async () => {
    const h = harness(undefined, 15);
    h.getSage.mockImplementationOnce(() => new Promise<Sage>(() => {}));
    h.emit('leader', ['hung', 'ready']);
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    expect(h.assignInternal.mock.calls[0]![0].description).toContain('"memoryId":"ready"');
    h.finish();
  });

  it('reports uncertainty when final source validation times out', async () => {
    const h = harness(undefined, 15);
    h.snapshot
      .mockResolvedValueOnce(evidence)
      .mockImplementationOnce(() => new Promise<MemoryEvidenceSnapshot>(() => {}));
    h.emit();
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    h.finish();
    await vi.waitFor(() => expect(h.note.mock.calls.at(-1)?.[1]).toBe('[memory:unverifiable]'));
    expect(h.note.mock.calls.some((call) => call[1] === '[memory:review]')).toBe(false);
  });

  it('rechecks the memory revision after asynchronous source validation', async () => {
    const h = harness();
    h.snapshot.mockResolvedValueOnce(evidence).mockImplementationOnce(async () => {
      h.setRecord({ ...record(), revision: 2 });
      return evidence;
    });
    h.emit();
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    h.finish();
    await vi.waitFor(() => expect(h.getSage).toHaveBeenCalledTimes(3));
    expect(h.note.mock.calls.some((call) => call[1] === '[memory:review]')).toBe(false);
  });

  it('does not start a probe under high context pressure and can resume later', async () => {
    const h = harness();
    h.emit('leader', ['m1'], [], 0.9);
    expect(h.getSage).not.toHaveBeenCalled();
    h.emit('leader', ['m1'], [], 0.5);
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    h.finish();
  });

  it('routes separate conversation reviews to their own notes and scrubs payloads', async () => {
    const h = harness();
    h.companion.ensure('second');
    h.setRecord({ ...record(), text: 'Historical secret-fixture observation.' });
    h.emit('leader');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    expect(h.assignInternal.mock.calls[0]![0].description).not.toContain('secret-fixture');
    h.finish();
    await vi.waitFor(() => expect(h.note.mock.calls.at(-1)?.[1]).toBe('[memory:review]'));
    expect(h.note.mock.calls.at(-1)?.[0]).toBe('leader');
    h.emit('second');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(2));
    h.finish();
    await vi.waitFor(() => expect(h.note.mock.calls.at(-1)?.[1]).toBe('[memory:review]'));
    expect(h.note.mock.calls.at(-1)?.[0]).toBe('second');
  });

  it('discards queued work when a conversation closes', async () => {
    const h = harness();
    h.emit('leader', ['a', 'b', 'c']);
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    h.companion.release('leader');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.terminate).toHaveBeenCalledWith('worker');
    expect(h.assignInternal).toHaveBeenCalledTimes(1);
  });

  it('times out a hung task and reports uncertainty rather than success', async () => {
    const h = harness(15);
    h.emit();
    await vi.waitFor(() => expect(h.note.mock.calls.at(-1)?.[1]).toBe('[memory:unverifiable]'));
    expect(h.terminate).toHaveBeenCalledWith('worker');
  });

  it('terminates a worker that finishes spawning after its startup deadline', async () => {
    const h = harness(10);
    let resolveSpawn!: (id: string) => void;
    h.spawn.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSpawn = resolve;
        }),
    );
    h.emit();
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    resolveSpawn('late-worker');
    await vi.waitFor(() => expect(h.terminate).toHaveBeenCalledWith('late-worker'));
    expect(h.assignInternal).not.toHaveBeenCalled();
  });

  it('does not inspect another session or audience-specific memory', async () => {
    const h = harness();
    h.setRecord({ ...record(), scope: 'session', ownerSessionId: 'other' });
    h.emit();
    await vi.waitFor(() => expect(h.getSage).toHaveBeenCalled());
    expect(h.snapshot).not.toHaveBeenCalled();
    h.setRecord({ ...record(), audience: { roles: ['reviewer'] } });
    h.emit();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it('lazily checks one claim, uses read-only tools and returns a source-backed session note', async () => {
    const h = harness();
    expect(h.spawn).not.toHaveBeenCalled();
    h.emit();
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    const config = h.spawn.mock.calls[0]![0] as unknown as {
      tools: string[];
      allowedCapabilities: string[];
      originSessionId: string;
    };
    expect(config.tools).not.toContain('memory_delete');
    expect(config.tools).not.toContain('bash');
    expect(config.allowedCapabilities).toEqual(['fs.read']);
    expect(config.originSessionId).toBe('leader');
    expect(h.note.mock.calls[0]?.[1]).toBe('[memory:checking]');
    h.finish();
    await vi.waitFor(() => expect(h.note.mock.calls.at(-1)?.[1]).toBe('[memory:review]'));
    expect(h.note.mock.calls.at(-1)?.[0]).toBe('leader');
    expect(h.note.mock.calls.at(-1)?.[2]).toContain('sourceFingerprint');
    h.emit();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(h.assignInternal).toHaveBeenCalledTimes(1);
  });

  it('ignores unknown sessions, disabled sessions and freshly verified claims', async () => {
    const h = harness();
    h.emit('worker-session');
    h.setRecord({ ...record(), lastVerifiedAt: new Date().toISOString() });
    h.emit();
    await vi.waitFor(() => expect(h.snapshot).toHaveBeenCalled());
    expect(h.spawn).not.toHaveBeenCalled();
    h.disable();
    h.emit();
    expect(h.assignInternal).not.toHaveBeenCalled();
  });

  it('inspects stale path matches separately from normal injection', async () => {
    const h = harness();
    h.setRecord({ ...record(), status: 'stale' });
    h.retrieveForPath.mockResolvedValue([{ ...record(), status: 'stale' }]);
    h.emit('leader', [], ['src/retry.ts']);
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    expect(h.retrieveForPath).toHaveBeenCalledWith({
      path: 'src/retry.ts',
      includeStatuses: ['stale'],
      limit: 2,
      sessionId: 'leader',
    });
    h.finish();
  });

  it('rejects an unsupported verdict rather than echoing it as fact', async () => {
    const h = harness();
    h.emit();
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    h.finish({ verdict: 'supported', summary: 'Trust this.', evidence: [] });
    await vi.waitFor(() => expect(h.note.mock.calls.at(-1)?.[1]).toBe('[memory:unverifiable]'));
    expect(h.note.mock.calls.at(-1)?.[2]).not.toContain('Trust this');
  });

  it.each(['revision', 'source', 'session'])(
    'does not forward a late positive conclusion after %s changes',
    async (change) => {
      const h = harness();
      h.emit();
      await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
      if (change === 'revision') h.setRecord({ ...record(), revision: 2 });
      if (change === 'source') h.snapshot.mockResolvedValue({ ...evidence, fingerprint: 'hash2' });
      if (change === 'session') h.companion.release('leader');
      h.finish();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.note.mock.calls.some((call) => call[1] === '[memory:review]')).toBe(false);
    },
  );

  it('has one in-flight task and a four-probe conversation budget', async () => {
    const h = harness();
    h.emit('leader', ['a', 'b', 'c', 'd', 'e', 'f']);
    for (let i = 1; i <= 4; i++) {
      await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(i));
      h.finish();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.assignInternal).toHaveBeenCalledTimes(4);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable source evidence without starting an LLM', async () => {
    const h = harness();
    h.snapshot.mockResolvedValue({ ...evidence, files: [], unavailable: ['src/retry.ts'] });
    h.emit();
    await vi.waitFor(() => expect(h.note).toHaveBeenCalledTimes(1));
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.note.mock.calls[0]?.[1]).toBe('[memory:unverifiable]');
  });

  it('falls back to result.result when report.summary is prose rather than JSON', async () => {
    const h = harness();
    h.emit();
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    h.finishWithProseSummary({
      verdict: 'contradicted',
      summary: 'The current source defines a quota.',
      evidence: [{ path: 'src/retry.ts', quote }],
    });
    await vi.waitFor(() =>
      expect(h.note.mock.calls.some((call) => call[1] === '[memory:review]')).toBe(true),
    );
  });

  it('drops queued reviews and suppresses unverifiable note when the session is stopped', async () => {
    const h = harness();
    h.emit('leader', ['m1', 'm2']);
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    const firstTask = h.assignInternal.mock.calls[0]![0];
    // Simulate coordinator stopping the task on session stop.
    h.note.mockClear();
    const onCompleted = (
      h.companion as unknown as {
        active?: { settle: (r?: TaskResult) => void };
        pending: Map<string, unknown>;
      }
    ).active;
    expect(onCompleted).toBeDefined();
    onCompleted!.settle({
      taskId: firstTask.id,
      subagentId: 'worker',
      status: 'stopped',
      iterations: 0,
      toolCalls: 0,
      durationMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      h.note.mock.calls.filter(
        (call) => call[1] === '[memory:unverifiable]' || call[1] === '[memory:review]',
      ),
    ).toHaveLength(0);
  });
});
