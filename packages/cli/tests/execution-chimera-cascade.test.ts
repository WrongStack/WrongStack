import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installChimeraCascadeHandler } from '../src/execution-chimera-cascade.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

function harness(director: Record<string, unknown> | null) {
  let handler: ((event: unknown, payload: unknown) => void) | undefined;
  let pending: Promise<void> | undefined;
  const session = { append: vi.fn().mockResolvedValue(undefined) };
  const events = {
    onPattern: vi.fn((_name, value) => {
      handler = value;
    }),
    emitCustom: vi.fn(),
  };
  installChimeraCascadeHandler({
    events: events as never,
    director: director as never,
    session: session as never,
    getPendingWork: () => pending,
    trackWork: (work) => {
      pending = work;
    },
  });
  return {
    events,
    session,
    emit: (payload: unknown) => handler?.({}, payload),
    wait: () => pending,
  };
}

describe('installChimeraCascadeHandler', () => {
  it('skips cascades without a Director or requested agents', () => {
    const absent = harness(null);
    absent.emit({ agents: ['bug-hunter'] });
    expect(absent.wait()).toBeUndefined();

    const empty = harness({ spawn: vi.fn() });
    empty.emit({ agents: [] });
    expect(empty.wait()).toBeUndefined();
  });

  it('runs successful and failed cascade agents, terminates them, and enforces depth', async () => {
    const director = {
      spawn: vi.fn().mockResolvedValueOnce('agent-1').mockResolvedValueOnce('agent-2'),
      assign: vi.fn().mockResolvedValue(undefined),
      awaitTasks: vi
        .fn()
        .mockResolvedValueOnce([{ status: 'success', result: { fixed: true } }])
        .mockResolvedValueOnce([{ status: 'failed', error: new Error('not fixed') }]),
      terminate: vi.fn().mockResolvedValue(undefined),
    };
    const h = harness(director);
    h.emit({
      agents: ['security-scanner', 'bug-hunter'],
      bundle: {
        cwd: 'D:/repo',
        files: [],
        cascadeDepth: 1,
        maxCascadeDepth: 1,
      },
      reviewText: 'review',
      severities: { critical: 0, high: 1, medium: 0 },
    });
    await h.wait();

    expect(director.spawn).toHaveBeenCalledTimes(2);
    expect(director.spawn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ role: 'security-scanner' }),
    );
    expect(director.terminate).toHaveBeenCalledTimes(2);
    const writes = h.session.append.mock.calls.map(([entry]) => entry);
    expect(writes.some((entry) => entry.type === 'llm_response')).toBe(true);
    expect(writes.some((entry) => entry.type === 'error')).toBe(true);
    expect(writes.some((entry) => String(entry.content?.[0]?.text).includes('depth limit'))).toBe(
      true,
    );
  });

  it('re-reads changed files and records cascade spawn failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chimera-cascade-'));
    roots.push(root);
    await writeFile(join(root, 'changed.ts'), 'changed');
    const director = {
      spawn: vi.fn().mockRejectedValueOnce('spawn failed').mockResolvedValueOnce('agent-2'),
      assign: vi.fn().mockResolvedValue(undefined),
      awaitTasks: vi.fn().mockResolvedValue([{ status: 'success', result: 'fixed' }]),
      terminate: vi.fn().mockRejectedValue('terminate failed'),
    };
    const h = harness(director);
    h.emit({
      agents: ['bug-hunter', 'security-scanner'],
      bundle: {
        cwd: root,
        files: [{ path: 'changed.ts' }, { path: 'deleted.ts' }],
        cascadeDepth: 0,
        maxCascadeDepth: 2,
      },
      reviewText: 'review',
      severities: { critical: 0, high: 1, medium: 0 },
    });
    await h.wait();

    const writes = JSON.stringify(h.session.append.mock.calls);
    expect(writes).toContain('spawn failed');
    expect(writes).toContain('re-reviewing 1 file');
  });
});
