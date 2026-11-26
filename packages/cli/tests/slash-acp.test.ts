/**
 * Tests for the `/acp` slash command — dispatch + routing only. The heavy
 * ACP runner/registry/probe layer is mocked (covered in packages/acp tests).
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionWriter } from '@wrongstack/contracts/types';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runEnsemble = vi.fn();
const renderEnsembleText = vi.fn((..._args: unknown[]) => 'ENSEMBLE_TEXT');
const runOneAcpTask = vi.fn();
const probeAcpAgents = vi.fn();
const ensembleList = vi.fn();
const resolveAcpAgentCommand = vi.fn();
const runAcpBench = vi.fn();
const renderAcpBenchText = vi.fn((..._args: unknown[]) => 'BENCH_TEXT');

vi.mock('@wrongstack/acp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/acp')>()),
  runEnsemble: (...a: unknown[]) => runEnsemble(...a),
  renderEnsembleText: (...a: unknown[]) => renderEnsembleText(...a),
  runOneAcpTask: (...a: unknown[]) => runOneAcpTask(...a),
  probeAcpAgents: (...a: unknown[]) => probeAcpAgents(...a),
  resolveAcpAgentCommand: (...a: unknown[]) => resolveAcpAgentCommand(...a),
  runAcpBench: (...a: unknown[]) => runAcpBench(...a),
  renderAcpBenchText: (...a: unknown[]) => renderAcpBenchText(...a),
  defaultPermissionPolicy: { evaluate: () => ({ permission: 'auto' }) },
  REGISTRY_ID_ALIASES: {
    'claude-code': 'claude-acp',
    'gemini-cli': 'gemini',
    'codex-cli': 'codex-acp',
    copilot: 'github-copilot-cli',
  },
  EnsembleRegistry: class {
    list = ensembleList;
  },
}));

const loadCachedAcpRegistry = vi.fn(async (..._args: unknown[]): Promise<any> => null);
const refreshAcpRegistry = vi.fn();
vi.mock('../../runtime/src/portable-commands/acp-registry-cache.js', () => ({
  discoverAcpRegistry: (...a: unknown[]) => loadCachedAcpRegistry(...a),
  loadCachedAcpRegistry: (...a: unknown[]) => loadCachedAcpRegistry(...a),
  refreshAcpRegistry: (...a: unknown[]) => refreshAcpRegistry(...a),
}));
vi.mock('@wrongstack/runtime/commands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/runtime/commands')>()),
  buildAcpCommand: (await import('../../runtime/src/portable-commands/acp.js')).buildAcpCommand,
}));

import { buildAcpCommand } from '../src/slash-commands/acp.js';

function fakeOpts(overrides?: Record<string, unknown>) {
  return {
    renderer: {
      write: vi.fn(),
      writeError: vi.fn(),
      writeInfo: vi.fn(),
      writeWarning: vi.fn(),
    },
    cwd: '/tmp',
    projectRoot: '/tmp',
    paths: { cacheDir: '/tmp/cache' },
    configStore: { get: () => ({ acp: { agents: overrides ?? {} } }) },
    onSpawn: undefined as undefined | ((d: string, o?: unknown) => Promise<string>),
  } as never;
}

function cmd(opts = fakeOpts()) {
  return buildAcpCommand(opts);
}

beforeEach(() => {
  runEnsemble.mockReset();
  renderEnsembleText.mockClear();
  runOneAcpTask.mockReset();
  ensembleList.mockReset();
  probeAcpAgents.mockReset();
  resolveAcpAgentCommand.mockReset();
  loadCachedAcpRegistry.mockReset();
  loadCachedAcpRegistry.mockResolvedValue(null);
  refreshAcpRegistry.mockReset();
  runAcpBench.mockReset();
  renderAcpBenchText.mockClear();
});

describe('/acp dispatch', () => {
  it('restores a journaled ACP companion after reopen without sharing it with a fork', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-acp-companion-'));
    let writer: SessionWriter | undefined;
    const options = (sessionStore: DefaultSessionStore) =>
      Object.assign({}, fakeOpts() as object, { sessionStore }) as never;
    resolveAcpAgentCommand.mockReturnValue({ command: 'codex-acp' });
    runOneAcpTask
      .mockResolvedValueOnce({ result: 'started', agentSessionId: 'codex session 1' })
      .mockResolvedValueOnce({ result: 'continued', agentSessionId: 'codex session 1' });
    try {
      const store = new DefaultSessionStore({ dir });
      writer = await store.create({ id: 'acp-companion-journal' });
      const original = writer.id;
      await cmd(options(store)).run('companion codex-cli Inspect the diff', {
        session: writer,
      } as never);
      await writer.close();
      writer = undefined;

      const reopened = new DefaultSessionStore({ dir });
      const forked = await reopened.fork(original);
      expect(forked.data.events).not.toContainEqual(
        expect.objectContaining({ type: 'acp_companion_link' }),
      );
      const restored = await reopened.resume(original);
      writer = restored.writer;
      const command = cmd(options(reopened));
      const context = { session: writer } as never;
      expect(await command.run('companion', context)).toMatchObject({
        message: expect.stringContaining('codex session 1'),
      });
      await command.run('companion codex-cli Explain your finding', context);
      expect(runOneAcpTask).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessionTarget: { action: 'resume', sessionId: 'codex session 1' },
        }),
      );
      await command.run('companion forget codex-cli', context);
      await writer.close();
      writer = undefined;

      const reopenedAgain = new DefaultSessionStore({ dir });
      writer = (await reopenedAgain.resume(original)).writer;
      expect(
        await cmd(options(reopenedAgain)).run('companion', { session: writer } as never),
      ).toMatchObject({
        message: 'No ACP companions in this conversation.',
      });
    } finally {
      await writer?.close().catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reuses an ACP companion session only in the conversation that opened it', async () => {
    const observe = vi.fn();
    const command = cmd({ ...(fakeOpts() as object), onAcpWorkerUpdate: observe } as never);
    const first = { session: { id: 'first' } } as never;
    const second = { session: { id: 'second' } } as never;
    resolveAcpAgentCommand.mockReturnValue({ command: 'codex-acp' });
    runOneAcpTask
      .mockResolvedValueOnce({ result: 'started', agentSessionId: 'codex session 1' })
      .mockResolvedValueOnce({ result: 'continued', agentSessionId: 'codex session 1' })
      .mockResolvedValueOnce({ result: 'other', agentSessionId: 'codex session 2' });

    expect(await command.run('companion codex-cli Read the diff', first)).toMatchObject({
      message: expect.stringContaining('started'),
    });
    expect(await command.run('companion', first)).toMatchObject({
      message: expect.stringContaining('codex-cli'),
    });
    await command.run('companion codex-cli Explain the earlier finding', first);
    await command.run('companion codex-cli Start a new review', second);
    expect(observe).toHaveBeenNthCalledWith(1, {
      sessionId: 'first',
      workerId: 'companion:codex-cli',
      agentId: 'codex-cli',
      state: 'running',
      task: 'Read the diff',
    });
    expect(observe).toHaveBeenNthCalledWith(4, {
      sessionId: 'first',
      workerId: 'companion:codex-cli',
      agentId: 'codex-cli',
      state: 'finished',
      text: 'continued',
    });

    expect(runOneAcpTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        task: 'Explain the earlier finding',
        sessionTarget: { action: 'resume', sessionId: 'codex session 1' },
      }),
    );
    expect(runOneAcpTask.mock.calls[2]?.[0]).not.toHaveProperty('sessionTarget');
    await command.run('companion forget codex-cli', first);
    expect(await command.run('companion', first)).toMatchObject({
      message: 'No ACP companions in this conversation.',
    });
    expect(await command.run('companion', second)).toMatchObject({
      message: expect.stringContaining('codex session 2'),
    });
  });

  it('keeps the answer and reports a journal failure without publishing a link', async () => {
    const command = cmd(
      Object.assign({}, fakeOpts() as object, {
        sessionStore: { load: async () => ({ events: [] }) },
      }) as never,
    );
    const context = {
      session: { id: 'first', append: vi.fn().mockRejectedValue(new Error('journal unavailable')) },
    } as never;
    resolveAcpAgentCommand.mockReturnValue({ command: 'codex-acp' });
    runOneAcpTask.mockResolvedValueOnce({ result: 'answer', agentSessionId: 'first-id' });

    const result = await command.run('companion codex-cli Review', context);
    expect(result).toMatchObject({
      message: expect.stringMatching(
        /answer[\s\S]+ACP companion link could not be saved: journal unavailable/,
      ),
    });
    expect(await command.run('companion', context)).toMatchObject({
      message: 'No ACP companions in this conversation.',
    });
  });

  it('keeps the previous companion link after a rejected follow-up', async () => {
    const command = cmd();
    const context = { session: { id: 'first' } } as never;
    resolveAcpAgentCommand.mockReturnValue({ command: 'codex-acp' });
    runOneAcpTask
      .mockResolvedValueOnce({ result: 'started', agentSessionId: 'first-id' })
      .mockRejectedValueOnce(new Error('agent refused resume'))
      .mockResolvedValueOnce({ result: 'retried', agentSessionId: 'first-id' });

    await command.run('companion codex-cli Start a review', context);
    expect(await command.run('companion codex-cli Continue', context)).toMatchObject({
      message: expect.stringContaining('agent refused resume'),
    });
    await command.run('companion codex-cli Retry', context);
    expect(runOneAcpTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionTarget: { action: 'resume', sessionId: 'first-id' } }),
    );
  });

  it('serializes companion turns and keeps the active link until the turn finishes', async () => {
    const command = cmd();
    const context = { session: { id: 'first' } } as never;
    const started = Promise.withResolvers<void>();
    const done = Promise.withResolvers<{ result: string; agentSessionId: string }>();
    resolveAcpAgentCommand.mockReturnValue({ command: 'codex-acp' });
    runOneAcpTask.mockImplementationOnce(() => {
      started.resolve();
      return done.promise;
    });
    const pending = command.run('companion codex-cli Start', context);
    await started.promise;
    try {
      expect(await command.run('companion codex-cli Continue', context)).toMatchObject({
        message: expect.stringContaining('already has a turn running'),
      });
      expect(await command.run('companion forget codex-cli', context)).toMatchObject({
        message: expect.stringContaining('Wait for the current'),
      });
      expect(runOneAcpTask).toHaveBeenCalledTimes(1);
    } finally {
      done.resolve({ result: 'done', agentSessionId: 'started-id' });
      await pending;
    }
  });

  it('lists detected agents with no args', async () => {
    ensembleList.mockResolvedValue([
      { id: 'gemini-cli', displayName: 'Gemini CLI', installed: true, version: '0.45.1' },
      { id: 'goose', displayName: 'Goose', installed: false, reason: 'binary not found' },
    ]);
    const res = await cmd().run('', {} as never);
    expect((res as { message?: string })?.message).toContain('gemini-cli');
    expect((res as { message?: string })?.message).toContain(
      '1 of 2 bundled agents installed locally',
    );
    expect((res as { message?: string })?.message).toContain('Bundled offline catalog');
  });

  it('lists the official registry after sync, not the bundled catalog', async () => {
    loadCachedAcpRegistry.mockResolvedValue({
      fetchedAt: '2026-09-09T12:00:00.000Z',
      byId: {
        gemini: { command: 'gemini', args: ['--acp'] },
        'grok-build': { command: 'npx', args: ['-y', '@xai-official/grok@1.0.24'] },
        'claude-acp': { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] },
      },
      agents: [
        {
          id: 'gemini',
          displayName: 'Gemini CLI',
          acp: { command: 'gemini', args: ['--acp'] },
        },
        {
          id: 'grok-build',
          displayName: 'Grok Build',
          acp: { command: 'npx', args: ['-y', '@xai-official/grok@1.0.24'] },
        },
        {
          id: 'claude-acp',
          displayName: 'Claude Agent',
          acp: { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] },
        },
      ],
    });
    ensembleList.mockResolvedValue([
      { id: 'gemini-cli', displayName: 'Gemini CLI', installed: true, version: '0.59.0' },
      { id: 'openhands', displayName: 'OpenHands', installed: false, reason: 'binary not found' },
    ]);
    const res = await cmd().run('list', {} as never);
    const message = (res as { message?: string })?.message ?? '';
    expect(message).toContain('Official ACP registry — 3 agents');
    expect(message).toContain('grok-build');
    expect(message).toContain('claude-acp');
    expect(message).toContain('(also claude-code)');
    expect(message).toContain('gemini');
    expect(message).toContain('0.59.0');
    expect(message).toContain('openhands');
    expect(message).not.toContain('bundled agents installed locally');
    expect(message).not.toContain('more ids:');
  });

  it('shows help for `help`', async () => {
    const res = await cmd().run('help', {} as never);
    expect((res as { message?: string })?.message).toContain('/acp <agent-id> <task>');
  });

  it('probes installed agents (bounded) and reports handshake results', async () => {
    ensembleList.mockResolvedValue([
      { id: 'gemini-cli', installed: true },
      { id: 'claude-code', installed: true },
    ]);
    probeAcpAgents.mockResolvedValue([
      { id: 'gemini-cli', ok: true, ms: 120, agentInfo: { name: 'gemini', version: '1' } },
      { id: 'claude-code', ok: false, ms: 8000, error: 'initialize timed out' },
    ]);
    const res = await cmd().run('probe', {} as never);
    expect(probeAcpAgents).toHaveBeenCalledTimes(1);
    const arg = probeAcpAgents.mock.calls[0]![0] as { agentIds: string[] };
    expect(arg.agentIds).toEqual(['gemini-cli', 'claude-code']);
    expect((res as { message?: string })?.message).toContain('✓ gemini-cli');
    expect((res as { message?: string })?.message).toContain('✗ claude-code');
    expect((res as { message?: string })?.message).toContain(
      '1 of 2 agents completed the ACP handshake',
    );
  });

  it('routes parallel to runEnsemble', async () => {
    runEnsemble.mockResolvedValue({ summary: {} });
    const res = await cmd().run('parallel gemini-cli,codex-cli "review diff"', {} as never);
    expect(runEnsemble).toHaveBeenCalledTimes(1);
    const arg = runEnsemble.mock.calls[0]![0] as { agentIds: string; task: string };
    expect(arg.agentIds).toBe('gemini-cli,codex-cli');
    expect(arg.task).toBe('review diff');
    expect((res as { message?: string })?.message).toBe('ENSEMBLE_TEXT');
  });

  it('parallel --bg dispatches every agent as a background subagent', async () => {
    resolveAcpAgentCommand.mockReturnValue({ command: 'gemini', role: 'gemini-cli' });
    const onSpawn = vi.fn(async () => 'Spawned subagent #1');
    const opts = fakeOpts();
    (opts as { onSpawn: unknown }).onSpawn = onSpawn;
    const res = await cmd(opts).run(
      'parallel gemini-cli,codex-cli --bg "review this diff"',
      {} as never,
    );
    expect(onSpawn).toHaveBeenCalledTimes(2);
    expect(onSpawn).toHaveBeenNthCalledWith(1, 'review this diff', {
      provider: 'acp',
      name: 'gemini-cli',
    });
    expect(onSpawn).toHaveBeenNthCalledWith(2, 'review this diff', {
      provider: 'acp',
      name: 'codex-cli',
    });
    expect(runEnsemble).not.toHaveBeenCalled();
    const message = (res as { message?: string })?.message ?? '';
    expect(message).toContain('Dispatched 2 ACP agents as background subagents');
    expect(message).toContain('gemini-cli');
    expect(message).toContain('codex-cli');
  });

  it('parallel --bg skips unknown agents but still dispatches the known ones', async () => {
    resolveAcpAgentCommand.mockImplementation((id: string) =>
      id === 'gemini-cli' ? { command: 'gemini', role: id } : null,
    );
    const onSpawn = vi.fn(async () => 'ok');
    const opts = fakeOpts();
    (opts as { onSpawn: unknown }).onSpawn = onSpawn;
    const res = await cmd(opts).run('parallel gemini-cli,made-up --bg "task"', {} as never);
    expect(onSpawn).toHaveBeenCalledTimes(1);
    expect(onSpawn).toHaveBeenCalledWith('task', { provider: 'acp', name: 'gemini-cli' });
    const message = (res as { message?: string })?.message ?? '';
    expect(message).toContain('Dispatched 1 ACP agent as background subagents');
    expect(message).toContain('made-up (unknown agent)');
    expect(runEnsemble).not.toHaveBeenCalled();
  });

  it('parallel --bg without fleet wiring explains that background mode needs the fleet', async () => {
    const res = await cmd().run('parallel gemini-cli --bg "task"', {} as never);
    const message = (res as { message?: string })?.message ?? '';
    expect(message).toContain('needs the fleet');
    expect(runEnsemble).not.toHaveBeenCalled();
  });

  it('runs a single agent inline and renders the result', async () => {
    resolveAcpAgentCommand.mockReturnValue({
      command: 'gemini',
      args: ['--experimental-acp'],
      role: 'gemini-cli',
    });
    runOneAcpTask.mockResolvedValue({ result: 'all done', iterations: 2, toolCalls: 3 });
    const opts = fakeOpts();
    const res = await cmd(opts).run('gemini-cli "explain x"', {} as never);
    expect(runOneAcpTask).toHaveBeenCalledTimes(1);
    expect((res as { message?: string })?.message).toContain('=== gemini-cli ===');
    expect((res as { message?: string })?.message).toContain('all done');
    expect((res as { message?: string })?.message).toContain('iterations=2 toolCalls=3');
    expect((opts as { renderer: { writeInfo: () => void } }).renderer.writeInfo).toHaveBeenCalled();
  });

  it('dispatches a background subagent with provider:acp when --bg + onSpawn', async () => {
    resolveAcpAgentCommand.mockReturnValue({ command: 'gemini', role: 'gemini-cli' });
    const onSpawn = vi.fn(async () => 'spawned#1');
    const opts = fakeOpts();
    (opts as { onSpawn: unknown }).onSpawn = onSpawn;
    const res = await cmd(opts).run('gemini-cli --bg "long task"', {} as never);
    expect(onSpawn).toHaveBeenCalledWith('long task', { provider: 'acp', name: 'gemini-cli' });
    expect(runOneAcpTask).not.toHaveBeenCalled();
    expect((res as { message?: string })?.message).toContain('background ACP subagent');
  });

  it('--bg without fleet wiring explains that background mode needs the fleet', async () => {
    resolveAcpAgentCommand.mockReturnValue({ command: 'gemini', role: 'gemini-cli' });
    const res = await cmd().run('gemini-cli --bg "task"', {} as never);
    expect((res as { message?: string })?.message).toContain('needs the fleet');
    expect((res as { message?: string })?.message).toContain('always active');
    expect(runOneAcpTask).not.toHaveBeenCalled();
  });

  it('reports an unknown agent id', async () => {
    resolveAcpAgentCommand.mockReturnValue(null);
    const res = await cmd().run('made-up-agent "do it"', {} as never);
    expect((res as { message?: string })?.message).toContain('Unknown ACP agent: made-up-agent');
  });

  it('benches an explicit agent list via runAcpBench', async () => {
    runAcpBench.mockResolvedValue({ summary: { pass: 1, partial: 0, fail: 0, skipped: 0 } });
    const res = await cmd().run('bench gemini-cli,codex-cli', {} as never);
    expect(runAcpBench).toHaveBeenCalledTimes(1);
    const arg = runAcpBench.mock.calls[0]![0] as { agentIds: string[]; checkFs?: boolean };
    expect(arg.agentIds).toEqual(['gemini-cli', 'codex-cli']);
    expect(arg.checkFs).toBe(false);
    expect((res as { message?: string })?.message).toBe('BENCH_TEXT');
  });

  it('bench --fs enables the fs check and defaults to installed agents', async () => {
    ensembleList.mockResolvedValue([
      { id: 'gemini-cli', installed: true },
      { id: 'goose', installed: false },
    ]);
    runAcpBench.mockResolvedValue({ summary: { pass: 1, partial: 0, fail: 0, skipped: 0 } });
    await cmd().run('bench --fs', {} as never);
    const arg = runAcpBench.mock.calls[0]![0] as { agentIds: string[]; checkFs?: boolean };
    expect(arg.agentIds).toEqual(['gemini-cli']);
    expect(arg.checkFs).toBe(true);
  });

  it('syncs the official registry via refreshAcpRegistry', async () => {
    refreshAcpRegistry.mockResolvedValue({
      count: 37,
      location: '/tmp/cache/acp-registry.json',
      fetchedAt: 'now',
    });
    const res = await cmd().run('sync', {} as never);
    expect(refreshAcpRegistry).toHaveBeenCalledTimes(1);
    expect((res as { message?: string })?.message).toContain('Synced 37 agents');
  });

  it('reports a sync failure without throwing', async () => {
    refreshAcpRegistry.mockRejectedValue(new Error('network down'));
    const res = await cmd().run('sync', {} as never);
    expect((res as { message?: string })?.message).toContain('sync failed');
    expect((res as { message?: string })?.message).toContain('network down');
  });

  it('list surfaces synced-registry agents when a cache exists', async () => {
    ensembleList.mockResolvedValue([
      { id: 'gemini-cli', displayName: 'Gemini CLI', installed: true },
    ]);
    loadCachedAcpRegistry.mockResolvedValue({
      fetchedAt: 'now',
      byId: { gemini: { command: 'npx', args: [] } },
      agents: [
        { id: 'gemini', displayName: 'Gemini', acp: { command: 'npx', args: [] } },
        { id: 'factory-droid', displayName: 'Factory Droid', acp: { command: 'npx', args: [] } },
      ],
    });
    const res = await cmd().run('', {} as never);
    expect((res as { message?: string })?.message).toContain('Official ACP registry — 2 agents');
    expect((res as { message?: string })?.message).toContain('factory-droid');
    expect((res as { message?: string })?.message).not.toContain(
      'bundled agents installed locally',
    );
  });

  it('resolves a single run through the live registry byId map', async () => {
    loadCachedAcpRegistry.mockResolvedValue({
      fetchedAt: 'now',
      byId: { gemini: { command: 'npx', args: ['-y', '@google/gemini-cli', '--acp'] } },
      agents: [],
    });
    resolveAcpAgentCommand.mockReturnValue({
      command: 'npx',
      args: ['-y', '@google/gemini-cli', '--acp'],
      role: 'gemini',
    });
    runOneAcpTask.mockResolvedValue({ result: 'ok', iterations: 1, toolCalls: 0 });
    await cmd().run('gemini "hi"', {} as never);
    // 3rd arg to resolveAcpAgentCommand is the live byId map.
    const call = resolveAcpAgentCommand.mock.calls[0]!;
    expect(call[2]).toEqual({
      gemini: { command: 'npx', args: ['-y', '@google/gemini-cli', '--acp'] },
    });
  });

  it('passes the user config override map into resolveAcpAgentCommand', async () => {
    const overrides = { 'codex-cli': { command: 'codex', args: ['acp'] } };
    resolveAcpAgentCommand.mockReturnValue({ command: 'codex', args: ['acp'], role: 'codex-cli' });
    runOneAcpTask.mockResolvedValue({ result: 'ok', iterations: 1, toolCalls: 0 });
    await cmd(fakeOpts(overrides)).run('codex-cli "x"', {} as never);
    // (id, overrides, liveById?) — no synced cache here, so the 3rd arg is undefined.
    expect(resolveAcpAgentCommand).toHaveBeenCalledWith('codex-cli', overrides, undefined);
  });
});
