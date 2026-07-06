import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@wrongstack/core';
import { buildShadowCommand } from '../src/slash-commands/shadow.js';

function ctx(): Context {
  return {} as never as Context;
}

function configStore(provider = 'anthropic', model = 'anthropic-test-model') {
  const live = { provider, model };
  return {
    live,
    store: {
      get: vi.fn(() => live),
      update: vi.fn((partial: { provider?: string; model?: string }) => {
        Object.assign(live, partial);
        return live;
      }),
    },
  };
}

function shadowController(activeId: string | null = null) {
  const defaults: { intervalMs?: number; provider?: string; model?: string } = {};
  const controller = {
    activeId,
    register: vi.fn((id: string) => {
      controller.activeId = id;
    }),
    clear: vi.fn(() => {
      controller.activeId = null;
    }),
    getDefaults: vi.fn(() => ({ ...defaults })),
    setDefaults: vi.fn((next: { intervalMs?: number; provider?: string; model?: string }) => {
      Object.assign(defaults, next);
    }),
  };
  return controller;
}

describe('buildShadowCommand', () => {
  it('start parses interval and provider/model before spawning', async () => {
    const onSpawn = vi.fn(async () => 'sub-shadow');
    const cmd = buildShadowCommand({
      onSpawn,
      shadowController: shadowController(),
    } as never);

    const res = await cmd.run('start --interval=15000 --model=openai/gpt-5', ctx());

    expect(onSpawn).toHaveBeenCalledWith(
      'Shadow Agent — one-shot quiet fleet check',
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5',
        name: 'shadow',
        tools: expect.arrayContaining(['fleet', 'terminate_subagent']),
      }),
    );
    const spawnOpts = onSpawn.mock.calls[0]?.[1];
    expect(spawnOpts?.tools).not.toContain('spawn_subagent');
    expect(spawnOpts?.tools).not.toContain('assign_task');
    expect(spawnOpts?.tools).not.toContain('cron_schedule');
    expect(spawnOpts?.allowedCapabilities).toBeUndefined();
    expect(spawnOpts?.shadowIntervalMs).toBe(15000);
    expect(res?.message).toContain('openai/gpt-5');
  });

  it('start defaults to the current leader provider and model from config', async () => {
    const onSpawn = vi.fn(async () => 'sub-shadow');
    const cfg = configStore('local', 'qwen3-coder');
    const cmd = buildShadowCommand({
      onSpawn,
      shadowController: shadowController(),
      configStore: cfg.store,
      llmProvider: { id: 'anthropic' },
      llmModel: 'stale-session-model',
    } as never);

    const res = await cmd.run('start --interval=5000', ctx());

    expect(onSpawn).toHaveBeenCalledWith(
      'Shadow Agent — one-shot quiet fleet check',
      expect.objectContaining({
        provider: 'local',
        model: 'qwen3-coder',
        name: 'shadow',
      }),
    );
    expect(res?.message).toContain('local/qwen3-coder');
  });

  it('start falls back to the session provider and model when config store is unavailable', async () => {
    const onSpawn = vi.fn(async () => 'sub-shadow');
    const cmd = buildShadowCommand({
      onSpawn,
      shadowController: shadowController(),
      llmProvider: { id: 'local' },
      llmModel: 'qwen3-coder',
    } as never);

    const res = await cmd.run('start --interval=5000', ctx());

    expect(onSpawn).toHaveBeenCalledWith(
      'Shadow Agent — one-shot quiet fleet check',
      expect.objectContaining({
        provider: 'local',
        model: 'qwen3-coder',
        name: 'shadow',
      }),
    );
    expect(res?.message).toContain('local/qwen3-coder');
  });

  it('interval and model commands update the next start defaults', async () => {
    const onSpawn = vi.fn(async () => 'sub-shadow');
    const controller = shadowController();
    const cfg = configStore('local', 'qwen3-coder');
    const cmd = buildShadowCommand({
      onSpawn,
      shadowController: controller,
      configStore: cfg.store,
      llmProvider: { id: 'local' },
      llmModel: 'qwen3-coder',
    } as never);

    await cmd.run('interval 7000', ctx());
    await cmd.run('model openai/gpt-5', ctx());
    const res = await cmd.run('start', ctx());

    expect(controller.setDefaults).toHaveBeenCalledWith({ intervalMs: 7000 });
    expect(controller.setDefaults).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5' });
    expect(onSpawn).toHaveBeenCalledWith(
      'Shadow Agent — one-shot quiet fleet check',
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5',
        shadowIntervalMs: 7000,
      }),
    );
    expect(res?.message).toContain('openai/gpt-5');
  });

  it('allows model ids that contain slashes after the provider prefix', async () => {
    const onSpawn = vi.fn(async () => 'sub-shadow');
    const cmd = buildShadowCommand({
      onSpawn,
      shadowController: shadowController(),
    } as never);

    await cmd.run('start --model=openrouter/anthropic/anthropic-test-model', ctx());

    expect(onSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        provider: 'openrouter',
        model: 'anthropic/anthropic-test-model',
      }),
    );
  });

  it('start rejects invalid interval values without spawning', async () => {
    const onSpawn = vi.fn(async () => 'sub-shadow');
    const cmd = buildShadowCommand({
      onSpawn,
      shadowController: shadowController(),
    } as never);

    const res = await cmd.run('start --interval=abc', ctx());

    expect(onSpawn).not.toHaveBeenCalled();
    expect(res?.message).toContain('interval must be an integer');
  });

  it('start refuses a duplicate registered shadow agent', async () => {
    const onSpawn = vi.fn(async () => 'sub-shadow');
    const cmd = buildShadowCommand({
      onSpawn,
      shadowController: shadowController('sub-existing'),
    } as never);

    const res = await cmd.run('start', ctx());

    expect(onSpawn).not.toHaveBeenCalled();
    expect(res?.message).toContain('already running');
  });

  it('stop terminates the registered shadow agent and clears the controller', async () => {
    const controller = shadowController('sub-shadow');
    const onFleetTerminate = vi.fn(() => true);
    const cmd = buildShadowCommand({
      onFleetTerminate,
      shadowController: controller,
    } as never);

    const res = await cmd.run('stop', ctx());

    expect(onFleetTerminate).toHaveBeenCalledWith('sub-shadow');
    expect(controller.clear).toHaveBeenCalledTimes(1);
    expect(controller.activeId).toBeNull();
    expect(res?.message).toContain('stopped');
  });

  it('stop waits for async termination before clearing the controller', async () => {
    const controller = shadowController('sub-shadow');
    let resolveTerminate!: (ok: boolean) => void;
    const onFleetTerminate = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveTerminate = resolve;
    }));
    const cmd = buildShadowCommand({
      onFleetTerminate,
      shadowController: controller,
    } as never);

    const pending = cmd.run('stop', ctx());
    await Promise.resolve();

    expect(controller.clear).not.toHaveBeenCalled();
    resolveTerminate(true);
    const res = await pending;

    expect(controller.clear).toHaveBeenCalledTimes(1);
    expect(res?.message).toContain('stopped');
  });

  it('hoop terminates a specific target agent', async () => {
    const onFleetTerminate = vi.fn(() => true);
    const onAgents = vi.fn(() => 'Agent sub-123\n  status: running');
    const cmd = buildShadowCommand({
      onAgents,
      onFleetTerminate,
      shadowController: shadowController('sub-shadow'),
    } as never);

    const res = await cmd.run('hoop sub-123 --reason=looping', ctx());

    expect(onAgents).toHaveBeenCalledWith('sub-123');
    expect(onFleetTerminate).toHaveBeenCalledWith('sub-123');
    expect(res?.message).toContain('Stopped agent');
    expect(res?.message).toContain('looping');
  });

  it('hoop all kills the fleet and clears the shadow controller', async () => {
    const controller = shadowController('sub-shadow');
    const onFleetKill = vi.fn(() => 3);
    const cmd = buildShadowCommand({
      onFleetKill,
      shadowController: controller,
    } as never);

    const res = await cmd.run('hoop all --reason=wedged', ctx());

    expect(onFleetKill).toHaveBeenCalledTimes(1);
    expect(controller.clear).toHaveBeenCalledTimes(1);
    expect(res?.message).toContain('Stopped 3 running agent');
  });
});
