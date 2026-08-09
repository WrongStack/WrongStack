import { describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildSuggestCommand } from '../src/slash-commands/suggest.js';

const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

function makeContext(result: string): {
  context: SlashCommandContext;
  onSuggestions: ReturnType<typeof vi.fn>;
  getTask: () => string;
} {
  let task = '';
  const onSuggestions = vi.fn((suggestions?: string[]) => suggestions ?? []);
  const context = {
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    renderer: { write: vi.fn(), writeWarning: vi.fn() },
    onSpawnAndWait: vi.fn(async (description: string) => {
      task = description;
      return result;
    }),
    onSuggestions,
  } as never as SlashCommandContext;
  return { context, onSuggestions, getTask: () => task };
}

describe('/suggest prompt contract', () => {
  it('asks for exact agent-directed TUI/WebUI prompt messages', async () => {
    const { context, onSuggestions, getTask } = makeContext(
      '1. Run the focused tests and fix any failures\n2. Review the diff and implement corrections',
    );

    await buildSuggestCommand(context).run!('--fresh');

    expect(getTask()).toContain('submit back to the coding agent through the');
    expect(getTask()).toContain('TUI or WebUI');
    expect(getTask()).toContain('Never output a human-only chore');
    expect(onSuggestions).toHaveBeenCalledWith([
      'Run the focused tests and fix any failures',
      'Review the diff and implement corrections',
    ]);
  });

  it.each(['NONE', 'No pending actions — everything is up to date.'])(
    'does not store no-op status text as a selectable prompt: %s',
    async (result) => {
      const { context, onSuggestions } = makeContext(result);

      const response = await buildSuggestCommand(context).run!('--fresh');

      expect(onSuggestions).toHaveBeenCalledWith([]);
      expect(stripAnsi(response?.message ?? '')).toContain('No suggestions available.');
    },
  );
});
