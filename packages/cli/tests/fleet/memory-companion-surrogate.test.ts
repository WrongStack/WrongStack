import { EventBus } from '@wrongstack/contracts/kernel';
import type { SubagentConfig, TaskResult } from '@wrongstack/contracts/types';
import type { Director } from '@wrongstack/coordination';
import type { MemoryEvidenceSnapshot } from '@wrongstack/fleet';
import { HostMemoryCompanion } from '@wrongstack/fleet';
import type { Sage, SageSurface } from '@wrongstack/sage';
import { afterEach, describe, expect, it, vi } from 'vitest';

const evidence: MemoryEvidenceSnapshot = {
  fingerprint: 'hash1',
  files: [{ path: 'src/retry.ts', hash: 'sha', text: 'export const retryQuota = 3;' }],
  unavailable: [],
  changedAnchor: false,
};

/** Memory text whose astral character straddles the 600-character claim cap. */
function record(): Sage {
  return {
    id: 'm1',
    revision: 1,
    text: `${'a'.repeat(599)}\u{1F600}${'b'.repeat(10)}`,
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

/** True when `s` contains an unpaired surrogate half. */
function containsLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const instances: HostMemoryCompanion[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.stop();
});

function harness() {
  const events = new EventBus();
  let completed: (event: { result: TaskResult }) => void = () => {};
  const note = vi.fn();
  const getSage = vi.fn(async () => record());
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
    on: (event: string, handler: (event: { result: TaskResult }) => void) => {
      if (event === 'task.completed') completed = handler;
      return () => {};
    },
  } as unknown as Director;
  const companion = new HostMemoryCompanion({
    director,
    events,
    projectRoot: '/project',
    roster: { 'memory-curator': { name: 'Memory Curator', tools: [] } },
    memory: () => ({ getSage, retrieveForPath: async () => [] }) as unknown as SageSurface,
    enabled: () => true,
    scrub: (text) => text,
    note,
    snapshot: async () => evidence,
    timeoutMs: 5_000,
  });
  instances.push(companion);
  companion.ensure('leader');
  const emit = () =>
    events.emit('memory.injector_run', {
      sessionId: 'leader',
      contextPressure: 0,
      injected: [{ id: 'm1' }],
      paths: ['src/retry.ts'],
    } as never);
  const finish = (body: object) => {
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
  return { note, assignInternal, emit, finish };
}

describe('HostMemoryCompanion surrogate-safe historical claim', () => {
  // The historical claim rides in [memory:checking]/[memory:unverifiable]
  // payloads and the companion subagent's task description — model-bound
  // text. An astral character straddling the 600-character cut used to leave
  // an orphaned surrogate half that re-materializes when the payload JSON is
  // parsed back (the same class r22 fixed in system-one-recall.ts).
  it('caps the historical claim without splitting a surrogate pair', async () => {
    const h = harness();
    h.emit();

    await vi.waitFor(() => {
      expect(h.note.mock.calls.some((call) => call[1] === '[memory:checking]')).toBe(true);
    });
    const [, , checkingBody] = h.note.mock.calls.find((call) => call[1] === '[memory:checking]')!;
    const parsedChecking = JSON.parse(checkingBody) as { historicalClaim?: string };
    expect(parsedChecking.historicalClaim).toBe('a'.repeat(599));
    expect(parsedChecking.historicalClaim!.length).toBeLessThanOrEqual(600);
    expect(containsLoneSurrogate(parsedChecking.historicalClaim ?? '')).toBe(false);

    // The subagent task description's embedded evidence payload is
    // surrogate-safe too: parse the JSON the worker reads back.
    await vi.waitFor(() => expect(h.assignInternal.mock.calls.length).toBeGreaterThan(0));
    const description = h.assignInternal.mock.calls.at(-1)![0].description;
    const marker = 'Evidence payload:\n';
    const payloadStart = description.indexOf(marker) + marker.length;
    const parsedDescription = JSON.parse(description.slice(payloadStart)) as {
      sources?: Array<{ text?: string }>;
    };
    for (const source of parsedDescription.sources ?? []) {
      expect(containsLoneSurrogate(source.text ?? '')).toBe(false);
    }

    h.finish({
      verdict: 'unverifiable',
      summary: 'The excerpt does not establish the claim.',
      evidence: [{ path: 'src/retry.ts', quote: 'export const retryQuota = 3;' }],
    });
    await vi.waitFor(() => {
      expect(h.note.mock.calls.some((call) => call[1] === '[memory:review]')).toBe(true);
    });
    const [, , reviewBody] = h.note.mock.calls.find((call) => call[1] === '[memory:review]')!;
    const parsedReview = JSON.parse(reviewBody) as { verdict?: string };
    expect(parsedReview.verdict).toBe('unverifiable');
    expect(containsLoneSurrogate(reviewBody)).toBe(false);
  });
});
