import { describe, expect, it, vi } from 'vitest';
import { buildClearCommand } from '../src/slash-commands/clear.js';
import { buildCompactCommand } from '../src/slash-commands/compact.js';
import { buildHelpCommand } from '../src/slash-commands/help.js';
import { buildDesktopCommand, buildWebuiCommand } from '../src/slash-commands/surfaces.js';
import { SlashCommandRegistry, type Context } from '@wrongstack/core';

function fakeCtx(): Context {
  const state = {
    replaceMessages: vi.fn(),
    replaceTodos: vi.fn(),
    deleteMeta: vi.fn(),
  };
  return {
    state,
    readFiles: { clear: vi.fn() } as never as Set<string>,
    fileMtimes: { clear: vi.fn() } as never as Map<string, number>,
    meta: { plan: 'x', other: 'y' },
    session: {
      id: 'test-session-id',
      clearSession: vi.fn().mockResolvedValue(undefined),
    },
    messages: [],
    todos: [],
    systemPrompt: [],
    model: 'test',
    cwd: '/tmp',
    projectRoot: '/tmp',
  } as never as Context;
}

// ── /clear ───────────────────────────────────────────────────────────────────

describe('buildClearCommand', () => {
  it('wipes context state, memory store, session history, and calls onClear', async () => {
    const renderer = { write: vi.fn(), writeInfo: vi.fn(), clear: vi.fn() };
    const memoryStore = { clear: vi.fn().mockResolvedValue(undefined) };
    const onClear = vi.fn();
    const sessionStore = { clearHistory: vi.fn().mockResolvedValue(undefined) };
    const cmd = buildClearCommand({ renderer, memoryStore, onClear, sessionStore } as never);
    const ctx = fakeCtx();
    const res = await cmd.run('', ctx);
    expect(ctx.state.replaceMessages).toHaveBeenCalledWith([]);
    expect(ctx.state.replaceTodos).toHaveBeenCalledWith([]);
    expect(ctx.readFiles.clear).toHaveBeenCalled();
    expect(ctx.fileMtimes.clear).toHaveBeenCalled();
    expect(ctx.state.deleteMeta).toHaveBeenCalledWith('plan');
    expect(ctx.state.deleteMeta).toHaveBeenCalledWith('other');
    expect(ctx.session.clearSession).toHaveBeenCalled();
    expect(sessionStore.clearHistory).toHaveBeenCalledWith('test-session-id');
    expect(memoryStore.clear).toHaveBeenCalled();
    expect(onClear).toHaveBeenCalled();
    expect(renderer.clear).toHaveBeenCalled();
    expect(res?.message ?? '').toContain('Session cleared');
  });

  it('survives missing context and missing memoryStore', async () => {
    const renderer = { write: vi.fn(), writeInfo: vi.fn(), clear: vi.fn() };
    const cmd = buildClearCommand({ renderer } as never);
    const res = await cmd.run('', undefined);
    expect(res?.message ?? '').toContain('Session cleared');
  });
});

// ── /compact ─────────────────────────────────────────────────────────────────

describe('buildCompactCommand', () => {
  it('reports no compactor when one not configured', async () => {
    const renderer = { writeInfo: vi.fn(), writeWarning: vi.fn() };
    const cmd = buildCompactCommand({ renderer } as never);
    const res = await cmd.run('', {} as never);
    expect(res?.message ?? '').toContain('No compactor');
    expect(renderer.writeWarning).toHaveBeenCalled();
  });

  it('runs default compaction and reports phase savings', async () => {
    const renderer = { writeInfo: vi.fn(), writeWarning: vi.fn() };
    const compactor = {
      compact: vi.fn().mockResolvedValue({
        before: 1000,
        after: 600,
        reductions: [
          { phase: 'summary', saved: 300 },
          { phase: 'truncate', saved: 100 },
        ],
        repaired: null,
      }),
    };
    const cmd = buildCompactCommand({ renderer, compactor } as never);
    const res = await cmd.run('', {} as never);
    expect(compactor.compact).toHaveBeenCalledWith({}, { aggressive: false });
    expect(res?.message ?? '').toContain('1000 → 600');
    expect(res?.message ?? '').toContain('summary: 300');
    expect(res?.message ?? '').toContain('truncate: 100');
  });

  it('honors "aggressive" arg and reports repaired count', async () => {
    const renderer = { writeInfo: vi.fn(), writeWarning: vi.fn() };
    const compactor = {
      compact: vi.fn().mockResolvedValue({
        before: 2000,
        after: 1000,
        reductions: [],
        repaired: {
          removedToolUses: ['t1', 't2'],
          removedToolResults: ['r1'],
          removedMessages: 1,
        },
      }),
    };
    const cmd = buildCompactCommand({ renderer, compactor } as never);
    const res = await cmd.run('aggressive', {} as never);
    expect(compactor.compact).toHaveBeenCalledWith({}, { aggressive: true });
    expect(res?.message ?? '').toContain('repaired 2 tool_use');
    expect(res?.message ?? '').toContain('1 tool_result');
  });
});

