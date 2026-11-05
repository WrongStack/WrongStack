import { describe, expect, it } from 'vitest';
import type { DesktopCommandContext } from '../src/desktop-command-context';
import { runDesktopCommand } from '../src/desktop-command-runner';
import { desktopCommands, matchDesktopCommands } from '../src/desktop-commands';
import { engineCommands } from '../src/desktop-engine-commands';
import { emptyEngineState } from '../src/engine-state';

const state = {
  ...emptyEngineState,
  connected: true,
  results: {
    'command.catalog': {
      commands: [
        { name: 'sandbox', aliases: [], description: 'Show the sandbox.', destructive: false },
        {
          name: 'prune',
          aliases: ['gc'],
          description: 'Delete old sessions.',
          argsHint: '[days]',
          destructive: true,
        },
        // The desktop owns /help; the engine's is not offered.
        { name: 'help', aliases: [], description: 'Engine help', destructive: false },
        { name: '', description: 'nameless' },
      ],
    },
  },
};

function context() {
  const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const shown: { notice?: string; error?: string } = {};
  let reply: Record<string, unknown> = { message: 'ok' };
  const ctx = {
    state,
    command: async (type: string, payload: Record<string, unknown>) => {
      calls.push({ type, payload });
      return reply;
    },
    notify: (message: string) => {
      shown.notice = message;
    },
    fail: (message: string) => {
      shown.error = message;
    },
  } as unknown as DesktopCommandContext;
  return { ctx, calls, shown, answer: (next: Record<string, unknown>) => (reply = next) };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('engine commands in the composer', () => {
  it('reads the catalog and leaves names the desktop owns to the desktop', () => {
    const offered = engineCommands(state as never, desktopCommands);
    expect(offered.map((command) => command.name)).toEqual(['/sandbox', '/prune']);
    expect(offered[1]).toMatchObject({ aliases: ['/gc'], usage: '[days]', action: 'engine' });
    expect(matchDesktopCommands('/sand', offered).map((command) => command.name)).toEqual([
      '/sandbox',
    ]);
  });

  it('runs an engine command and shows what it printed', async () => {
    const { ctx, calls, shown, answer } = context();
    answer({ message: 'Exec sandbox\n  mode: off' });
    expect(runDesktopCommand('/sandbox --audit', ctx)).toEqual({ kind: 'handled' });
    await settle();
    expect(calls).toEqual([{ type: 'command.run', payload: { name: 'sandbox', args: '--audit' } }]);
    expect(shown.notice).toBe('Exec sandbox\n  mode: off');
    answer({ error: 'broken' });
    runDesktopCommand('/sandbox', ctx);
    await settle();
    expect(shown.error).toBe('broken');
  });

  it('sends the follow-up turn a command asks for', async () => {
    const { ctx, shown, answer } = context();
    const prompts: string[] = [];
    (ctx as { prompt?: (text: string) => void }).prompt = (text) => prompts.push(text);
    answer({ message: 'Tune-up report', runText: '  Plan the fixes.  ' });
    runDesktopCommand('/sandbox', ctx);
    await settle();
    expect(shown.notice).toBe('Tune-up report');
    expect(prompts).toEqual(['Plan the fixes.']);
    // A failed command asks for nothing.
    answer({ error: 'broken', runText: 'never' });
    runDesktopCommand('/sandbox', ctx);
    await settle();
    expect(prompts).toEqual(['Plan the fixes.']);
  });

  it('asks before a destructive command and runs it when the same draft is sent again', async () => {
    const { ctx, calls } = context();
    const first = runDesktopCommand('/gc 14', ctx);
    expect(first).toMatchObject({ kind: 'refused' });
    expect(calls).toEqual([]);
    expect(runDesktopCommand('/gc 14', ctx)).toEqual({ kind: 'handled' });
    await settle();
    expect(calls).toEqual([{ type: 'command.run', payload: { name: 'prune', args: '14' } }]);
    // A dry run deletes nothing and runs at once.
    expect(runDesktopCommand('/prune --dry-run', ctx)).toEqual({ kind: 'handled' });
  });

  it('still refuses a name neither the desktop nor the engine knows', () => {
    const { ctx } = context();
    expect(runDesktopCommand('/nonsense', ctx)).toMatchObject({ kind: 'refused' });
  });
});
