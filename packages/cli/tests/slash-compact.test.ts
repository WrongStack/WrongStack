import type { Context, Provider } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import { buildCompactCommand } from '../src/slash-commands/compact.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

const makeCtx = (
  compactor?: SlashCommandContext['compactor'],
  opts?: { maxContext?: number; provider?: Provider },
): SlashCommandContext => {
  const write = vi.fn();
  const writeInfo = vi.fn();
  const writeWarning = vi.fn();
  return {
    compactor,
    renderer: { write, writeInfo, writeWarning } as never,
  } as never as SlashCommandContext;
};

const makeFakeContext = (overrides?: Partial<Context>): Context =>
  ({
    lastRequestTokens: undefined,
    meta: {},
    provider: { capabilities: { maxContext: 200_000 } },
    ...overrides,
  }) as never as Context;

const baseReport = {
  before: 100_000,
  after: 60_000,
  fullRequestTokensBefore: 100_000,
  fullRequestTokensAfter: 60_000,
  reductions: [
    { phase: 'elision' as const, saved: 25_000 },
    { phase: 'selective' as const, saved: 15_000 },
  ],
};

describe('/compact slash command', () => {
  it('exposes metadata', () => {
    const cmd = buildCompactCommand(makeCtx());
    expect(cmd.name).toBe('compact');
    expect(cmd.help).toContain('/compact aggressive');
  });

  it('warns when no compactor is configured', async () => {
    const ctx = makeCtx();
    const cmd = buildCompactCommand(ctx);
    const result = await cmd.run!('', makeFakeContext());
    expect(result!.message).toBe('No compactor configured.');
    expect(ctx.renderer.writeWarning).toHaveBeenCalledWith('No compactor configured.');
  });

  it('calls compactor with aggressive:false by default', async () => {
    const compact = vi.fn(async () => baseReport);
    const ctx = makeCtx({ compact });
    const cmd = buildCompactCommand(ctx);
    await cmd.run!('', makeFakeContext());
    expect(compact).toHaveBeenCalledWith(expect.anything(), { aggressive: false });
  });

  it('passes aggressive:true when args trim to "aggressive"', async () => {
    const compact = vi.fn(async () => baseReport);
    const ctx = makeCtx({ compact });
    const cmd = buildCompactCommand(ctx);
    await cmd.run!('  aggressive  ', makeFakeContext());
    expect(compact).toHaveBeenCalledWith(expect.anything(), { aggressive: true });
  });

  it('renders before/after token totals and per-phase reductions', async () => {
    const compact = vi.fn(async () => baseReport);
    const ctx = makeCtx({ compact });
    const cmd = buildCompactCommand(ctx);
    const result = await cmd.run!('', makeFakeContext());
    expect(result!.message).toMatch(/100000.*→.*60000 tokens/);
    expect(result!.message).toContain('elision: 25000');
    expect(result!.message).toContain('selective: 15000');
  });

  it('includes repair counts when the report has a repaired field', async () => {
    const compact = vi.fn(async () => ({
      ...baseReport,
      repaired: {
        removedToolUses: ['t1', 't2'],
        removedToolResults: ['r1'],
        removedMessages: 3,
      },
    }) as typeof baseReport & { repaired: { removedToolUses: string[]; removedToolResults: string[]; removedMessages: number } });
    const ctx = makeCtx({ compact });
    const cmd = buildCompactCommand(ctx);
    const result = await cmd.run!('', makeFakeContext());
    expect(result!.message).toContain('repaired 2 tool_use');
    expect(result!.message).toContain('1 tool_result');
    expect(result!.message).toContain('3 empty messages');
  });

  it('omits repair section when the field is absent', async () => {
    const compact = vi.fn(async () => baseReport);
    const ctx = makeCtx({ compact });
    const cmd = buildCompactCommand(ctx);
    const result = await cmd.run!('', makeFakeContext());
    expect(result!.message).not.toMatch(/repaired/);
  });

  it('shows context percentage when provider has maxContext', async () => {
    const compact = vi.fn(async () => baseReport);
    const ctx = makeCtx({ compact });
    const cmd = buildCompactCommand(ctx);
    const result = await cmd.run!('', makeFakeContext({ provider: { capabilities: { maxContext: 200_000 } } as Provider }));
    // 60k / 200k = 30%
    expect(result!.message).toContain('30%');
  });

  it('shows "already optimal" message when nothing changed', async () => {
    const noopReport = {
      before: 50_000,
      after: 50_000,
      fullRequestTokensBefore: 50_000,
      fullRequestTokensAfter: 50_000,
      reductions: [],
    };
    const compact = vi.fn(async () => noopReport);
    const ctx = makeCtx({ compact });
    const cmd = buildCompactCommand(ctx);
    const result = await cmd.run!('', makeFakeContext());
    expect(result!.message).toMatch(/already optimal|nothing to compact/i);
  });

  it('updates ctx.lastRequestTokens after compact', async () => {
    const compact = vi.fn(async () => baseReport);
    const ctx = makeCtx({ compact });
    const cmd = buildCompactCommand(ctx);
    const fakeCtx = makeFakeContext();
    await cmd.run!('', fakeCtx);
    expect(fakeCtx.lastRequestTokens).toBe(60_000);
  });

  it('pushes post-compaction tokens into tokenCounter', async () => {
    const setSpy = vi.fn();
    const compact = vi.fn(async () => baseReport);
    const ctx = makeCtx({ compact });
    const cmd = buildCompactCommand(ctx);
    const fakeCtx = makeFakeContext({ tokenCounter: { setCurrentRequestTokens: setSpy } } as unknown as Context);
    await cmd.run!('', fakeCtx);
    expect(setSpy).toHaveBeenCalledWith(60_000);
  });

  it('skips tokenCounter push when tokenCounter is absent', async () => {
    const compact = vi.fn(async () => baseReport);
    const ctx = makeCtx({ compact });
    const cmd = buildCompactCommand(ctx);
    const fakeCtx = makeFakeContext({ tokenCounter: undefined });
    await expect(cmd.run!('', fakeCtx)).resolves.toBeDefined();
  });

  it('handles undefined fullRequestTokensAfter gracefully', async () => {
    const compact = vi.fn(async () => ({
      before: 50_000, after: 50_000,
      fullRequestTokensBefore: undefined, fullRequestTokensAfter: undefined,
      reductions: [],
    }));
    const ctx = makeCtx({ compact });
    const cmd = buildCompactCommand(ctx);
    await cmd.run!('', makeFakeContext());
    expect(ctx.renderer.writeInfo).toHaveBeenCalledWith(expect.stringMatching(/already optimal/i));
  });

  it('writes the summary line to the renderer info channel', async () => {
    const compact = vi.fn(async () => baseReport);
    const ctx = makeCtx({ compact });
    const cmd = buildCompactCommand(ctx);
    await cmd.run!('', makeFakeContext());
    expect(ctx.renderer.writeInfo).toHaveBeenCalledTimes(1);
  });
});
