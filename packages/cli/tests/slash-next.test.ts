import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildNextCommand } from '../src/slash-commands/next.js';

// Strip ANSI escapes so message assertions match regardless of color.
const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

const makeCtx = (overrides: Partial<SlashCommandContext> = {}): SlashCommandContext => {
  const write = vi.fn();
  const writeWarning = vi.fn();
  return {
    renderer: { write, writeWarning } as never as SlashCommandContext['renderer'],
    ...overrides,
  } as never as SlashCommandContext;
};

describe('/next slash command', () => {
  describe('metadata', () => {
    it('reports name and help text', () => {
      const cmd = buildNextCommand(makeCtx());
      expect(cmd.name).toBe('next');
      expect(cmd.description).toMatch(/next-step suggestion/i);
      expect(cmd.aliases).toContain('enxt');
      expect(cmd.help).toContain('/next on');
      expect(cmd.help).toContain('/next off');
      expect(cmd.help).toContain('/next toggle');
    });
  });

  describe('when onNextPredict is missing', () => {
    it('reports unavailable and warns', async () => {
      const ctx = makeCtx();
      const cmd = buildNextCommand(ctx);
      const result = await cmd.run!('on');
      expect(result?.message).toMatch(/not available/);
      expect(ctx.renderer.writeWarning).toHaveBeenCalled();
    });
  });

  describe('status query (no arg)', () => {
    let state: boolean;
    let onNextPredict: (next?: boolean) => boolean;
    let ctx: SlashCommandContext;

    beforeEach(() => {
      state = false;
      onNextPredict = vi.fn((next?: boolean) => {
        if (next !== undefined) state = next;
        return state;
      }) as never as (next?: boolean) => boolean;
      ctx = makeCtx({ onNextPredict });
    });

    it('shows OFF when current state is false', async () => {
      const cmd = buildNextCommand(ctx);
      const result = await cmd.run!('');
      expect(stripAnsi(result!.message!)).toMatch(/Next-task prediction: OFF/);
    });

    it('shows ON when current state is true', async () => {
      state = true;
      const cmd = buildNextCommand(ctx);
      const result = await cmd.run!('');
      expect(stripAnsi(result!.message!)).toMatch(/Next-task prediction: ON/);
    });

    it('reads only — never passes an argument when querying', async () => {
      const cmd = buildNextCommand(ctx);
      await cmd.run!('');
      for (const call of (onNextPredict as never as { mock: { calls: unknown[][] } }).mock.calls) {
        expect(call[0]).toBeUndefined();
      }
    });
  });

  describe('set with explicit argument', () => {
    let state: boolean;
    let onNextPredict: (next?: boolean) => boolean;
    let ctx: SlashCommandContext;

    beforeEach(() => {
      state = false;
      onNextPredict = vi.fn((next?: boolean) => {
        if (next !== undefined) state = next;
        return state;
      }) as never as (next?: boolean) => boolean;
      ctx = makeCtx({ onNextPredict });
    });

    it('enables on "on"', async () => {
      const cmd = buildNextCommand(ctx);
      const result = await cmd.run!('on');
      expect(onNextPredict).toHaveBeenCalledWith(true);
      expect(state).toBe(true);
      expect(stripAnsi(result!.message!)).toMatch(/ON/);
    });

    it('disables on "off"', async () => {
      state = true;
      const cmd = buildNextCommand(ctx);
      const result = await cmd.run!('off');
      expect(onNextPredict).toHaveBeenCalledWith(false);
      expect(state).toBe(false);
      expect(stripAnsi(result!.message!)).toMatch(/OFF/);
    });

    it('flips state on "toggle"', async () => {
      const cmd = buildNextCommand(ctx);
      await cmd.run!('toggle');
      expect(state).toBe(true);
      await cmd.run!('toggle');
      expect(state).toBe(false);
    });

    it('warns on an unknown argument and does not mutate state', async () => {
      const cmd = buildNextCommand(ctx);
      const result = await cmd.run!('maybe');
      expect(result?.message).toMatch(/Unknown argument/);
      expect(ctx.renderer.writeWarning).toHaveBeenCalled();
      // Only the initial status read happened — no set call.
      for (const call of (onNextPredict as never as { mock: { calls: unknown[][] } }).mock.calls) {
        expect(call[0]).toBeUndefined();
      }
      expect(state).toBe(false);
    });
  });
});
