import type { Context } from '@wrongstack/core/agent';
import { describe, expect, it, vi } from 'vitest';
import { buildFleetCommand } from '../src/slash-commands/fleet.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

function ctx(extra: object = {}): Context {
  return {
    session: { id: 's1' },
    renderer: { write: () => {}, writeWarning: () => {}, projectRoot: '/tmp' },
    projectRoot: '/tmp',
    messages: [],
    todos: [],
    readFiles: new Set(),
    fileMtimes: new Map(),
    systemPrompt: [],
    model: 'test',
    cwd: '/tmp',
    meta: {},
    state: {
      replaceMessages: () => {},
      replaceTodos: () => {},
      deleteMeta: () => {},
    },
    ...extra,
  } as never as Context;
}

function fleetCtx(extra: object = {}): SlashCommandContext {
  return {
    session: { id: 's1' },
    renderer: { write: () => {}, writeWarning: () => {}, projectRoot: '/tmp' },
    projectRoot: '/tmp',
    messages: [],
    todos: [],
    readFiles: new Set(),
    fileMtimes: new Map(),
    systemPrompt: [],
    model: 'test',
    cwd: '/tmp',
    meta: {},
    state: {
      replaceMessages: () => {},
      replaceTodos: () => {},
      deleteMeta: () => {},
    },
    ...extra,
  } as never as SlashCommandContext;
}

