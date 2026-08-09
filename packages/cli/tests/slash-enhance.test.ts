import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEnhanceCommand } from '../src/slash-commands/enhance.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

function makeController(enabled: boolean) {
  const controller = {
    enabled,
    setEnabled: vi.fn((v: boolean) => {
      controller.enabled = v;
    }),
  };
  return controller;
}

const makeCtx = (overrides: Partial<SlashCommandContext> = {}): SlashCommandContext => {
  const write = vi.fn();
  const writeWarning = vi.fn();
  return {
    renderer: { write, writeWarning } as never,
    // No configStore/paths → persistence is skipped (toggle still applies).
    ...overrides,
  } as never as SlashCommandContext;
};

describe('/enhance slash command', () => {
  it('exposes name + help', () => {
    const cmd = buildEnhanceCommand(makeCtx({ enhanceController: makeController(true) }));
    expect(cmd.name).toBe('enhance');
    expect(cmd.description).toMatch(/refinement/i);
    expect(cmd.help).toContain('/enhance on');
    expect(cmd.help).toContain('/enhance off');
  });

  it('reports unavailable when no controller is wired', async () => {
    const ctx = makeCtx();
    const cmd = buildEnhanceCommand(ctx);
    const res = await cmd.run!('on');
    expect(res?.message).toMatch(/not available/i);
    expect(ctx.renderer.writeWarning).toHaveBeenCalled();
  });

  describe('status query (no arg)', () => {
    it('shows ON when enabled', async () => {
      const ctx = makeCtx({ enhanceController: makeController(true) });
      const res = await buildEnhanceCommand(ctx).run!('');
      expect(stripAnsi(res!.message!)).toMatch(/ON/);
    });
    it('shows OFF when disabled', async () => {
      const ctx = makeCtx({ enhanceController: makeController(false) });
      const res = await buildEnhanceCommand(ctx).run!('');
      expect(stripAnsi(res!.message!)).toMatch(/OFF/);
    });
  });

  describe('toggling', () => {
    let controller: ReturnType<typeof makeController>;
    let ctx: SlashCommandContext;
    beforeEach(() => {
      controller = makeController(true);
      ctx = makeCtx({ enhanceController: controller });
    });

    it('/enhance off disables', async () => {
      const res = await buildEnhanceCommand(ctx).run!('off');
      expect(controller.setEnabled).toHaveBeenCalledWith(false);
      expect(controller.enabled).toBe(false);
      expect(stripAnsi(res!.message!)).toMatch(/DISABLED/);
    });

    it('/enhance on enables', async () => {
      controller.enabled = false;
      const res = await buildEnhanceCommand(ctx).run!('on');
      expect(controller.setEnabled).toHaveBeenCalledWith(true);
      expect(controller.enabled).toBe(true);
      expect(stripAnsi(res!.message!)).toMatch(/ENABLED/);
    });

    it('/enhance toggle flips the current state', async () => {
      await buildEnhanceCommand(ctx).run!('toggle');
      expect(controller.setEnabled).toHaveBeenCalledWith(false);
    });

    it('rejects an unknown argument', async () => {
      const res = await buildEnhanceCommand(ctx).run!('maybe');
      expect(stripAnsi(res!.message!)).toMatch(/Unknown argument/);
      expect(controller.setEnabled).not.toHaveBeenCalled();
    });
  });
});
