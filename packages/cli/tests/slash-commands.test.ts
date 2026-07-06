import {
  type Context,
  SlashCommandRegistry,
  ToolRegistry,
  type Message,
  type TodoItem,
  type MemoryStore,
} from '@wrongstack/core';
import { HybridCompactor } from '@wrongstack/core/execution';
import { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { describe, expect, it, vi } from 'vitest';
import {
  type SlashCommandContext,
  buildBuiltinSlashCommands,
} from '../src/slash-commands/index.js';

class FakeRenderer {
  output = '';
  warnings: string[] = [];
  errors: string[] = [];
  infos: string[] = [];
  write(s: unknown): void {
    this.output += typeof s === 'string' ? s : ((s as { text?: string }).text ?? '');
  }
  writeLine(s = ''): void {
    this.output += `${s}\n`;
  }
  writeBlock(): void {}
  writeToolCall(): void {}
  writeToolResult(): void {}
  writeDiff(): void {}
  writeWarning(s: string): void {
    this.warnings.push(s);
  }
  writeError(s: string): void {
    this.errors.push(s);
  }
  writeInfo(s: string): void {
    this.infos.push(s);
  }
  clear(): void {
    this.output = '';
  }
}

function makeRig() {
  const registry = new SlashCommandRegistry();
  const toolRegistry = new ToolRegistry();
  const renderer = new FakeRenderer();
  const tokenCounter = new DefaultTokenCounter();
  const compactor = new HybridCompactor({ preserveK: 5 });
  const cmds = buildBuiltinSlashCommands({
    registry,
    toolRegistry,
    compactor,
    tokenCounter,
    renderer: renderer as never as Parameters<typeof buildBuiltinSlashCommands>[0]['renderer'],
  } as never as SlashCommandContext);
  for (const c of cmds) registry.register(c);
  return { registry, renderer, toolRegistry, tokenCounter };
}

const fakeCtx = {
  messages: [] as Message[],
  todos: [] as TodoItem[],
  systemPrompt: [],
  readFiles: new Set(),
  fileMtimes: new Map(),
  model: 'test-model',
  cwd: '/tmp',
  projectRoot: '/proj',
} as never as Context;

describe('built-in slash commands', () => {
  it('/help lists all commands', async () => {
    const { registry } = makeRig();
    const result = await registry.dispatch('/help', fakeCtx);
    expect(result?.message).toContain('/help');
    expect(result?.message).toContain('/exit');
    expect(result?.message).toContain('/help <name>');
  });

  it('/help <name> renders detailed help when defined', async () => {
    const { registry } = makeRig();
    const result = await registry.dispatch('/help help', fakeCtx);
    expect(result?.message).toContain('/help');
    expect(result?.message).toContain('Usage:');
    expect(result?.message).toContain('Examples:');
  });

  it('/help <name> falls back to description for commands without help', async () => {
    const { registry } = makeRig();
    const result = await registry.dispatch('/help exit', fakeCtx);
    expect(result?.message).toContain('/exit');
    // Description should be present somewhere in the body.
    expect(result?.message?.length ?? 0).toBeGreaterThan(8);
  });

  it('/help <name> resolves aliases', async () => {
    const { registry } = makeRig();
    const result = await registry.dispatch('/help ctx', fakeCtx);
    expect(result?.message).toContain('/context');
    expect(result?.message?.toLowerCase()).toContain('context');
  });

  it('/help <unknown> tells the user the command is unknown', async () => {
    const { registry } = makeRig();
    const result = await registry.dispatch('/help no-such-command', fakeCtx);
    expect(result?.message).toMatch(/Unknown command/);
  });

  it('/tools lists registered tools', async () => {
    const { registry, renderer, toolRegistry } = makeRig();
    toolRegistry.register({
      name: 'echo',
      description: 'echo',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    });
    await registry.dispatch('/tools', fakeCtx);
    expect(renderer.output).toContain('echo');
    expect(renderer.output).toContain('description detail');
    expect(renderer.output).toContain('desc:extend');
  });

  it('/exit signals exit', async () => {
    const { registry } = makeRig();
    const res = await registry.dispatch('/exit', fakeCtx);
    expect(res?.exit).toBe(true);
  });

  it('/quit aliases /exit', async () => {
    const { registry } = makeRig();
    const res = await registry.dispatch('/quit', fakeCtx);
    expect(res?.exit).toBe(true);
  });

  it('/clear triggers onClear and clears renderer and context', async () => {
    const onClear = vi.fn();
    const registry = new SlashCommandRegistry();
    const renderer = new FakeRenderer();
    renderer.output = 'something';
    const messages: Message[] = [{ role: 'user' as const, content: 'old message' }];
    const todos: TodoItem[] = [{ id: '1', content: 'old todo', status: 'pending' as const }];
    const meta: Record<string, unknown> = { old: 'meta' };
    const ctx = {
      messages,
      todos,
      readFiles: new Set(['old.txt']),
      fileMtimes: new Map([['old.txt', 123]]),
      meta,
    } as never as Context;
    (
      ctx as never as {
        state: Pick<Context['state'], 'replaceMessages' | 'replaceTodos' | 'deleteMeta'>;
      }
    ).state = {
      replaceMessages(next: Message[]) {
        messages.length = 0;
        messages.splice(0, 0, ...next);
      },
      replaceTodos(next: TodoItem[]) {
        todos.length = 0;
        todos.splice(0, 0, ...next);
      },
      deleteMeta(key: string) {
        delete meta[key];
      },
    };
    const cmds = buildBuiltinSlashCommands({
      registry,
      toolRegistry: new ToolRegistry(),
      compactor: new HybridCompactor(),
      tokenCounter: new DefaultTokenCounter(),
      renderer: renderer as never as Parameters<typeof buildBuiltinSlashCommands>[0]['renderer'],
      onClear,
      memoryStore: {
        async clear() {},
      } as never as MemoryStore,
    } as never as SlashCommandContext);
    for (const c of cmds) registry.register(c);
    await registry.dispatch('/clear', ctx);
    expect(onClear).toHaveBeenCalled();
    expect(ctx.messages).toEqual([]);
    expect(ctx.todos).toEqual([]);
    expect(ctx.readFiles.size).toBe(0);
    expect(ctx.fileMtimes.size).toBe(0);
    expect(ctx.meta).toEqual({});
    expect(renderer.output).toBe('');
  });

  it('/compact runs the compactor', async () => {
    const { registry, renderer } = makeRig();
    const ctx = { messages: [] } as never as Context;
    await registry.dispatch('/compact', ctx);
    expect(renderer.infos.some((i) => i.toLowerCase().includes('compact') || i.toLowerCase().includes('optimal'))).toBe(true);
  });

  it('/context shows context window summary', async () => {
    const { registry, renderer } = makeRig();
    const ctx = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        { role: 'user', content: [{ type: 'text', text: 'world' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: '1', name: 'bash', input: {} },
            { type: 'text', text: 'done' },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'ok' }] },
      ],
      todos: [
        { id: '1', content: 'fix bug', status: 'in_progress' },
        { id: '2', content: 'write test', status: 'pending' },
        { id: '3', content: 'done', status: 'completed' },
      ],
      systemPrompt: [{ type: 'text', text: 'You are helpful' }],
      readFiles: new Set(['a.ts', 'b.ts']),
      fileMtimes: new Map(),
      model: 'anthropic-test-model',
      cwd: '/tmp',
      projectRoot: '/proj',
      meta: {},
    } as never as Context;
    await registry.dispatch('/context', ctx);
    expect(renderer.output).toContain('Context Window');
    expect(renderer.output).toContain('messages:');
    expect(renderer.output).toContain('in_progress');
    expect(renderer.output).toContain('pending');
  });

  it('/ctx aliases /context', async () => {
    const { registry, renderer } = makeRig();
    const ctx = {
      messages: [],
      todos: [],
      systemPrompt: [],
      readFiles: new Set(),
      fileMtimes: new Map(),
      meta: {},
    } as never as Context;
    await registry.dispatch('/ctx', ctx);
    expect(renderer.output).toContain('Context Window');
  });

  it('/context detail shows extra fields', async () => {
    const { registry, renderer } = makeRig();
    const ctx = {
      messages: [],
      todos: [],
      systemPrompt: [],
      readFiles: new Set(),
      fileMtimes: new Map(),
      model: 'anthropic-test-model',
      cwd: '/tmp',
      projectRoot: '/proj',
      meta: {},
    } as never as Context;
    await registry.dispatch('/context detail', ctx);
    expect(renderer.output).toContain('model:');
    expect(renderer.output).toContain('cwd:');
  });

  it('/context repair fixes orphan tool_use/tool_result blocks', async () => {
    const { registry, renderer } = makeRig();
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'u1', name: 'read', input: {} }],
      },
      { role: 'assistant', content: 'still here' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'late' }] },
    ];
    const ctx = {
      messages,
      todos: [],
      systemPrompt: [],
      readFiles: new Set(),
      fileMtimes: new Map(),
      meta: {},
      state: {
        replaceMessages(next: typeof messages) {
          messages.length = 0;
          messages.push(...next);
        },
      },
    } as never as Context;

    await registry.dispatch('/context repair', ctx);

    expect(renderer.output).toContain('Context repaired');
    expect(JSON.stringify(ctx.messages)).not.toContain('"tool_use"');
    expect(JSON.stringify(ctx.messages)).not.toContain('"tool_result"');
    expect(ctx.messages).toHaveLength(1);
  });

  describe('L1-E /spawn and /agents', () => {
    it('/spawn without onSpawn reports multi-agent not enabled', async () => {
      const { registry } = makeRig();
      const r = await registry.dispatch('/spawn write the docs', fakeCtx);
      expect(r?.message).toContain('not enabled');
    });

    it('/spawn requires a task description', async () => {
      const registry = new SlashCommandRegistry();
      const toolRegistry = new ToolRegistry();
      const renderer = new FakeRenderer();
      const tokenCounter = new DefaultTokenCounter();
      const compactor = new HybridCompactor({ preserveK: 5 });
      const cmds = buildBuiltinSlashCommands({
        registry,
        toolRegistry,
        compactor,
        tokenCounter,
        renderer: renderer as never as Parameters<
          typeof buildBuiltinSlashCommands
        >[0]['renderer'],
        onSpawn: async () => 'should not be called',
        onAgents: () => '',
      } as never as SlashCommandContext);
      for (const c of cmds) registry.register(c);
      const r = await registry.dispatch('/spawn   ', fakeCtx);
      expect(r?.message).toMatch(/Usage:/);
    });

    it('/spawn forwards description and returns summary', async () => {
      const registry = new SlashCommandRegistry();
      const toolRegistry = new ToolRegistry();
      const renderer = new FakeRenderer();
      const tokenCounter = new DefaultTokenCounter();
      const compactor = new HybridCompactor({ preserveK: 5 });
      const onSpawn = vi.fn(async (desc: string) => `spawned: ${desc}`);
      const cmds = buildBuiltinSlashCommands({
        registry,
        toolRegistry,
        compactor,
        tokenCounter,
        renderer: renderer as never as Parameters<
          typeof buildBuiltinSlashCommands
        >[0]['renderer'],
        onSpawn,
        onAgents: () => '',
      } as never as SlashCommandContext);
      for (const c of cmds) registry.register(c);
      await registry.dispatch(
        '/spawn --provider=openai --model=gpt-5 audit the auth flow',
        fakeCtx,
      );
      expect(onSpawn).toHaveBeenCalledWith('audit the auth flow', {
        provider: 'openai',
        model: 'gpt-5',
      });
    });

    it('/spawn short flags (-p, -m, -n) work the same as long form', async () => {
      const registry = new SlashCommandRegistry();
      const toolRegistry = new ToolRegistry();
      const renderer = new FakeRenderer();
      const tokenCounter = new DefaultTokenCounter();
      const compactor = new HybridCompactor({ preserveK: 5 });
      const onSpawn = vi.fn(async (desc: string) => `spawned: ${desc}`);
      const cmds = buildBuiltinSlashCommands({
        registry,
        toolRegistry,
        compactor,
        tokenCounter,
        renderer: renderer as never as Parameters<
          typeof buildBuiltinSlashCommands
        >[0]['renderer'],
        onSpawn,
        onAgents: () => '',
      } as never as SlashCommandContext);
      for (const c of cmds) registry.register(c);
      await registry.dispatch(
        '/spawn -p anthropic -m haiku -n researcher enumerate every package',
        fakeCtx,
      );
      expect(onSpawn).toHaveBeenCalledWith('enumerate every package', {
        provider: 'anthropic',
        model: 'haiku',
        name: 'researcher',
      });
    });

    it('/spawn --tools=a,b,c parses the tool slice as an array', async () => {
      const registry = new SlashCommandRegistry();
      const toolRegistry = new ToolRegistry();
      const renderer = new FakeRenderer();
      const tokenCounter = new DefaultTokenCounter();
      const compactor = new HybridCompactor({ preserveK: 5 });
      const onSpawn = vi.fn(async () => 'spawned');
      const cmds = buildBuiltinSlashCommands({
        registry,
        toolRegistry,
        compactor,
        tokenCounter,
        renderer: renderer as never as Parameters<
          typeof buildBuiltinSlashCommands
        >[0]['renderer'],
        onSpawn,
        onAgents: () => '',
      } as never as SlashCommandContext);
      for (const c of cmds) registry.register(c);
      await registry.dispatch('/spawn --tools=read,grep,bash investigate the bug', fakeCtx);
      expect(onSpawn).toHaveBeenCalledWith('investigate the bug', {
        tools: ['read', 'grep', 'bash'],
      });
    });

    it('/spawn --name="Cool Name" handles quoted multi-word name', async () => {
      const registry = new SlashCommandRegistry();
      const toolRegistry = new ToolRegistry();
      const renderer = new FakeRenderer();
      const tokenCounter = new DefaultTokenCounter();
      const compactor = new HybridCompactor({ preserveK: 5 });
      const onSpawn = vi.fn(async () => 'spawned');
      const cmds = buildBuiltinSlashCommands({
        registry,
        toolRegistry,
        compactor,
        tokenCounter,
        renderer: renderer as never as Parameters<
          typeof buildBuiltinSlashCommands
        >[0]['renderer'],
        onSpawn,
        onAgents: () => '',
      } as never as SlashCommandContext);
      for (const c of cmds) registry.register(c);
      await registry.dispatch('/spawn --name="Security Reviewer" audit OWASP', fakeCtx);
      expect(onSpawn).toHaveBeenCalledWith('audit OWASP', {
        name: 'Security Reviewer',
      });
    });

    it('/spawn with no flags preserves legacy single-arg signature', async () => {
      // Regression guard for the call-site arity change: callers that
      // overload by `arguments.length` (or test assertions that use
      // `toHaveBeenCalledWith(desc)` without a 2nd arg) must keep
      // working when no flags are passed.
      const registry = new SlashCommandRegistry();
      const toolRegistry = new ToolRegistry();
      const renderer = new FakeRenderer();
      const tokenCounter = new DefaultTokenCounter();
      const compactor = new HybridCompactor({ preserveK: 5 });
      const onSpawn = vi.fn(async (desc: string) => `spawned: ${desc}`);
      const cmds = buildBuiltinSlashCommands({
        registry,
        toolRegistry,
        compactor,
        tokenCounter,
        renderer: renderer as never as Parameters<
          typeof buildBuiltinSlashCommands
        >[0]['renderer'],
        onSpawn,
        onAgents: () => '',
      } as never as SlashCommandContext);
      for (const c of cmds) registry.register(c);
      await registry.dispatch('/spawn no flags here', fakeCtx);
      // Strict single-arg call — the slash command must NOT pass undefined.
      expect(onSpawn).toHaveBeenCalledWith('no flags here');
    });

    it('/agents returns whatever onAgents produces', async () => {
      const registry = new SlashCommandRegistry();
      const toolRegistry = new ToolRegistry();
      const renderer = new FakeRenderer();
      const tokenCounter = new DefaultTokenCounter();
      const compactor = new HybridCompactor({ preserveK: 5 });
      const cmds = buildBuiltinSlashCommands({
        registry,
        toolRegistry,
        compactor,
        tokenCounter,
        renderer: renderer as never as Parameters<
          typeof buildBuiltinSlashCommands
        >[0]['renderer'],
        onSpawn: async () => '',
        onAgents: () => '2 pending, 1 completed.\n  ✓        abc12345',
      } as never as SlashCommandContext);
      for (const c of cmds) registry.register(c);
      const r = await registry.dispatch('/agents', fakeCtx);
      expect(r?.message).toContain('2 pending');
    });

    it('/spawn surfaces errors thrown by the host', async () => {
      const registry = new SlashCommandRegistry();
      const toolRegistry = new ToolRegistry();
      const renderer = new FakeRenderer();
      const tokenCounter = new DefaultTokenCounter();
      const compactor = new HybridCompactor({ preserveK: 5 });
      const cmds = buildBuiltinSlashCommands({
        registry,
        toolRegistry,
        compactor,
        tokenCounter,
        renderer: renderer as never as Parameters<
          typeof buildBuiltinSlashCommands
        >[0]['renderer'],
        onSpawn: async () => {
          throw new Error('no provider configured');
        },
        onAgents: () => '',
      } as never as SlashCommandContext);
      for (const c of cmds) registry.register(c);
      const r = await registry.dispatch('/spawn do a thing', fakeCtx);
      expect(r?.message).toMatch(/Spawn failed/);
      expect(r?.message).toContain('no provider configured');
    });
  });

  describe('/fleet hub command', () => {
    function makeFleetRig(onFleet?: SlashCommandContext['onFleet']) {
      const registry = new SlashCommandRegistry();
      const toolRegistry = new ToolRegistry();
      const renderer = new FakeRenderer();
      const tokenCounter = new DefaultTokenCounter();
      const compactor = new HybridCompactor({ preserveK: 5 });
      const cmds = buildBuiltinSlashCommands({
        registry,
        toolRegistry,
        compactor,
        tokenCounter,
        renderer: renderer as never as Parameters<
          typeof buildBuiltinSlashCommands
        >[0]['renderer'],
        onFleet,
      } as never as SlashCommandContext);
      for (const c of cmds) registry.register(c);
      return { registry };
    }

    it('/fleet without onFleet reports multi-agent not enabled', async () => {
      const { registry } = makeFleetRig(undefined);
      const r = await registry.dispatch('/fleet', fakeCtx);
      expect(r?.message).toContain('No fleet active');
    });

    it('/fleet defaults to status when no subcommand given', async () => {
      const onFleet = vi.fn(async (action: string) => `[${action} called]`);
      const { registry } = makeFleetRig(onFleet);
      const r = await registry.dispatch('/fleet', fakeCtx);
      expect(onFleet).toHaveBeenCalledWith('status', undefined);
      expect(r?.message).toBe('[status called]');
    });

    it('/fleet status / usage / manifest dispatch without a target', async () => {
      const onFleet = vi.fn(async (action: string) => `${action}-ok`);
      const { registry } = makeFleetRig(onFleet);
      await registry.dispatch('/fleet status', fakeCtx);
      await registry.dispatch('/fleet usage', fakeCtx);
      await registry.dispatch('/fleet manifest', fakeCtx);
      expect(onFleet).toHaveBeenNthCalledWith(1, 'status', undefined);
      expect(onFleet).toHaveBeenNthCalledWith(2, 'usage', undefined);
      expect(onFleet).toHaveBeenNthCalledWith(3, 'manifest', undefined);
    });

    it('/fleet kill <id> forwards the target subagent id', async () => {
      const onFleet = vi.fn(async () => 'stopped');
      const { registry } = makeFleetRig(onFleet);
      const r = await registry.dispatch('/fleet kill sub_abc123', fakeCtx);
      expect(onFleet).toHaveBeenCalledWith('kill', 'sub_abc123');
      expect(r?.message).toBe('stopped');
    });

    it('/fleet kill without id calls onFleetKill', async () => {
      const onFleetKill = vi.fn(() => 2);
      // Build fleet command directly with onFleetKill instead of via makeFleetRig
      const registry = new SlashCommandRegistry();
      const toolRegistry = new ToolRegistry();
      const renderer = new FakeRenderer();
      const tokenCounter = new DefaultTokenCounter();
      const compactor = new HybridCompactor({ preserveK: 5 });
      const cmds = buildBuiltinSlashCommands({
        registry,
        toolRegistry,
        compactor,
        tokenCounter,
        renderer: renderer as never as Parameters<typeof buildBuiltinSlashCommands>[0]['renderer'],
        onFleetKill,
      } as never as SlashCommandContext);
      for (const c of cmds) registry.register(c);
      const r = await registry.dispatch('/fleet kill', fakeCtx);
      expect(onFleetKill).toHaveBeenCalledTimes(1);
      expect(r?.message).toMatch(/Killed 2 subagent/);
    });

    it('/fleet help returns inline usage block', async () => {
      const onFleet = vi.fn(async () => 'should not be called');
      const { registry } = makeFleetRig(onFleet);
      const r = await registry.dispatch('/fleet help', fakeCtx);
      expect(r?.message).toContain('/fleet status');
      expect(r?.message).toContain('/fleet kill');
      expect(onFleet).not.toHaveBeenCalled();
    });

    it('/fleet <unknown> shows a hint listing valid subcommands', async () => {
      const onFleet = vi.fn(async () => 'should not be called');
      const { registry } = makeFleetRig(onFleet);
      const r = await registry.dispatch('/fleet nope', fakeCtx);
      expect(r?.message).toContain('Unknown subcommand "nope"');
      expect(r?.message).toContain('status');
      expect(onFleet).not.toHaveBeenCalled();
    });
  });

  describe('/plugin command', () => {
    function makePluginRig(onPlugin?: SlashCommandContext['onPlugin']) {
      const registry = new SlashCommandRegistry();
      const toolRegistry = new ToolRegistry();
      const renderer = new FakeRenderer();
      const tokenCounter = new DefaultTokenCounter();
      const compactor = new HybridCompactor({ preserveK: 5 });
      const cmds = buildBuiltinSlashCommands({
        registry,
        toolRegistry,
        compactor,
        tokenCounter,
        renderer: renderer as never as Parameters<
          typeof buildBuiltinSlashCommands
        >[0]['renderer'],
        onPlugin,
      } as never as SlashCommandContext);
      for (const c of cmds) registry.register(c);
      return { registry };
    }

    it('/plugin without handler reports unavailable', async () => {
      const { registry } = makePluginRig(undefined);
      const r = await registry.dispatch('/plugin', fakeCtx);
      expect(r?.message).toContain('not available');
    });

    it('/plugin forwards arguments to plugin manager', async () => {
      const onPlugin = vi.fn(async () => 'installed');
      const { registry } = makePluginRig(onPlugin);
      const r = await registry.dispatch('/plugin install telegram', fakeCtx);
      expect(onPlugin).toHaveBeenCalledWith('install telegram');
      expect(r?.message).toBe('installed');
    });

    it('/plugins alias forwards arguments too', async () => {
      const onPlugin = vi.fn(async () => 'disabled');
      const { registry } = makePluginRig(onPlugin);
      const r = await registry.dispatch('/plugins disable lsp', fakeCtx);
      expect(onPlugin).toHaveBeenCalledWith('disable lsp');
      expect(r?.message).toBe('disabled');
    });

    it('/help plugin shows usage instructions', async () => {
      const { registry } = makePluginRig(async () => 'ok');
      const r = await registry.dispatch('/help plugin', fakeCtx);
      expect(r?.message).toContain('/plugin');
      expect(r?.message).toContain('/plugin official');
      expect(r?.message).toContain('/plugin install');
    });
  });

  describe('/director runtime promotion', () => {
    function makeDirectorRig(onDirector?: SlashCommandContext['onDirector']) {
      const registry = new SlashCommandRegistry();
      const toolRegistry = new ToolRegistry();
      const renderer = new FakeRenderer();
      const tokenCounter = new DefaultTokenCounter();
      const compactor = new HybridCompactor({ preserveK: 5 });
      const cmds = buildBuiltinSlashCommands({
        registry,
        toolRegistry,
        compactor,
        tokenCounter,
        renderer: renderer as never as Parameters<
          typeof buildBuiltinSlashCommands
        >[0]['renderer'],
        onDirector,
      } as never as SlashCommandContext);
      for (const c of cmds) registry.register(c);
      return { registry };
    }

    it('/director without onDirector reports not available', async () => {
      const { registry } = makeDirectorRig(undefined);
      const r = await registry.dispatch('/director', fakeCtx);
      expect(r?.message).toContain('not available');
    });

    it('/director when promotion fails (returns null) shows block message', async () => {
      const { registry } = makeDirectorRig(async () => null);
      const r = await registry.dispatch('/director', fakeCtx);
      expect(r?.message).toContain('Cannot promote');
      expect(r?.message).toContain('subagents have already been spawned');
      expect(r?.message).toContain('--director');
    });

    it('/director when promotion succeeds returns the success message', async () => {
      const { registry } = makeDirectorRig(
        async () => '✓ Promoted.\n  Roster: bug-hunter, security-scanner',
      );
      const r = await registry.dispatch('/director', fakeCtx);
      expect(r?.message).toContain('✓ Promoted');
      expect(r?.message).toContain('bug-hunter');
    });

    it('/director appears in /help listing', async () => {
      const { registry } = makeDirectorRig(async () => 'ok');
      const r = await registry.dispatch('/help', fakeCtx);
      expect(r?.message).toContain('/director');
      expect(r?.message).toContain('Promote this session');
    });

    it('/help director shows usage instructions', async () => {
      const { registry } = makeDirectorRig(async () => 'ok');
      const r = await registry.dispatch('/help director', fakeCtx);
      expect(r?.message).toContain('/director');
      expect(r?.message).toContain('fleet status, spawn');
    });
  });

});