describe('buildFleetCommand', () => {
  it('reports no fleet active when onFleet missing', async () => {
    const cmd = buildFleetCommand(fleetCtx());
    const res = await cmd.run('', ctx());
    expect(res?.message).toContain('No fleet active');
  });

  it('empty args defaults to status', async () => {
    const onFleet = vi.fn().mockResolvedValue('STATUS_OUT');
    const cmd = buildFleetCommand({ ...fleetCtx(), onFleet });
    const res = await cmd.run('', ctx());
    expect(onFleet).toHaveBeenCalledWith('status', undefined);
    expect(res?.message).toBe('STATUS_OUT');
  });

  it('routes status / usage / manifest verbs directly', async () => {
    const onFleet = vi.fn().mockResolvedValue('X');
    const cmd = buildFleetCommand({ ...fleetCtx(), onFleet });
    await cmd.run('status', ctx());
    await cmd.run('usage', ctx());
    await cmd.run('manifest', ctx());
    expect(onFleet).toHaveBeenNthCalledWith(1, 'status', undefined);
    expect(onFleet).toHaveBeenNthCalledWith(2, 'usage', undefined);
    expect(onFleet).toHaveBeenNthCalledWith(3, 'manifest', undefined);
  });

  it('kill without id reports usage', async () => {
    const onFleetKill = vi.fn(() => 0);
    const cmd = buildFleetCommand({ ...fleetCtx(), onFleetKill });
    const res = await cmd.run('kill', ctx());
    expect(onFleetKill).toHaveBeenCalledTimes(1);
    expect(res?.message).toMatch(/Killed 0 subagent/);
  });

  it('kill with id forwards to onFleet', async () => {
    const onFleet = vi.fn().mockResolvedValue('killed');
    const cmd = buildFleetCommand({ ...fleetCtx(), onFleet });
    const res = await cmd.run('kill sub-123', ctx());
    expect(onFleet).toHaveBeenCalledWith('kill', 'sub-123');
    expect(res?.message).toBe('killed');
  });

  it('retry without handler forwards to onFleet', async () => {
    const onFleet = vi
      .fn()
      .mockResolvedValue('Retry is only available when director mode is active.');
    const cmd = buildFleetCommand({ ...fleetCtx(), onFleet });
    const res = await cmd.run('retry', ctx());
    expect(res?.message).toContain('director mode');
  });

  it('retry forwards to onFleetRetry with no target', async () => {
    const onFleetRetry = vi.fn().mockResolvedValue('list');
    const onFleet = vi.fn();
    const cmd = buildFleetCommand({ ...fleetCtx(), onFleet, onFleetRetry });
    const res = await cmd.run('retry', ctx());
    expect(onFleetRetry).toHaveBeenCalledWith(undefined);
    expect(res?.message).toBe('list');
  });

  it('retry forwards specific taskId', async () => {
    const onFleetRetry = vi.fn().mockResolvedValue('retried');
    const onFleet = vi.fn();
    const cmd = buildFleetCommand({ ...fleetCtx(), onFleet, onFleetRetry });
    await cmd.run('retry task-42', ctx());
    expect(onFleetRetry).toHaveBeenCalledWith('task-42');
  });

  it('log without onFleetLog falls through to onFleet', async () => {
    const onFleet = vi.fn().mockResolvedValue('No journal entries yet.');
    const cmd = buildFleetCommand({ ...fleetCtx(), onFleet });
    const res = await cmd.run('log sub-1', ctx());
    expect(res?.message).toContain('No journal entries yet.');
  });

  it('log lists transcripts when called without id', async () => {
    const onFleetLog = vi.fn().mockResolvedValue('listing');
    const onFleet = vi.fn();
    const cmd = buildFleetCommand({ ...fleetCtx(), onFleet, onFleetLog });
    await cmd.run('log', ctx());
    expect(onFleetLog).toHaveBeenCalledWith(undefined, 'summary');
  });

  it('log with id uses summary mode by default', async () => {
    const onFleetLog = vi.fn().mockResolvedValue('summary');
    const onFleet = vi.fn();
    const cmd = buildFleetCommand({ ...fleetCtx(), onFleet, onFleetLog });
    await cmd.run('log sub-7', ctx());
    expect(onFleetLog).toHaveBeenCalledWith('sub-7', 'summary');
  });

  it('log with id + "raw" uses raw mode', async () => {
    const onFleetLog = vi.fn().mockResolvedValue('raw-out');
    const onFleet = vi.fn();
    const cmd = buildFleetCommand({ ...fleetCtx(), onFleet, onFleetLog });
    await cmd.run('log sub-7 raw', ctx());
    expect(onFleetLog).toHaveBeenCalledWith('sub-7', 'raw');
  });

  it('stream without controller reports unknown subcommand', async () => {
    const cmd = buildFleetCommand({ ...fleetCtx(), onFleet: vi.fn() });
    const res = await cmd.run('stream on', ctx());
    expect(res?.message).toContain('Unknown subcommand');
  });

  it('stream (no arg) reports unknown subcommand', async () => {
    const cmd = buildFleetCommand({ ...fleetCtx(), onFleet: vi.fn() });
    const res = await cmd.run('stream', ctx());
    expect(res?.message).toContain('Unknown subcommand');
  });

  it('stream status sub-verb reports unknown subcommand', async () => {
    const cmd = buildFleetCommand({ ...fleetCtx(), onFleet: vi.fn() });
    const res = await cmd.run('stream status', ctx());
    expect(res?.message).toContain('Unknown subcommand');
  });

  it('stream invalid arg reports unknown subcommand', async () => {
    const cmd = buildFleetCommand({ ...fleetCtx(), onFleet: vi.fn() });
    const res = await cmd.run('stream maybe', ctx());
    expect(res?.message).toContain('Unknown subcommand');
  });

  it('stream on reports unknown subcommand', async () => {
    const cmd = buildFleetCommand({ ...fleetCtx(), onFleet: vi.fn() });
    const res = await cmd.run('stream on', ctx());
    expect(res?.message).toContain('Unknown subcommand');
  });

  it('stream off reports unknown subcommand', async () => {
    const cmd = buildFleetCommand({ ...fleetCtx(), onFleet: vi.fn() });
    const res = await cmd.run('stream off', ctx());
    expect(res?.message).toContain('Unknown subcommand');
  });

  it('help / ? render the help block', async () => {
    const cmd = buildFleetCommand({ ...fleetCtx(), onFleet: vi.fn() });
    expect((await cmd.run('help', ctx()))?.message).toMatch(/Fleet Commands/);
    expect((await cmd.run('?', ctx()))?.message).toMatch(/Fleet Commands/);
  });

  it('unknown verb shows hint listing valid ones', async () => {
    const cmd = buildFleetCommand({ ...fleetCtx(), onFleet: vi.fn() });
    const res = await cmd.run('frobulate', ctx());
    expect(res?.message).toContain('Unknown subcommand "frobulate"');
    expect(res?.message).toContain('status');
  });

  it('list renders the roster grouped by phase', async () => {
    const cmd = buildFleetCommand(fleetCtx());
    const res = await cmd.run('list', ctx());
    expect(res?.message).toMatch(/Agent Roster/);
    expect(res?.message).toMatch(/Phase 1 . Discovery/);
    expect(res?.message).toContain('debugger');
    expect(res?.message).toContain('security-reviewer');
  });

  it('dispatch routes a task to an agent and spawns it', async () => {
    const onFleetSpawn = vi.fn().mockResolvedValue('sub-xyz');
    const cmd = buildFleetCommand({ ...fleetCtx(), onFleetSpawn });
    const res = await cmd.run('dispatch fix the crash when the app starts', ctx());
    expect(onFleetSpawn).toHaveBeenCalledWith('debugger');
    expect(res?.message).toContain('debugger');
    expect(res?.message).toContain('spawned');
  });

  it('dispatch without a task reports usage', async () => {
    const cmd = buildFleetCommand(fleetCtx());
    const res = await cmd.run('dispatch', ctx());
    expect(res?.message).toContain('Usage: /fleet dispatch');
  });

  it('dispatch uses the LLM classifier when wired and heuristic is weak', async () => {
    const onDispatchClassify = vi.fn().mockResolvedValue({ role: 'architect', reason: 'design' });
    const onFleetSpawn = vi.fn().mockResolvedValue('sub-1');
    const cmd = buildFleetCommand({ ...fleetCtx(), onDispatchClassify, onFleetSpawn });
    const res = await cmd.run('dispatch ponder the shape of this thing', ctx());
    expect(onDispatchClassify).toHaveBeenCalled();
    expect(res?.message).toContain('architect');
  });
});
