import type { Context } from '@wrongstack/core/agent';
import { describe, expect, it, vi } from 'vitest';
import type {
  SlashCommandContext,
  TokenCounter,
  ToolRegistry,
} from '../src/slash-commands/index.js';
import { buildBuiltinSlashCommands } from '../src/slash-commands/index.js';
import { buildWorktreeCommand } from '../src/slash-commands/worktree.js';

type TestCommandContext = SlashCommandContext & Context;

function ctx(extra: object = {}): TestCommandContext {
  return {
    session: { id: 's1' },
    toolRegistry: { list: () => [] } as unknown as ToolRegistry,
    renderer: {
      write: () => {},
      writeWarning: () => {},
      writeError: () => {},
      writeInfo: () => {},
      projectRoot: '/tmp',
    } as unknown as SlashCommandContext['renderer'],
    tokenCounter: { total: () => ({ input: 0, output: 0 }) } as TokenCounter,
    events: { on: () => {} } as unknown as SlashCommandContext['events'],
    projectRoot: '/tmp',
    cwd: '/tmp',
    messages: [],
    todos: [],
    readFiles: new Set(),
    fileMtimes: new Map(),
    systemPrompt: [],
    model: 'test',
    meta: {},
    reader: { readFile: async () => null } as unknown as SlashCommandContext['reader'],
    state: {
      replaceMessages: vi.fn(),
      replaceTodos: vi.fn(),
      deleteMeta: vi.fn(),
    },
    ...extra,
  } as unknown as TestCommandContext;
}

describe('buildWorktreeCommand', () => {
  it('warns when onWorktree is missing', async () => {
    const cmd = buildWorktreeCommand(ctx());
    const res = await cmd.run('', ctx());
    expect(res?.message).toContain('No worktree manager active');
  });

  it('empty args defaults to list', async () => {
    const onWorktree = vi.fn().mockResolvedValue('LIST_OUT');
    const cmd = buildWorktreeCommand({ ...ctx(), onWorktree });
    const res = await cmd.run('', ctx());
    expect(onWorktree).toHaveBeenCalledWith('list');
    expect(res?.message).toBe('LIST_OUT');
  });

  it('merge without a branch reports usage', async () => {
    const onWorktree = vi.fn();
    const cmd = buildWorktreeCommand({ ...ctx(), onWorktree });
    const res = await cmd.run('merge', ctx());
    expect(onWorktree).not.toHaveBeenCalled();
    expect(res?.message).toMatch(/Usage: \/worktree merge <branch>/);
  });

  it('forwards merge / prune / clean verbs', async () => {
    const onWorktree = vi.fn().mockResolvedValue('OK');
    const cmd = buildWorktreeCommand({ ...ctx(), onWorktree });
    await cmd.run('merge wstack/ap/x', ctx());
    await cmd.run('prune', ctx());
    await cmd.run('clean', ctx());
    expect(onWorktree).toHaveBeenNthCalledWith(1, 'merge', 'wstack/ap/x');
    expect(onWorktree).toHaveBeenNthCalledWith(2, 'prune');
    expect(onWorktree).toHaveBeenNthCalledWith(3, 'clean');
  });

  it('reports unknown subcommands', async () => {
    const onWorktree = vi.fn().mockResolvedValue('OK');
    const cmd = buildWorktreeCommand({ ...ctx(), onWorktree });
    const res = await cmd.run('frobnicate', ctx());
    expect(res?.message).toMatch(/Unknown subcommand/);
    expect(onWorktree).not.toHaveBeenCalled();
  });

  it('is registered as a builtin command', () => {
    const names = buildBuiltinSlashCommands(ctx()).map((c) => c.name);
    expect(names).toContain('worktree');
  });
});
