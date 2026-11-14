import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SlashCommand } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
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

  it('runs /permissions on the asking conversation with the engine’s policy and tools', async () => {
    const sent: Array<{ payload: Record<string, unknown> }> = [];
    const appended: unknown[] = [];
    const conversations: Record<string, { meta: Record<string, unknown>; session: unknown }> = {
      'tab-1': {
        meta: {},
        session: { id: 'tab-1', append: vi.fn(async (event: unknown) => appended.push(event)) },
      },
    };
    const tools = new Map([['read', { name: 'read' }]]);
    const ctx = portableCommandRoute({
      getSessionStore: () => undefined,
      getProjectRoot: () => process.cwd(),
      getContext: (sessionId) => (sessionId ? conversations[sessionId] : undefined),
      getConfigStore: () => undefined,
      getPermissionPolicy: () => ({ listRules: async () => [], explain: undefined }) as never,
      getToolRegistry: () => ({ get: (name: string) => tools.get(name) as never }),
      send: (_ws, message) => sent.push(message as never),
    });
    expect((await ctx.getCommands()).map((command) => command.name)).toContain('permissions');

    const run = (args: string) =>
      handleCommandRoute(ctx, ws, {
        type: 'command.run',
        payload: { name: 'permissions', args, sessionId: 'tab-1' },
      });
    await run('allow read src/*');
    expect(sent.at(-1)?.payload['message']).toMatch(/^Session rule added: allow read src\/\*/);
    expect(conversations['tab-1']?.meta['permissionOverrides']).toEqual([
      { effect: 'allow', tool: 'read', pattern: 'src/*' },
    ]);
    expect(appended).toEqual([expect.objectContaining({ type: 'permission_overrides' })]);

    await run('deny nope');
    expect(sent.at(-1)?.payload['message']).toMatch(/Unknown tool: "nope"/);
    await run('');
    expect(sent.at(-1)?.payload['message']).toContain('1. allow read src/*');
    await run('clear');
    expect(conversations['tab-1']?.meta['permissionOverrides']).toEqual([]);
  });

  it('runs /plugin against the profile config, backs it up and applies the change live', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engine-plugin-'));
    try {
      const configPath = join(root, 'config.json');
      let live = { provider: 'p', model: 'm', plugins: [] as unknown[] } as Record<string, unknown>;
      const backups: string[] = [];
      const patches: unknown[] = [];
      const sent: Array<{ payload: Record<string, unknown> }> = [];
      const ctx = portableCommandRoute({
        getSessionStore: () => undefined,
        getProjectRoot: () => root,
        getContext: () => undefined,
        getConfigStore: () => ({ get: () => live, update: vi.fn() }) as never,
        getProfileConfigPath: () => configPath,
        getPaths: () => ({ globalRoot: root }) as never,
        backupConfig: async (file) => {
          backups.push(file);
        },
        applyConfigPatch: (patch) => {
          patches.push(patch);
          live = { ...live, ...patch };
        },
        send: (_ws, message) => sent.push(message as never),
      });
      const run = (args: string) =>
        handleCommandRoute(ctx, ws, { type: 'command.run', payload: { name: 'plugin', args } });

      await run('add format-on-save');
      expect(sent.at(-1)?.payload['message']).toMatch(/format-on-save/);
      expect(sent.at(-1)?.payload['message']).toContain('Restart WrongStack');
      const written = JSON.parse(await readFile(configPath, 'utf8')) as { plugins: unknown[] };
      expect(written.plugins).toEqual(['format-on-save']);
      expect(backups).toEqual([configPath]);
      expect(patches).toEqual([expect.objectContaining({ plugins: ['format-on-save'] })]);
      expect(live['plugins']).toEqual(['format-on-save']);

      await run('list');
      expect(sent.at(-1)?.payload['message']).toContain('format-on-save');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    expect(names.slice(0, 11)).toEqual([
      'adr',
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

  it('starts workers on the engine’s fleet and lets the host run its own commands', async () => {
    const spawned: Array<{ description: string; options: unknown }> = [];
    const sent: Array<{ payload: Record<string, unknown> }> = [];
    const hosted: SlashCommand = {
      name: 'director',
      description: 'The host’s director',
      run: async () => ({ message: 'host director' }),
    };
    const ctx = portableCommandRoute({
      getSessionStore: () => undefined,
      getProjectRoot: () => process.cwd(),
      getContext: (sessionId) => (sessionId ? { session: { id: sessionId } } : undefined),
      getConfigStore: () => undefined,
      fleet: () => ({
        onSpawn: async (description, options) => {
          spawned.push({ description, options });
          return 'Spawned w1';
        },
      }),
      hostCommands: () => [hosted],
      send: (_ws, message) => sent.push(message as never),
    });
    const commands = await ctx.getCommands();
    expect(commands.filter((command) => command.name === 'director')).toEqual([hosted]);

    // The worker belongs to the tab that asked.
    await handleCommandRoute(ctx, ws, {
      type: 'command.run',
      payload: { name: 'spawn', args: '--name=fixer fix the bug', sessionId: 'tab-2' },
    });
    expect(spawned).toEqual([
      { description: 'fix the bug', options: { name: 'fixer', originSessionId: 'tab-2' } },
    ]);
    expect(sent[0]?.payload['message']).toBe('Spawned w1');

    await handleCommandRoute(ctx, ws, { type: 'command.run', payload: { name: 'director' } });
    expect(sent[1]?.payload['message']).toBe('host director');
    // /delegate without a fleet host says so instead of failing.
    await handleCommandRoute(ctx, ws, {
      type: 'command.run',
      payload: { name: 'delegate', args: '--role=debugger find the leak' },
    });
    expect(sent[2]?.payload['message']).toContain('No fleet active');
  });
});
