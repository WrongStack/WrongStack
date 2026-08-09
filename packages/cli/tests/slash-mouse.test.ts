import { describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildMouseCommand } from '../src/slash-commands/mouse.js';

const makeCtx = (overrides: Partial<SlashCommandContext> = {}): SlashCommandContext => {
  const write = vi.fn();
  const writeWarning = vi.fn();
  return {
    renderer: { write, writeWarning } as never,
    ...overrides,
  } as never as SlashCommandContext;
};

describe('/mouse slash command', () => {
  describe('metadata', () => {
    it('reports name, description and help text', () => {
      const cmd = buildMouseCommand(makeCtx());
      expect(cmd.name).toBe('mouse');
      expect(cmd.description).toMatch(/mouse mode/i);
      expect(cmd.help).toContain('/mouse on');
      expect(cmd.help).toContain('/mouse off');
      expect(cmd.help).toContain('/mouse toggle');
    });
  });

  // The command is stateless: it emits a `mouseToggle` intent via metadata that
  // the TUI App resolves against its own live state. So we assert on the intent.
  describe('intent emission', () => {
    it.each([
      ['', 'query'],
      ['status', 'query'],
    ])('"%s" emits the query intent', async (arg, intent) => {
      const cmd = buildMouseCommand(makeCtx());
      const result = await cmd.run!(arg);
      expect(result?.metadata?.mouseToggle).toBe(intent);
      // Query must not print its own message (the App prints the status).
      expect(result?.message).toBeUndefined();
    });

    it.each(['on', 'enable', 'true', '1', 'ON', '  on  '])(
      '"%s" emits the on intent',
      async (arg) => {
        const cmd = buildMouseCommand(makeCtx());
        const result = await cmd.run!(arg);
        expect(result?.metadata?.mouseToggle).toBe('on');
      },
    );

    it.each(['off', 'disable', 'false', '0', 'OFF'])('"%s" emits the off intent', async (arg) => {
      const cmd = buildMouseCommand(makeCtx());
      const result = await cmd.run!(arg);
      expect(result?.metadata?.mouseToggle).toBe('off');
    });

    it('"toggle" emits the toggle intent', async () => {
      const cmd = buildMouseCommand(makeCtx());
      const result = await cmd.run!('toggle');
      expect(result?.metadata?.mouseToggle).toBe('toggle');
    });

    it('rejects an unknown argument with a message and no intent', async () => {
      const cmd = buildMouseCommand(makeCtx());
      const result = await cmd.run!('maybe');
      expect(result?.message).toMatch(/Unknown argument/);
      expect(result?.metadata?.mouseToggle).toBeUndefined();
    });
  });
});
