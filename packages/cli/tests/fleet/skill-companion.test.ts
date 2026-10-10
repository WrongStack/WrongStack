import type { Context } from '@wrongstack/core/agent';
import type { Director } from '@wrongstack/core/coordination';
import { EventBus } from '@wrongstack/core/kernel';
import { readSkillCompanionState } from '@wrongstack/core/skills';
import type {
  SkillLoader,
  SkillManifest,
  SubagentConfig,
  TaskResult,
} from '@wrongstack/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostSkillCompanion } from '../../src/fleet/host-skill-companion.js';
import {
  constrainSkillCompanion,
  isSkillCompanion,
  parseSkillCompanionPick,
} from '../../src/fleet/skill-companion-policy.js';

function manifest(name: string, description: string): SkillManifest {
  return { name, description, path: `/skills/${name}/SKILL.md`, source: 'project' };
}

const CATALOG = [
  manifest('frontend-design', 'Distinctive UI design for new screens.'),
  manifest('cloudflare', 'Workers, wrangler and edge deployment.'),
  manifest('testing', 'Write and fix tests.'),
];

const instances: HostSkillCompanion[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.stop();
});

function leaderCtx(sessionId = 'S1') {
  return {
    meta: {} as Record<string, unknown>,
    messages: [] as unknown[],
    session: { id: sessionId },
    tools: [{ name: 'skill' }, { name: 'edit' }, { name: 'read' }],
  } as unknown as Context;
}

function harness(
  options: { enforce?: 'speed-bump' | 'off'; maxProbes?: number; timeoutMs?: number } = {},
) {
  const events = new EventBus();
  let completed: (event: { result: TaskResult }) => void = () => {};
  let enabled = true;
  const note = vi.fn();
  const spawn = vi.fn(async (_config: SubagentConfig) => 'worker');
  const assignInternal = vi.fn(
    async (_task: { id: string; subagentId: string; description: string }) => {},
  );
  const terminate = vi.fn(async () => {});
  const director = {
    spawnCompanion: spawn,
    assignInternal,
    terminate,
    status: () => ({ subagents: [{ id: 'worker' }] }),
    on: (_event: string, handler: typeof completed) => {
      completed = handler;
      return () => {};
    },
  } as unknown as Director;
  const loader = { list: vi.fn(async () => CATALOG) } as unknown as SkillLoader;
  const companion = new HostSkillCompanion({
    director,
    events,
    skillLoader: () => loader,
    enabled: () => enabled,
    config: {
      ...(options.enforce ? { enforce: options.enforce } : {}),
      ...(options.maxProbes ? { maxProbesPerSession: options.maxProbes } : {}),
      ...(options.timeoutMs ? { probeTimeoutMs: options.timeoutMs } : {}),
    },
    scrub: (text) => text.replaceAll('secret-fixture', '[redacted]'),
    note,
  });
  instances.push(companion);
  const ctx = leaderCtx();
  const run = (text: string, target: Context = ctx, sessionId = 'S1') =>
    events.emit('agent.run.started', {
      sessionId,
      ctx: target,
      model: 'm',
      at: new Date().toISOString(),
      inputText: text,
    });
  const finish = (body: object, status: TaskResult['status'] = 'success') => {
    const task = assignInternal.mock.calls.at(-1)![0];
    completed({
      result: {
        taskId: task.id,
        subagentId: 'worker',
        status,
        result: JSON.stringify(body),
      } as TaskResult,
    });
  };
  return {
    events,
    ctx,
    run,
    finish,
    note,
    spawn,
    assignInternal,
    terminate,
    disable: () => {
      enabled = false;
    },
  };
}

const PICK = {
  skills: [{ name: 'frontend-design', reason: 'new settings screen' }],
  confidence: 0.9,
};

