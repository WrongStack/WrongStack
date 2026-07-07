import type { Mode, ModeStore } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildModeCommand } from '../src/slash-commands/mode.js';

const modes: Mode[] = [
  {
    id: 'default',
    name: 'Default',
    description: 'General-purpose coding assistant',
    prompt: '',
    tags: [],
  },
  { id: 'brief', name: 'Brief', description: 'Fast, no-nonsense', prompt: '', tags: [] },
  { id: 'teach', name: 'Teach', description: 'Mentor mode', prompt: '', tags: [] },
];

const makeStore = (active: Mode | null = modes[0] ?? null): ModeStore & {
  setActiveMode: ReturnType<typeof vi.fn>;
} => {
  let current = active;
  return {
    listModes: vi.fn(async () => modes),
    getActiveMode: vi.fn(async () => current),
    setActiveMode: vi.fn(async (id: string | null) => {
      current = modes.find((m) => m.id === id) ?? null;
    }),
    getMode: vi.fn(async (id: string) => modes.find((m) => m.id === id) ?? null),
  };
};

const makeCtx = (modeStore?: ModeStore): SlashCommandContext =>
  ({ modeStore, renderer: { write: vi.fn(), writeWarning: vi.fn() } }) as never;

describe('/mode slash command', () => {
  it('exposes metadata and mode families', () => {
    const cmd = buildModeCommand(makeCtx());
    expect(cmd.name).toBe('mode');
    expect(cmd.help).toContain('/mode <id>');
    expect(cmd.help).toContain('Token-saving');
    expect(cmd.help).toContain('review-lite');
    expect(cmd.help).toContain('Deep/full');
    expect(cmd.help).toContain('code-reviewer');
  });

  it('reports unavailable when modeStore is missing', async () => {
    const cmd = buildModeCommand(makeCtx());
    const out = await cmd.run!('', undefined);
    expect(out!.message).toMatch(/not available/);
  });

  describe('status listing (no arg)', () => {
    it('lists every mode and marks the active one', async () => {
      const store = makeStore(modes[1]);
      const cmd = buildModeCommand(makeCtx(store));
      const out = await cmd.run!('', undefined);
      expect(out!.message).toMatch(/Current mode: Brief/);
      expect(out!.message).toContain('default');
      expect(out!.message).toContain('brief — Fast, no-nonsense [active]');
      expect(out!.message).toContain('teach');
      // Only one mode marked active
      expect((out!.message ?? '').match(/\[active\]/g) ?? []).toHaveLength(1);
    });

    it('shows "none" when no mode is active', async () => {
      const store = makeStore(null);
      const cmd = buildModeCommand(makeCtx(store));
      const out = await cmd.run!('', undefined);
      expect(out!.message).toMatch(/Current mode: none/);
    });

    it('treats whitespace-only args as empty', async () => {
      const store = makeStore();
      const cmd = buildModeCommand(makeCtx(store));
      const out = await cmd.run!('   ', undefined);
      expect(out!.message).toMatch(/Current mode:/);
      expect(store.setActiveMode).not.toHaveBeenCalled();
    });
  });

  describe('switching', () => {
    it('switches to a valid mode and reports its name + description', async () => {
      const store = makeStore();
      const cmd = buildModeCommand(makeCtx(store));
      const out = await cmd.run!('brief', undefined);
      expect(out!.message).toMatch(/Switched to "Brief" mode/);
      expect(out!.message).toContain('Fast, no-nonsense');
      expect(store.setActiveMode).toHaveBeenCalledWith('brief');
    });

    it('matches case-insensitively', async () => {
      const store = makeStore();
      const cmd = buildModeCommand(makeCtx(store));
      const out = await cmd.run!('BRIEF', undefined);
      expect(store.setActiveMode).toHaveBeenCalledWith('brief');
      expect(out!.message).toMatch(/Switched to "Brief"/);
    });

    it('trims whitespace around the argument', async () => {
      const store = makeStore();
      const cmd = buildModeCommand(makeCtx(store));
      await cmd.run!('  teach  ', undefined);
      expect(store.setActiveMode).toHaveBeenCalledWith('teach');
    });

    it('rejects an unknown mode without calling setActiveMode', async () => {
      const store = makeStore();
      const cmd = buildModeCommand(makeCtx(store));
      const out = await cmd.run!('made-up', undefined);
      expect(out!.message).toMatch(/Unknown mode "made-up"/);
      // Lists the available options
      expect(out!.message).toContain('default');
      expect(out!.message).toContain('brief');
      expect(out!.message).toContain('teach');
      expect(store.setActiveMode).not.toHaveBeenCalled();
    });
  });
});
