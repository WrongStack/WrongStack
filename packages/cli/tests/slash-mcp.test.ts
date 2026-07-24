import type { Context } from '@wrongstack/core/agent';
import { SlashCommandRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { HybridCompactor } from '@wrongstack/core/execution';
import { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { describe, expect, it, vi } from 'vitest';
import { buildBuiltinSlashCommands } from '../src/slash-commands/index.js';
import { parseMcpArgs } from '../src/slash-commands/mcp-utils.js';
import type { McpParsedArgs } from '../src/slash-commands/mcp-utils.js';

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

const fakeCtx = {
  messages: [],
  todos: [],
  systemPrompt: [],
  readFiles: new Set<string>(),
  fileMtimes: new Map<string, number>(),
  model: 'test-model',
  cwd: '/tmp',
  projectRoot: '/proj',
} as never as Context;

function makeRig(onMcp?: (args: string) => Promise<string>) {
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
    onMcp,
  });
  for (const c of cmds) registry.register(c);
  return { registry, renderer };
}

describe('parseMcpArgs', () => {
  function check(input: string, expected: McpParsedArgs | null): void {
    expect(parseMcpArgs(input)).toEqual(expected);
  }

  it('empty string → list', () => check('', { action: 'list', name: '' }));
  it('whitespace only → list', () => check('  ', { action: 'list', name: '' }));
  it('"list" → list', () => check('list', { action: 'list', name: '' }));

  it('"add filesystem" → add', () =>
    check('add filesystem', { action: 'add', name: 'filesystem', enable: false }));

  it('"add github --enable" sets enable flag', () =>
    check('add github --enable', { action: 'add', name: 'github', enable: true }));

  it('"add slack -e" short flag', () =>
    check('add slack -e', { action: 'add', name: 'slack', enable: true }));

  it('"add zai-vision" with hyphenated name', () =>
    check('add zai-vision', { action: 'add', name: 'zai-vision', enable: false }));

  it('"remove filesystem" → remove', () =>
    check('remove filesystem', { action: 'remove', name: 'filesystem' }));

  it('"enable github" → enable', () =>
    check('enable github', { action: 'enable', name: 'github' }));

  it('"disable minimax-vision" → disable', () =>
    check('disable minimax-vision', { action: 'disable', name: 'minimax-vision' }));

  it('"restart filesystem" → restart', () =>
    check('restart filesystem', { action: 'restart', name: 'filesystem' }));

  it('unknown subcommand → null', () => check('frobnicate', null));

  it('add without name → null', () => check('add', null));

  it('enable without name → null', () => check('enable', null));

  it('"add" with trailing spaces', () =>
    check('add filesystem   ', { action: 'add', name: 'filesystem', enable: false }));

  it('"add" with extra whitespace between args', () =>
    check('add   github   --enable', { action: 'add', name: 'github', enable: true }));

  it('flags can appear before name', () =>
    check('--enable add filesystem', null));
});

describe('/mcp slash command', () => {
  it('/mcp without onMcp reports unavailable', async () => {
    const { registry } = makeRig(undefined);
    const r = await registry.dispatch('/mcp', fakeCtx);
    expect(r?.message).toContain('not available');
  });

  it('/mcp forwards raw args string to onMcp', async () => {
    const onMcp = vi.fn(async () => 'ok');
    const { registry } = makeRig(onMcp);
    await registry.dispatch('/mcp add filesystem --enable', fakeCtx);
    expect(onMcp).toHaveBeenCalledWith('add filesystem --enable');
  });

  it('/mcp list calls onMcp with "list"', async () => {
    const onMcp = vi.fn(async () => 'server list output');
    const { registry } = makeRig(onMcp);
    const r = await registry.dispatch('/mcp list', fakeCtx);
    expect(onMcp).toHaveBeenCalledWith('list');
    expect(r?.message).toBe('server list output');
  });

  it('/mcp remove github forwards "remove github"', async () => {
    const onMcp = vi.fn(async () => 'removed');
    const { registry } = makeRig(onMcp);
    const r = await registry.dispatch('/mcp remove github', fakeCtx);
    expect(onMcp).toHaveBeenCalledWith('remove github');
    expect(r?.message).toBe('removed');
  });

  it('/mcp enable brave-search forwards "enable brave-search"', async () => {
    const onMcp = vi.fn(async () => 'enabled');
    const { registry } = makeRig(onMcp);
    const r = await registry.dispatch('/mcp enable brave-search', fakeCtx);
    expect(onMcp).toHaveBeenCalledWith('enable brave-search');
    expect(r?.message).toBe('enabled');
  });

  it('/mcp disable minimax-vision forwards "disable minimax-vision"', async () => {
    const onMcp = vi.fn(async () => 'disabled');
    const { registry } = makeRig(onMcp);
    const r = await registry.dispatch('/mcp disable minimax-vision', fakeCtx);
    expect(onMcp).toHaveBeenCalledWith('disable minimax-vision');
    expect(r?.message).toBe('disabled');
  });

  it('/mcp restart filesystem forwards "restart filesystem"', async () => {
    const onMcp = vi.fn(async () => 'restarted');
    const { registry } = makeRig(onMcp);
    const r = await registry.dispatch('/mcp restart filesystem', fakeCtx);
    expect(onMcp).toHaveBeenCalledWith('restart filesystem');
    expect(r?.message).toBe('restarted');
  });

  it('/mcp-servers is an alias', async () => {
    const onMcp = vi.fn(async () => 'listed');
    const { registry } = makeRig(onMcp);
    await registry.dispatch('/mcp-servers list', fakeCtx);
    expect(onMcp).toHaveBeenCalledWith('list');
  });

  it('/help mcp shows usage instructions', async () => {
    const { registry } = makeRig(async () => 'ok');
    const r = await registry.dispatch('/help mcp', fakeCtx);
    expect(r?.message).toContain('/mcp add');
    expect(r?.message).toContain('/mcp remove');
    expect(r?.message).toContain('/mcp enable');
    expect(r?.message).toContain('/mcp disable');
    expect(r?.message).toContain('/mcp restart');
  });

  it('/mcp appears in /help listing', async () => {
    const { registry } = makeRig(async () => 'ok');
    const r = await registry.dispatch('/help', fakeCtx);
    expect(r?.message).toContain('/mcp');
  });
});