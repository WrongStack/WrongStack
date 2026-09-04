import type { Context } from '@wrongstack/core/agent';
import { SlashCommandRegistry } from '@wrongstack/core/registry';
import { describe, expect, it, vi } from 'vitest';
import { buildClearCommand } from '../src/slash-commands/clear.js';
import { buildCompactCommand } from '../src/slash-commands/compact.js';
import { buildHelpCommand } from '../src/slash-commands/help.js';
import {
  renderSlashDeepHelp,
  renderSlashFocusedHelp,
} from '../src/slash-commands/slash-deep-help.js';
import { buildDesktopCommand, buildWebuiCommand } from '../src/slash-commands/surfaces.js';

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
  it('wipes context and session history, preserves memory, and calls onClear', async () => {
    const renderer = { write: vi.fn(), writeInfo: vi.fn(), clear: vi.fn() };
    const memoryStore = { clear: vi.fn().mockResolvedValue(undefined) };
    const onClear = vi.fn();
    const sessionStore = { clearHistory: vi.fn().mockResolvedValue(undefined) };
    let settleActiveRun!: () => void;
    const activeRunSettled = new Promise<void>((resolve) => {
      settleActiveRun = resolve;
    });
    const interruptController = {
      resetSession: vi.fn(),
      abortLeader: vi.fn(() => true),
      waitForIdle: vi.fn(() => activeRunSettled),
    };
    const onFleetKill = vi.fn().mockResolvedValue(2);
    const cmd = buildClearCommand({
      renderer,
      memoryStore,
      onClear,
      sessionStore,
      interruptController,
      onFleetKill,
    } as never);
    const ctx = fakeCtx();
    let completed = false;
    const runPromise = cmd.run('', ctx).then((result) => {
      completed = true;
      return result;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(ctx.state.replaceMessages).not.toHaveBeenCalled();
    settleActiveRun();
    const res = await runPromise;
    expect(interruptController.resetSession).toHaveBeenCalledTimes(1);
    expect(interruptController.abortLeader).toHaveBeenCalledTimes(1);
    expect(onFleetKill).toHaveBeenCalledTimes(1);
    expect(interruptController.waitForIdle).toHaveBeenCalledTimes(1);
    expect(interruptController.waitForIdle.mock.invocationCallOrder[0]).toBeLessThan(
      (ctx.state.replaceMessages as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ??
        Infinity,
    );
    expect(ctx.state.replaceMessages).toHaveBeenCalledWith([]);
    expect(ctx.state.replaceTodos).toHaveBeenCalledWith([]);
    expect(ctx.readFiles.clear).toHaveBeenCalled();
    expect(ctx.fileMtimes.clear).toHaveBeenCalled();
    expect(ctx.state.deleteMeta).toHaveBeenCalledWith('plan');
    expect(ctx.state.deleteMeta).toHaveBeenCalledWith('other');
    expect(ctx.session.clearSession).toHaveBeenCalled();
    expect(sessionStore.clearHistory).toHaveBeenCalledWith('test-session-id');
    expect(memoryStore.clear).not.toHaveBeenCalled();
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

// ── /clear confirmation gate (operation in flight) ───────────────────────────

describe('buildClearCommand — confirm before clearing an active session', () => {
  function baseOpts(overrides: Record<string, unknown>) {
    return {
      renderer: { write: vi.fn(), writeInfo: vi.fn(), clear: vi.fn() },
      memoryStore: { clear: vi.fn().mockResolvedValue(undefined) },
      onClear: vi.fn(),
      sessionStore: { clearHistory: vi.fn().mockResolvedValue(undefined) },
      ...overrides,
    };
  }

  it('prompts for confirmation when an operation is running, then aborts the clear on "no"', async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    const interruptController = {
      abortLeader: vi.fn(() => true),
      isRunning: vi.fn(() => true),
      resetSession: vi.fn(),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };
    const onFleetKill = vi.fn().mockResolvedValue(0);
    const opts = baseOpts({ interruptController, confirm, onFleetKill });
    const cmd = buildClearCommand(opts as never);
    const ctx = fakeCtx();

    const res = await cmd.run('', ctx);

    // The gate asked the user, defaulting to "no".
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[1]).toBe(false);
    // Nothing was torn down: no cancellation, no state wipe, no memory clear.
    expect(interruptController.abortLeader).not.toHaveBeenCalled();
    expect(interruptController.resetSession).not.toHaveBeenCalled();
    expect(onFleetKill).not.toHaveBeenCalled();
    expect(ctx.state.replaceMessages).not.toHaveBeenCalled();
    expect(opts.memoryStore.clear).not.toHaveBeenCalled();
    expect(opts.onClear).not.toHaveBeenCalled();
    expect(res?.message ?? '').toContain('cancelled');
  });

  it('aborts the clear when the user cancels the prompt (null)', async () => {
    const confirm = vi.fn().mockResolvedValue(null);
    const interruptController = { abortLeader: vi.fn(() => true), isRunning: vi.fn(() => true) };
    const opts = baseOpts({ interruptController, confirm });
    const cmd = buildClearCommand(opts as never);
    const ctx = fakeCtx();

    const res = await cmd.run('', ctx);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(ctx.state.replaceMessages).not.toHaveBeenCalled();
    expect(res?.message ?? '').toContain('cancelled');
  });

  it('proceeds with the session reset while preserving memory when the user confirms "yes"', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const interruptController = {
      abortLeader: vi.fn(() => true),
      isRunning: vi.fn(() => true),
      resetSession: vi.fn(),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };
    const opts = baseOpts({ interruptController, confirm });
    const cmd = buildClearCommand(opts as never);
    const ctx = fakeCtx();

    const res = await cmd.run('', ctx);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(interruptController.resetSession).toHaveBeenCalledTimes(1);
    expect(interruptController.abortLeader).toHaveBeenCalledTimes(1);
    expect(ctx.state.replaceMessages).toHaveBeenCalledWith([]);
    expect(opts.memoryStore.clear).not.toHaveBeenCalled();
    expect(res?.message ?? '').toContain('Session cleared');
  });

  it('uses the TUI clear panel bridge and reports active leader/subagent counts', async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    const confirmClear = vi.fn().mockResolvedValue(true);
    const interruptController = {
      abortLeader: vi.fn(() => true),
      isRunning: vi.fn(() => true),
      confirmClear,
      resetSession: vi.fn(),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };
    const opts = baseOpts({
      interruptController,
      confirm,
      onFleetStatus: () => ({
        subagents: [
          { id: 'one', status: 'running' },
          { id: 'two', status: 'idle' },
          { id: 'done', status: 'stopped' },
        ],
      }),
    });
    const cmd = buildClearCommand(opts as never);

    const res = await cmd.run('', fakeCtx());

    expect(confirmClear).toHaveBeenCalledWith({ leaderActive: true, subagentCount: 2 });
    expect(confirm).not.toHaveBeenCalled();
    expect(interruptController.resetSession).toHaveBeenCalledTimes(1);
    expect(res?.metadata?.cleared).toBe(true);
  });

  it('does NOT prompt when nothing is running (isRunning false)', async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    const interruptController = {
      abortLeader: vi.fn(() => false),
      isRunning: vi.fn(() => false),
      resetSession: vi.fn(),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };
    const opts = baseOpts({ interruptController, confirm });
    const cmd = buildClearCommand(opts as never);
    const ctx = fakeCtx();

    const res = await cmd.run('', ctx);

    expect(confirm).not.toHaveBeenCalled();
    expect(interruptController.resetSession).toHaveBeenCalledTimes(1);
    expect(ctx.state.replaceMessages).toHaveBeenCalledWith([]);
    expect(res?.message ?? '').toContain('Session cleared');
  });

  it('does NOT prompt when no confirm hook is wired, even if running (non-TTY surface)', async () => {
    const interruptController = {
      abortLeader: vi.fn(() => true),
      isRunning: vi.fn(() => true),
      resetSession: vi.fn(),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };
    // No `confirm` in opts → gate is skipped, behavior unchanged.
    const opts = baseOpts({ interruptController });
    const cmd = buildClearCommand(opts as never);
    const ctx = fakeCtx();

    const res = await cmd.run('', ctx);

    expect(interruptController.resetSession).toHaveBeenCalledTimes(1);
    expect(ctx.state.replaceMessages).toHaveBeenCalledWith([]);
    expect(res?.message ?? '').toContain('Session cleared');
  });

  it('treats a missing isRunning() as idle and does not prompt', async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    // interruptController without isRunning (older surface) → optional-chain → idle.
    const interruptController = { abortLeader: vi.fn(() => false), resetSession: vi.fn() };
    const opts = baseOpts({ interruptController, confirm });
    const cmd = buildClearCommand(opts as never);
    const ctx = fakeCtx();

    const res = await cmd.run('', ctx);

    expect(confirm).not.toHaveBeenCalled();
    expect(ctx.state.replaceMessages).toHaveBeenCalledWith([]);
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

  // `slash-deep-help.ts` shipped with five exports, ~40 tests, and no
  // production caller: `/help mcp` rendered `/mcp`'s short inline string and
  // `/help mcp add` answered "Unknown command: /mcp add". Both now route
  // through the same renderer `wstack mcp --help` uses. These tests pin the
  // wiring, not the renderer — the renderer has its own suite.
  it('appends the focused wstack help block for a slash with a top-level mirror', async () => {
    const reg = new SlashCommandRegistry();
    reg.register({
      name: 'mcp',
      description: 'mcp short',
      help: 'inline mcp help',
      run: async () => ({}),
    });
    const cmd = buildHelpCommand({ registry: reg } as never);
    const res = await cmd.run('mcp', {} as never);
    const message = res?.message ?? '';
    // The slash-form inline help SURVIVES — a REPL user types `/mcp add`,
    // not `wstack mcp add` — and the shared focused block follows it.
    expect(message).toContain('inline mcp help');
    expect(message).toContain(renderSlashFocusedHelp('mcp') as string);
    expect(message.indexOf('inline mcp help')).toBeLessThan(
      message.indexOf(renderSlashFocusedHelp('mcp') as string),
    );
  });

  it('renders deep help for `/help <slash> <deep>`', async () => {
    const reg = new SlashCommandRegistry();
    reg.register({ name: 'mcp', description: 'mcp short', run: async () => ({}) });
    const cmd = buildHelpCommand({ registry: reg } as never);
    const res = await cmd.run('mcp add', {} as never);
    expect(res?.message ?? '').toBe(renderSlashDeepHelp('mcp', 'add') as string);
    expect(res?.message ?? '').not.toContain('Unknown command');
  });

  it('still falls back to the inline help field for a slash with no mirror', async () => {
    const cmd = buildHelpCommand({ registry: makeRegistry() } as never);
    const res = await cmd.run('bar', {} as never);
    expect(res?.message ?? '').toContain('# Detailed bar help');
  });

  it('still reports unknown for a two-token query with no deep-help entry', async () => {
    const cmd = buildHelpCommand({ registry: makeRegistry() } as never);
    const res = await cmd.run('bar nonsense', {} as never);
    expect(res?.message ?? '').toContain('Unknown command');
  });
});