describe('Skill Companion', () => {
  it('judges a new turn with a tool-less resident and arms a one-time hold', async () => {
    const h = harness();
    h.run('Redesign the settings page with secret-fixture tokens');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));

    const config = h.spawn.mock.calls[0]![0];
    expect(isSkillCompanion(config)).toBe(true);
    expect(config.tools).toEqual([]);
    // Sealed: the coordinator, agent loop and budget keep it on this one job.
    expect(config.sealed).toBe(true);
    expect(config.originSessionId).toBe('S1');
    const task = h.assignInternal.mock.calls[0]![0].description;
    expect(task).toContain('"frontend-design"');
    expect(task).toContain('[redacted]');
    expect(task).not.toContain('secret-fixture');

    h.finish(PICK);
    await vi.waitFor(() => expect(h.note).toHaveBeenCalledTimes(1));
    expect(h.note.mock.calls[0]![1]).toBe('[skill:recommend]');
    expect(h.note.mock.calls[0]![2]).toContain('skill({ name: "frontend-design" })');
    expect(h.note.mock.calls[0]![2]).toContain('held once');
    expect(readSkillCompanionState(h.ctx)?.recommended).toEqual([
      { name: 'frontend-design', reason: 'new settings screen' },
    ]);
  });

  it('drops names it did not offer and low-confidence picks', async () => {
    const h = harness();
    h.run('Redesign the settings page please');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    h.finish({ skills: [{ name: 'made-up-skill', reason: 'x' }], confidence: 0.95 });
    h.run('Now deploy the worker to production');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(2));
    h.finish({ skills: [{ name: 'cloudflare', reason: 'deploy' }], confidence: 0.3 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.note).not.toHaveBeenCalled();
    expect(readSkillCompanionState(h.ctx)).toBeUndefined();
  });

  it('never offers a skill the leader already loaded or the user mentioned', async () => {
    const h = harness();
    (h.ctx.messages as unknown[]).push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'k1', name: 'skill', input: { name: 'testing' } }],
    });
    h.run('Fix the settings page, use $cloudflare for deploy');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    const task = h.assignInternal.mock.calls[0]![0].description;
    expect(task).toContain('"frontend-design"');
    expect(task).not.toContain('"testing"');
    expect(task).not.toContain('"cloudflare"');
  });

  it('notes without holding edits when enforcement is off', async () => {
    const h = harness({ enforce: 'off' });
    h.run('Redesign the settings page please');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    h.finish(PICK);
    await vi.waitFor(() => expect(h.note).toHaveBeenCalledTimes(1));
    expect(h.note.mock.calls[0]![2]).not.toContain('held once');
    expect(readSkillCompanionState(h.ctx)).toBeUndefined();
  });

  it('ignores short turns, workers and disabled sessions', async () => {
    const h = harness();
    h.run('continue');
    const worker = leaderCtx('S1');
    (worker.meta as Record<string, unknown>)['agentRole'] = 'reviewer';
    h.run('Review the settings page carefully', worker);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.spawn).not.toHaveBeenCalled();
    h.disable();
    h.run('Redesign the settings page please');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('re-probes when the leader starts editing a new kind of file, within the cap', async () => {
    const h = harness({ maxProbes: 2 });
    h.run('Redesign the settings page please');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    h.finish({ skills: [], confidence: 0 });
    const edit = (path: string) =>
      h.events.emit('tool.executed', {
        sessionId: 'S1',
        id: path,
        name: 'edit',
        ok: true,
        durationMs: 1,
        input: { path },
      } as never);
    edit('wrangler.toml');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(2));
    expect(h.assignInternal.mock.calls[1]![0].description).toContain('"file_family"');
    h.finish({ skills: [], confidence: 0 });
    edit('src/app.test.ts');
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Cap reached: no third judge call.
    expect(h.assignInternal).toHaveBeenCalledTimes(2);
  });

  it('retires a resident that misses the deadline', async () => {
    const h = harness({ timeoutMs: 20 });
    h.run('Redesign the settings page please');
    await vi.waitFor(() => expect(h.terminate).toHaveBeenCalledWith('worker'));
    expect(h.note).not.toHaveBeenCalled();
  });

  it('does not recommend into a context that moved to another conversation', async () => {
    const h = harness();
    h.run('Redesign the settings page please');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    (h.ctx.session as { id: string }).id = 'S2';
    h.finish(PICK);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.note).not.toHaveBeenCalled();
    expect(readSkillCompanionState(h.ctx)).toBeUndefined();
  });
});

describe('Skill Companion policy', () => {
  it('caps budgets and strips tools after project overrides', () => {
    const limited = constrainSkillCompanion({
      id: 'skill-companion-x',
      name: 'Skill Companion',
      role: 'skill-companion',
      tools: ['bash', 'write'],
      maxToolCalls: 500,
      maxCostUsd: 5,
      skillNames: ['testing'],
    });
    expect(limited.tools).toEqual([]);
    expect(limited.sealed).toBe(true);
    expect(limited.skillNames).toEqual([]);
    expect(limited.maxToolCalls).toBe(2);
    expect(limited.maxCostUsd).toBe(0.05);
    expect(isSkillCompanion({ id: 'skill-companion-x', name: 'x', role: 'reviewer' })).toBe(false);
  });

  it('parses fenced answers and keeps only offered names', () => {
    const offered = [
      { name: 'testing', description: '' },
      { name: 'debugging', description: '' },
    ];
    const pick = parseSkillCompanionPick(
      '```json\n{"skills":[{"name":"Testing","reason":"r"},{"name":"other"},{"name":"testing"}],"confidence":2}\n```',
      offered,
    );
    expect(pick).toEqual({ skills: [{ name: 'testing', reason: 'r' }], confidence: 1 });
    expect(parseSkillCompanionPick('no json here', offered)).toBeUndefined();
  });
});
