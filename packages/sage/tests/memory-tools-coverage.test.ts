import { describe, expect, it, vi } from 'vitest';
import type { SageServiceLike } from '../src/service-contract.js';
import { createSageTools } from '../src/tools/memory-tools.js';

function service(overrides: Record<string, unknown> = {}): SageServiceLike {
  return {
    rememberSage: vi.fn(async (input) => input),
    updateSage: vi.fn(async (_id, patch) => patch),
    deleteSage: vi.fn(async () => {}),
    getSage: vi.fn(async () => null),
    recoverSage: vi.fn(),
    backfillRecoverable: vi.fn(async (input) => input),
    ...overrides,
  } as unknown as SageServiceLike;
}

const options = { signal: new AbortController().signal } as never;

describe('memory tool completion coverage', () => {
  it('validates and executes memory updates', async () => {
    const memory = service();
    const tool = createSageTools(memory).find((t) => t.name === 'memory_update')!;
    expect(tool.validate?.({ id: '' } as never)).toEqual(['id is required']);
    expect(tool.validate?.({ id: 'memory' } as never)).toEqual([
      'at least one field to update is required',
    ]);
    expect(tool.validate?.({ id: 'memory', text: 'updated' } as never)).toEqual([]);
    await tool.execute({ id: 'memory', text: 'updated' } as never, {} as never, options);
    expect(memory.updateSage).toHaveBeenCalledWith('memory', { text: 'updated' });
  });

  it('validates deletion and forwards both never-inject shapes', async () => {
    const memory = service();
    const tool = createSageTools(memory).find((t) => t.name === 'memory_delete')!;
    expect(tool.validate?.({ force: true } as never)).toEqual(['id is required']);
    expect(tool.validate?.({ id: 'memory' } as never)?.[0]).toContain('force: true is required');
    expect(tool.validate?.({ id: 'memory', force: true } as never)).toEqual([]);

    await tool.execute({ id: 'memory', force: true, neverInject: true }, {} as never, options);
    expect(memory.deleteSage).toHaveBeenLastCalledWith('memory', undefined, {
      force: true,
      neverInject: true,
    });
    await tool.execute({ id: 'memory', force: true }, {} as never, options);
    expect(memory.deleteSage).toHaveBeenLastCalledWith('memory', undefined, { force: true });
  });

  it('rejects missing recovery targets and distinguishes writes from no-ops', async () => {
    const missing = service();
    const missingTool = createSageTools(missing).find((t) => t.name === 'memory_recover')!;
    await expect(missingTool.execute({ id: 'missing' }, {} as never, options)).rejects.toThrow(
      'not found',
    );

    const recovered = {
      id: 'memory',
      status: 'active',
      text: 'restored',
    };
    const deleted = service({
      getSage: vi.fn(async () => ({ id: 'memory', status: 'deleted' })),
      recoverSage: vi.fn(async () => recovered),
    });
    const recoverOnDeleted = createSageTools(deleted).find((t) => t.name === 'memory_recover')!;
    await expect(
      recoverOnDeleted.execute({ id: 'memory', reason: 'undo' }, {} as never, options),
    ).resolves.toMatchObject({ recovered: true, id: 'memory', noop: false });

    const active = service({
      getSage: vi.fn(async () => ({ id: 'memory', status: 'active' })),
      recoverSage: vi.fn(async () => recovered),
    });
    const recoverOnActive = createSageTools(active).find((t) => t.name === 'memory_recover')!;
    await expect(
      recoverOnActive.execute({ id: 'memory' }, {} as never, options),
    ).resolves.toMatchObject({ noop: true });
  });

  it('previews and applies recoverable backfills with optional filters', async () => {
    const memory = service();
    const tool = createSageTools(memory).find((t) => t.name === 'memory_backfill_recoverable')!;
    await tool.execute({}, {} as never, options);
    expect(memory.backfillRecoverable).toHaveBeenLastCalledWith({ dryRun: true });

    const filter = { kinds: ['fact' as const], requireText: false };
    await tool.execute({ apply: true, filter }, {} as never, options);
    expect(memory.backfillRecoverable).toHaveBeenLastCalledWith({
      dryRun: false,
      filter,
    });
  });

  it('auto-scopes by mode, combines role and mode, and honors explicit opt-out', async () => {
    const memory = service();
    const tool = createSageTools(memory).find((t) => t.name === 'remember')!;
    await tool.execute({ text: 'mode scoped' }, { meta: { mode: 'review' } } as never, options);
    expect(memory.rememberSage).toHaveBeenLastCalledWith(
      expect.objectContaining({ audience: { modes: ['review'] } }),
    );

    await tool.execute(
      { text: 'both scoped' },
      { meta: { agentRole: 'reviewer', mode: 'review' } } as never,
      options,
    );
    expect(memory.rememberSage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        audience: { roles: ['reviewer'], modes: ['review'] },
      }),
    );

    await tool.execute(
      { text: 'general', no_auto_audience: true },
      { meta: { agentRole: 'reviewer', mode: 'review' } } as never,
      options,
    );
    expect(memory.rememberSage).toHaveBeenLastCalledWith(
      expect.objectContaining({ audience: undefined }),
    );
  });
});
