import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { SlashCommandRegistry } from '@wrongstack/core/registry';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGoalCommand } from '../src/slash-commands/goal.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

class FakeRenderer {
  output = '';
  write(s: unknown): void { this.output += typeof s === 'string' ? s : ''; }
  writeLine(s = ''): void { this.output += `${s}\n`; }
  writeBlock(): void {}
  writeToolCall(): void {}
  writeToolResult(): void {}
  writeDiff(): void {}
  writeWarning(): void {}
  writeError(): void {}
  writeInfo(): void {}
  clear(): void { this.output = ''; }
}

function rig(projectRoot: string) {
  const registry = new SlashCommandRegistry();
  const renderer = new FakeRenderer();
  const ctx: Context = {
    messages: [],
    todos: [],
    readFiles: new Set(),
    fileMtimes: new Map(),
    systemPrompt: [],
    model: 'test',
    cwd: projectRoot,
    projectRoot,
    meta: {},
    state: {
      replaceMessages: vi.fn(),
      replaceTodos: vi.fn(),
      deleteMeta: vi.fn(),
    },
  } as never as Context;
  const goalCtx: SlashCommandContext = {
    ...ctx,
    registry,
    renderer: renderer as never as SlashCommandContext['renderer'],
    cwd: projectRoot,
    projectRoot,
    paths: resolveWstackPaths({ projectRoot }),
  } as never as SlashCommandContext;
  const goalCmd = buildGoalCommand(goalCtx);
  registry.register(goalCmd);
  return { registry, renderer, ctx, goalCtx };
}

describe('/goal slash command', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-goal-cli-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('reports no active goal when status is requested without a runner', async () => {
    const { registry, goalCtx } = rig(tmp);
    const result = await registry.dispatch('/goal', goalCtx as never as Context);
    expect(result?.message).toMatch(/No active Goal/i);
  });

  it('/goal start requires onGoalStart to be wired', async () => {
    const { registry, goalCtx } = rig(tmp);
    const result = await registry.dispatch('/goal start build something', goalCtx as never as Context);
    expect(result?.message).toMatch(/not available|❌/i);
  });

  it('/goal start without text shows usage', async () => {
    const { registry, goalCtx } = rig(tmp);
    goalCtx.onGoalStart = vi.fn();
    const result = await registry.dispatch('/goal start', goalCtx as never as Context);
    expect(result?.message).toMatch(/Usage.*\/goal start/i);
  });

  it('/goal start with onGoalStart wired delegates to host', async () => {
    const { registry, goalCtx } = rig(tmp);
    const startSpy = vi.fn().mockResolvedValue({
      ok: true,
      graph: {
        title: 'Test Build',
        phases: new Map(),
        completedPhaseIds: [],
      },
    });
    goalCtx.onGoalStart = startSpy;
    const result = await registry.dispatch('/goal start test project', goalCtx as never as Context);
    expect(startSpy).toHaveBeenCalledOnce();
    expect(result?.message).toContain('Test Build');
    expect(result?.metadata?.goalInit).toBeDefined();
  });

  it('/goal start with host error reports it', async () => {
    const { registry, goalCtx } = rig(tmp);
    goalCtx.onGoalStart = vi.fn().mockResolvedValue({ ok: false, error: 'already in progress' });
    const result = await registry.dispatch('/goal start another', goalCtx as never as Context);
    expect(result?.message).toContain('already in progress');
  });

  it('/goal pause delegates to onGoalPause', async () => {
    const { registry, goalCtx } = rig(tmp);
    const pauseSpy = vi.fn();
    goalCtx.onGoalPause = pauseSpy;
    const result = await registry.dispatch('/goal pause', goalCtx as never as Context);
    expect(pauseSpy).toHaveBeenCalledOnce();
    expect(result?.message).toMatch(/paused/i);
  });

  it('/goal resume delegates to onGoalResume', async () => {
    const { registry, goalCtx } = rig(tmp);
    const resumeSpy = vi.fn();
    goalCtx.onGoalResume = resumeSpy;
    const result = await registry.dispatch('/goal resume', goalCtx as never as Context);
    expect(resumeSpy).toHaveBeenCalledOnce();
    expect(result?.message).toMatch(/resuming/i);
  });

  it('/goal stop delegates to onGoalStop', async () => {
    const { registry, goalCtx } = rig(tmp);
    const stopSpy = vi.fn();
    goalCtx.onGoalStop = stopSpy;
    const result = await registry.dispatch('/goal stop', goalCtx as never as Context);
    expect(stopSpy).toHaveBeenCalledOnce();
    expect(result?.message).toMatch(/stopped/i);
  });

  it('/goal list reports no saved projects', async () => {
    const { registry, goalCtx } = rig(tmp);
    const result = await registry.dispatch('/goal list', goalCtx as never as Context);
    expect(result?.message).toMatch(/No saved projects/i);
  });

  it('unknown subcommand shows available subcommands', async () => {
    const { registry, goalCtx } = rig(tmp);
    const result = await registry.dispatch('/goal frobnicate', goalCtx as never as Context);
    expect(result?.message).toMatch(/Unknown|start|pause|status/i);
  });
});
