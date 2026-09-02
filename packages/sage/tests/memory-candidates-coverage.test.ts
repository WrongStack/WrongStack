import { describe, expect, it, vi } from 'vitest';
import type { SageServiceLike } from '../src/service-contract.js';
import { memoryCandidatesTool } from '../src/tools/memory-candidates-tool.js';

function service() {
  return {
    acceptCandidate: vi.fn(),
    rejectCandidate: vi.fn(async () => true),
    resolveCandidate: vi.fn(),
    createCandidate: vi.fn(async (input) => input),
    listCandidates: vi.fn(async () => []),
  } as unknown as SageServiceLike;
}

const options = { signal: new AbortController().signal } as never;

describe('memory candidates branch coverage', () => {
  it('validates reject identifiers and uses the default rejection reason', async () => {
    const memory = service();
    const tool = memoryCandidatesTool(memory);
    expect(tool.validate?.({ action: 'reject' })).toEqual([
      'candidate_id is required for accept or reject',
    ]);
    await tool.execute({ action: 'reject', candidate_id: 'candidate' }, {} as never, options);
    expect(memory.rejectCandidate).toHaveBeenCalledWith('candidate', 'Rejected by user or agent.');
  });

  it('builds complete and minimal proposals without inventing optional fields', async () => {
    const memory = service();
    const tool = memoryCandidatesTool(memory);
    await tool.execute(
      {
        action: 'propose',
        text: 'Complete proposal',
        scope: 'user',
        tags: ['existing'],
        importance: 0,
        confidence: 0,
      },
      {} as never,
      options,
    );
    expect(memory.createCandidate).toHaveBeenLastCalledWith({
      text: 'Complete proposal',
      scope: 'user',
      tags: ['existing'],
      importance: 0,
      confidence: 0,
    });

    await tool.execute({ action: 'propose', text: 'Minimal proposal' }, {} as never, options);
    expect(memory.createCandidate).toHaveBeenLastCalledWith({
      text: 'Minimal proposal',
    });
    expect(tool.validate?.({ action: 'propose', text: ' valid ' })).toEqual([]);
  });

  it('forwards an omitted resolve reason', async () => {
    const memory = service();
    const tool = memoryCandidatesTool(memory);
    await tool.execute(
      { action: 'resolve', candidate_id: 'candidate', decision: 'keep' },
      {} as never,
      options,
    );
    expect(memory.resolveCandidate).toHaveBeenCalledWith('candidate', 'keep', undefined);
    expect(
      tool.validate?.({ action: 'resolve', candidate_id: 'candidate', decision: 'keep' }),
    ).toEqual([]);
  });

  it('safely executes without opts and falls back to ctx.signal', async () => {
    const memory = service();
    const tool = memoryCandidatesTool(memory);
    const ctx = {} as never;

    await Reflect.apply(tool.execute, tool, [
      { action: 'reject', candidate_id: 'cand-no-opts' },
      ctx,
    ]);
    expect(memory.rejectCandidate).toHaveBeenCalledWith(
      'cand-no-opts',
      'Rejected by user or agent.',
    );

    const ac = new AbortController();
    ac.abort();
    const ctxWithSignal = { signal: ac.signal } as never;
    await expect(
      Reflect.apply(tool.execute, tool, [
        { action: 'reject', candidate_id: 'cand-no-opts' },
        ctxWithSignal,
      ]),
    ).rejects.toThrow();
  });
});