// ── /help ────────────────────────────────────────────────────────────────────

function makeRegistry(): SlashCommandRegistry {
  const reg = new SlashCommandRegistry();
  reg.register({ name: 'foo', description: 'do foo', aliases: ['f'], run: async () => ({}) });
  reg.register({
    name: 'bar',
    description: 'bar short',
    help: '# Detailed bar help\nmore body',
    run: async () => ({}),
  });
  return reg;
}

describe('surface access commands', () => {
  it('explains the desktop app without launching a process', async () => {
    const cmd = buildDesktopCommand();
    const res = await cmd.run('', {} as never);
    expect(res?.message ?? '').toContain('WrongStack Desktop');
    expect(res?.message ?? '').toContain('only explains');
  });

  it('supports /webui and /web alias with informational guidance', async () => {
    const reg = new SlashCommandRegistry();
    reg.register(buildWebuiCommand());

    const canonical = await reg.dispatch('/webui', {} as never);
    const alias = await reg.dispatch('/web', {} as never);

    expect(canonical?.message ?? '').toContain('WrongStack Web UI');
    expect(alias?.message).toBe(canonical?.message);
    expect(alias?.message ?? '').toContain('more reliable than guessing');
  });
});

// ── /help ────────────────────────────────────────────────────────────────────

describe('buildHelpCommand', () => {
  it('lists all commands when no arg given', async () => {
    const reg = makeRegistry();
    const cmd = buildHelpCommand({ registry: reg } as never);
    const res = await cmd.run('', {} as never);
    expect(res?.message ?? '').toContain('Available slash commands');
    expect(res?.message ?? '').toContain('/foo');
    expect(res?.message ?? '').toContain('(/f)');
    expect(res?.message ?? '').toContain('/bar');
    expect(res?.message ?? '').toContain('Run `/help <name>`');
  });

  it('matches name and returns help body when present', async () => {
    const cmd = buildHelpCommand({ registry: makeRegistry() } as never);
    const res = await cmd.run('bar', {} as never);
    expect(res?.message ?? '').toContain('/bar');
    expect(res?.message ?? '').toContain('# Detailed bar help');
  });

  it('matches alias to the canonical entry', async () => {
    const cmd = buildHelpCommand({ registry: makeRegistry() } as never);
    const res = await cmd.run('f', {} as never);
    expect(res?.message ?? '').toContain('/foo');
    expect(res?.message ?? '').toContain('Aliases: /f');
  });

  it('strips leading slash from the query', async () => {
    const cmd = buildHelpCommand({ registry: makeRegistry() } as never);
    const res = await cmd.run('/foo', {} as never);
    expect(res?.message ?? '').toContain('/foo');
  });

  it('falls back to description when no help is defined', async () => {
    const cmd = buildHelpCommand({ registry: makeRegistry() } as never);
    const res = await cmd.run('foo', {} as never);
    expect(res?.message ?? '').toContain('do foo');
  });

  it('reports unknown command', async () => {
    const cmd = buildHelpCommand({ registry: makeRegistry() } as never);
    const res = await cmd.run('does-not-exist', {} as never);
    expect(res?.message ?? '').toContain('Unknown command');
  });
});
