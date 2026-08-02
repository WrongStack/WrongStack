import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildYoloCommand } from '../src/slash-commands/yolo.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

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

describe('/yolo slash command', () => {
  describe('metadata', () => {
    it('reports name and help text', () => {
      const cmd = buildYoloCommand(makeCtx());
      expect(cmd.name).toBe('yolo');
      expect(cmd.description).toMatch(/YOLO/);
      expect(cmd.help).toContain('/yolo on');
      expect(cmd.help).toContain('/yolo off');
      expect(cmd.help).toContain('/yolo destructive');
      expect(cmd.help).toContain('auto-approves tool calls');
    });
  });

  describe('when onYolo is missing', () => {
    it('reports unavailable and warns', async () => {
      const ctx = makeCtx();
      const cmd = buildYoloCommand(ctx);
      const result = await cmd.run!('on');
      expect(result?.message).toMatch(/not available/);
      expect(ctx.renderer.writeWarning).toHaveBeenCalled();
    });
  });

  describe('status query (no arg)', () => {
    let state: boolean;
    let onYolo: (next?: boolean) => boolean;
    let ctx: SlashCommandContext;

    beforeEach(() => {
      state = false;
      onYolo = vi.fn((next?: boolean) => {
        if (next !== undefined) state = next;
        return state;
      }) as never as (next?: boolean) => boolean;
      ctx = makeCtx({ onYolo });
    });

    it('shows OFF when current state is false', async () => {
      const cmd = buildYoloCommand(ctx);
      const result = await cmd.run!('');
      expect(stripAnsi(result!.message!)).toMatch(/YOLO mode: OFF/);
    });

    it('shows ON when current state is true', async () => {
      state = true;
      const cmd = buildYoloCommand(ctx);
      const result = await cmd.run!('');
      const message = stripAnsi(result!.message!);
      expect(message).toMatch(/YOLO mode: ON/);
      expect(message).toContain('tool calls');
    });

    it('does NOT call onYolo with an argument when querying', async () => {
      const cmd = buildYoloCommand(ctx);
      await cmd.run!('');
      // Reads only — every call is undefined-arg
      for (const call of (onYolo as never as { mock: { calls: unknown[][] } }).mock.calls) {
        expect(call[0]).toBeUndefined();
      }
    });
  });

  describe('set with explicit argument', () => {
    let state: boolean;
    let onYolo: (next?: boolean) => boolean;
    let ctx: SlashCommandContext;

    beforeEach(() => {
      state = false;
      onYolo = vi.fn((next?: boolean) => {
        if (next !== undefined) state = next;
        return state;
      }) as never as (next?: boolean) => boolean;
      ctx = makeCtx({ onYolo });
    });

    it.each(['on', 'enable', 'true', '1', 'ON', '  on  '])(
      '"%s" enables YOLO',
      async (arg) => {
        const cmd = buildYoloCommand(ctx);
        const result = await cmd.run!(arg);
        expect(state).toBe(true);
        const message = stripAnsi(result!.message!);
        expect(message).toMatch(/ENABLED/);
        expect(message).toContain('tool calls will be auto-approved');
      },
    );

    it.each(['off', 'disable', 'false', '0', 'OFF'])(
      '"%s" disables YOLO',
      async (arg) => {
        state = true;
        const cmd = buildYoloCommand(ctx);
        const result = await cmd.run!(arg);
        expect(state).toBe(false);
        expect(stripAnsi(result!.message!)).toMatch(/DISABLED/);
      },
    );

    it('toggle flips the current state', async () => {
      const cmd = buildYoloCommand(ctx);
      await cmd.run!('toggle');
      expect(state).toBe(true);
      await cmd.run!('toggle');
      expect(state).toBe(false);
    });

    it('rejects unknown argument with a warning', async () => {
      const cmd = buildYoloCommand(ctx);
      const result = await cmd.run!('maybe');
      expect(result?.message).toMatch(/Unknown argument/);
      expect(ctx.renderer.writeWarning).toHaveBeenCalled();
      // No state change
      expect(state).toBe(false);
    });
  });
});
