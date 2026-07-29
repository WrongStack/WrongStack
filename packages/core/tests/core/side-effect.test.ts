import { describe, expect, it, vi } from 'vitest';
import { Context } from '../../src/core/context.js';
import type { SideEffect } from '../../src/types/side-effect.js';

/**
 * P2 #5 Phase 1 (before-release.md): structured side-effect recording.
 * Context.recordSideEffect() appends a `side_effect` session event and
 * accumulates in the in-memory `sideEffects` list for /diag. The session
 * append is fire-and-forget — it must never block or throw.
 */
function mkCtx(appendMock?: ReturnType<typeof vi.fn>): Context {
  return new Context({
    systemPrompt: [],
    provider: {} as never,
    session: {
      append: appendMock ?? vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      recordFileChange: vi.fn(),
      recordSideEffect: vi.fn(),
    } as never,
    signal: new AbortController().signal,
    tokenCounter: {} as never,
    cwd: '/p',
    projectRoot: '/p',
    model: 'm',
  });
}

describe('Context.recordSideEffect — structured audit (P2 #5)', () => {
  it('accumulates side effects in the in-memory list', () => {
    const ctx = mkCtx();
    const se: SideEffect = {
      toolUseId: 'tu-1',
      toolName: 'bash',
      ts: '2026-06-27T12:00:00Z',
      input: { command: 'echo hello' },
      outcome: 'exit 0',
      risk: 'shell',
    };
    ctx.recordSideEffect(se);
    expect(ctx.sideEffects).toHaveLength(1);
    expect(ctx.sideEffects[0]).toMatchObject({ toolName: 'bash', risk: 'shell' });
  });

  it('appends a side_effect session event', () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const ctx = mkCtx(append);
    ctx.recordSideEffect({
      toolUseId: 'tu-2',
      toolName: 'fetch',
      ts: '2026-06-27T12:01:00Z',
      input: { url: 'https://example.com' },
      outcome: 'HTTP 200',
      risk: 'network',
    });
    expect(append).toHaveBeenCalledOnce();
    const event = append.mock.calls[0]![0];
    expect(event.type).toBe('side_effect');
    expect(event.toolName).toBe('fetch');
    expect(event.risk).toBe('network');
    expect(event.input).toEqual({ url: 'https://example.com' });
    expect(event.outcome).toBe('HTTP 200');
  });

  it('fire-and-forget: does NOT throw when session.append rejects', () => {
    const append = vi.fn().mockRejectedValue(new Error('disk full'));
    const ctx = mkCtx(append);
    expect(() =>
      ctx.recordSideEffect({
        toolUseId: 'tu-3',
        toolName: 'install',
        ts: '2026-06-27T12:02:00Z',
        input: { packages: 'lodash' },
        outcome: 'success',
        risk: 'package',
      }),
    ).not.toThrow();
    // The in-memory list still has the record even if disk append failed.
    expect(ctx.sideEffects).toHaveLength(1);
  });

  it('clearFileTracking clears side effects alongside file tracking', () => {
    const ctx = mkCtx();
    ctx.recordSideEffect({
      toolUseId: 'tu-4',
      toolName: 'bash',
      ts: '2026-06-27T12:03:00Z',
      input: { command: 'ls' },
      risk: 'shell',
    });
    expect(ctx.sideEffects).toHaveLength(1);
    ctx.clearFileTracking();
    expect(ctx.sideEffects).toHaveLength(0);
  });

  it('accumulates multiple side effects in order', () => {
    const ctx = mkCtx();
    ctx.recordSideEffect({
      toolUseId: 'tu-5',
      toolName: 'bash',
      ts: '2026-06-27T12:04:00Z',
      input: { command: 'pnpm build' },
      outcome: 'exit 0',
      risk: 'shell',
    });
    ctx.recordSideEffect({
      toolUseId: 'tu-6',
      toolName: 'fetch',
      ts: '2026-06-27T12:05:00Z',
      input: { url: 'https://api.example.com' },
      outcome: 'HTTP 200',
      risk: 'network',
    });
    expect(ctx.sideEffects).toHaveLength(2);
    expect(ctx.sideEffects[0]?.toolName).toBe('bash');
    expect(ctx.sideEffects[1]?.toolName).toBe('fetch');
  });

  it('caps sideEffects at MAX_SIDE_EFFECTS with oldest-first eviction', () => {
    const ctx = mkCtx();
    const MAX = (Context as never as Record<string, number>)['MAX_SIDE_EFFECTS'] ?? 500;
    const over = MAX + 10;

    // Fill past the cap
    for (let i = 0; i < over; i++) {
      ctx.recordSideEffect({
        toolUseId: `tu-over-${i}`,
        toolName: 'bash',
        ts: new Date(Date.now() + i).toISOString(),
        input: { seq: i },
        outcome: 'exit 0',
        risk: 'shell',
      });
    }

    // Array is capped at MAX, not growing past it
    expect(ctx.sideEffects.length).toBeLessThanOrEqual(MAX);
    expect(ctx.sideEffects.length).toBe(MAX);

    // The first (oldest) entries were evicted; the last entry is present
    expect(ctx.sideEffects[0]?.toolUseId).toBe(`tu-over-${over - MAX}`);
    expect(ctx.sideEffects[MAX - 1]?.toolUseId).toBe(`tu-over-${over - 1}`);
  });

  it('the side_effect event shape matches the SessionEvent union', () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const ctx = mkCtx(append);
    ctx.recordSideEffect({
      toolUseId: 'tu-7',
      toolName: 'bash',
      ts: '2026-06-27T12:06:00Z',
      input: { command: 'rm -rf dist' },
      outcome: 'exit 0',
      risk: 'shell',
    });
    const event = append.mock.calls[0]![0];
    // All required fields present.
    expect(event).toHaveProperty('type', 'side_effect');
    expect(event).toHaveProperty('ts');
    expect(event).toHaveProperty('toolUseId', 'tu-7');
    expect(event).toHaveProperty('toolName', 'bash');
    expect(event).toHaveProperty('risk', 'shell');
    // Optional outcome present when provided.
    expect(event).toHaveProperty('outcome', 'exit 0');
  });
});
