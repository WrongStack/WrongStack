import type { SlashCommand } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { type CommandRouteContext, handleCommandRoute } from '../src/server/command-routes.js';
import { portableCommandRoute } from '../src/server/portable-command-route.js';

const ws = {} as WebSocket;

function route(commands: SlashCommand[]) {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ctx: CommandRouteContext = {
    getCommands: () => commands,
    send: (_ws, message) => sent.push(message as never),
  };
  return { ctx, sent };
}

const echo: SlashCommand = {
  name: 'echo',
  aliases: ['say'],
  description: 'Echo',
  argsHint: '<text>',
  async run(args) {
    return { message: `\u001b[32m${args}\u001b[0m` };
  },
};

describe('command bridge', () => {
  it('lists the commands with what a client needs to offer and confirm them', async () => {
    const prune: SlashCommand = { name: 'prune', description: 'Delete', run: async () => ({}) };
    const { ctx, sent } = route([echo, prune]);
    expect(
      await handleCommandRoute(ctx, ws, { type: 'command.list', payload: { requestId: 'r1' } }),
    ).toBe(true);
    expect(sent[0]).toEqual({
      type: 'command.catalog',
      payload: {
        requestId: 'r1',
        commands: [
          {
            name: 'echo',
            aliases: ['say'],
            description: 'Echo',
            category: 'App',
            argsHint: '<text>',
            destructive: false,
          },
          { name: 'prune', aliases: [], description: 'Delete', category: 'App', destructive: true },
        ],
      },
    });
  });

  it('runs a command by name or alias and drops terminal colours', async () => {
    const { ctx, sent } = route([echo]);
    await handleCommandRoute(ctx, ws, {
      type: 'command.run',
      payload: { requestId: 'r2', name: '/say', args: '  hello ' },
    });
    expect(sent[0]).toEqual({
      type: 'command.result',
      payload: { requestId: 'r2', name: 'echo', message: 'hello' },
    });
  });

  it('answers unknown and failing commands with an error', async () => {
    const boom: SlashCommand = {
      name: 'boom',
      description: 'Fails',
      run: async () => {
        throw new Error('broken');
      },
    };
    const { ctx, sent } = route([boom]);
    await handleCommandRoute(ctx, ws, { type: 'command.run', payload: { name: 'nope' } });
    await handleCommandRoute(ctx, ws, { type: 'command.run', payload: { name: 'boom' } });
    expect(sent.map((message) => message.payload['error'])).toEqual([
      '/nope is not a command this engine runs.',
      'broken',
    ]);
    expect(await handleCommandRoute(ctx, ws, { type: 'stats.get' })).toBe(false);
  });

  it('serves the portable commands with the engine’s current session store', async () => {
    let store: { list: () => Promise<unknown[]>; prune: () => Promise<number> } | undefined;
    const sent: Array<{ payload: Record<string, unknown> }> = [];
    const ctx = portableCommandRoute({
      getSessionStore: () => store as never,
      getProjectRoot: () => process.cwd(),
      getContext: () => undefined,
      getConfigStore: () => undefined,
      send: (_ws, message) => sent.push(message as never),
    });
    const names = (await ctx.getCommands()).map((command) => command.name);
    expect(names.slice(0, 10)).toEqual([
      'sandbox',
      'prune',
      'scout-stats',
      'init',
      'git',
      'commit',
      'gitcheck',
      'push',
      'gitid',
      'security',
    ]);
    // The builtin plugins' commands follow, without starting the plugins' tools or timers.
    expect(names).toEqual(
      expect.arrayContaining(['skill-search', 'skill-import', 'prompt-gen', 'perf']),
    );
    expect(names).not.toContain('cloudsync');
    await handleCommandRoute(ctx, ws, { type: 'command.run', payload: { name: 'prune' } });
    expect(sent[0]?.payload['message']).toBe('No session store configured.');
    store = { list: async () => [], prune: async () => 3 };
    await handleCommandRoute(ctx, ws, { type: 'command.run', payload: { name: 'prune' } });
    expect(sent[1]?.payload['message']).toBe('Pruned 3 sessions older than 30 days.');
  });
});
