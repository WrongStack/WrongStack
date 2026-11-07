import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlReportStore } from '@wrongstack/builtin-plugins';
import { Container, EventBus, Pipeline } from '@wrongstack/contracts/kernel';
import type { Config, Logger, SessionWriter } from '@wrongstack/contracts/types';
import type { Director } from '@wrongstack/coordination';
import type { Agent, AgentPipelines } from '@wrongstack/core/agent';
import { ExtensionRegistry } from '@wrongstack/core/extension';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailboxProjectServerConnection } from '../../coordination/src/mailbox-project-server-client.js';
import {
  removeProjectFixtureDirectory,
  waitForProcessExit,
} from '../../core/tests/helpers/project-server-harness.js';
import { createStandaloneChimera } from '../src/server/standalone-chimera.js';

let root: string;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ws-chimera-host-'));
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'Fixture'],
    ['config', 'user.email', 'fixture@example.invalid'],
  ])
    execFileSync('git', args, { cwd: root });
  await writeFile(join(root, 'answer.ts'), 'export const answer = 1;\n');
  execFileSync('git', ['add', 'answer.ts'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  const control = new MailboxProjectServerConnection(join(root, '.wrongstack'));
  try {
    const stopped = await control.shutdown('chimera-fixture-complete');
    if (stopped.pid) await waitForProcessExit(stopped.pid);
  } finally {
    control.close();
  }
  await removeProjectFixtureDirectory(root);
});

function harness(overrides: Partial<Config> = {}) {
  const events = new EventBus();
  const notices: Array<{ event: string; payload: Record<string, unknown> }> = [];
  events.onPattern('chimera.*', (event, payload) =>
    notices.push({ event, payload: payload as Record<string, unknown> }),
  );
  const logger: Logger = {
    level: 'info',
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  const director = {
    spawn: vi.fn().mockResolvedValue('reviewer'),
    assign: vi.fn().mockResolvedValue(undefined),
    awaitTasks: vi.fn().mockResolvedValue([
      {
        subagentId: 'reviewer',
        taskId: 'review',
        status: 'success',
        result: '## 🦂 Chimera Review — ALL CLEAR\nNo actionable findings.',
        iterations: 1,
        toolCalls: 0,
        durationMs: 1,
      },
    ]),
    terminate: vi.fn().mockResolvedValue(undefined),
  };
  const config = {
    provider: 'fixture',
    model: 'review',
    features: { plugins: true },
    extensions: {
      'wstack-auto-review': { enabled: true, debounceMs: 0, cascadeOn: 'high' },
      'wstack-chimera': { enabled: false },
    },
    ...overrides,
  } as Config;
  const host = createStandaloneChimera({
    container: new Container(),
    events,
    pipelines: Object.fromEntries(
      ['request', 'response', 'toolCall', 'userInput', 'assistantOutput', 'contextWindow'].map(
        (key) => [key, new Pipeline()],
      ),
    ) as unknown as AgentPipelines,
    toolRegistry: new ToolRegistry(),
    providerRegistry: new ProviderRegistry(),
    modelsRegistry: {} as never,
    getConfig: () => config,
    projectDir: join(root, '.wrongstack'),
    cwd: root,
    logger,
    ensureDirector: vi.fn(async () => director as unknown as Director),
  });
  cleanups.push(() => host.dispose());
  const agent = (id: string) => {
    const session = {
      id,
      transcriptPath: join(root, id + '.jsonl'),
      append: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    } as unknown as SessionWriter;
    const value = {
      ctx: {
        session,
        activeRunSessionId: id,
        cwd: root,
        model: 'review',
        meta: {},
        agentId: 'leader',
      },
      extensions: new ExtensionRegistry(),
    } as unknown as Agent;
    host.attach(value);
    return value;
  };
  const start = async (a: Agent) =>
    a.extensions.runBeforeRun(a.ctx, { text: 'fixture', content: [], ctx: a.ctx });
  const iteration = (a: Agent) =>
    events.emit('iteration.completed', { ctx: a.ctx, iterationIndex: 0 } as never);
  return { host, events, director, agent, start, iteration, notices, config };
}

async function change() {
  await writeFile(join(root, 'answer.ts'), 'export const answer = 2;\n');
}

describe('standalone Chimera producer ownership', () => {
  it('runs canonical producers, persists before availability, and uses a read-only session-bound reviewer', async () => {
    const h = harness();
    const a = h.agent('tab-a');
    await h.start(a);
    await change();
    h.iteration(a);
    await vi.waitFor(
      () => expect(h.notices.some((n) => n.event === 'chimera.report_available')).toBe(true),
      { timeout: 15000 },
    );
    const notice = h.notices.find((n) => n.event === 'chimera.report_available')!;
    const report = await new JsonlReportStore(join(root, '.wrongstack')).get(
      String(notice.payload.reportId),
    );
    expect(report).toMatchObject({
      sessionId: 'tab-a',
      reviewStatus: 'success',
      rawText: expect.stringContaining('ALL CLEAR'),
    });
    expect(h.director.spawn).toHaveBeenCalledTimes(1);
    expect(h.director.spawn.mock.calls[0]?.[0]).toMatchObject({
      name: 'chimera-review',
      originSessionId: 'tab-a',
      allowedCapabilities: ['fs.read'],
      worktree: 'off',
      tools: expect.arrayContaining(['read', 'grep']),
    });
    expect(await readFile(join(root, 'answer.ts'), 'utf8')).toBe('export const answer = 2;\n');
    await h.host.dispose();
    // Canonical post-session policy may review settled content again; every
    // spawned worker remains a reviewer, never a fix/cascade worker.
    expect(h.director.spawn.mock.calls.every(([config]) => config.name === 'chimera-review')).toBe(
      true,
    );
    expect(a.extensions.has('standalone-chimera-owner')).toBe(false);
  });

  it.each([
    { features: { plugins: false } },
    { plugins: [{ name: 'wstack-auto-review', enabled: false }] },
    {
      extensions: {
        'wstack-auto-review': { enabled: false },
        'wstack-chimera': { enabled: false },
      },
    },
  ])('honors plugin enablement: %j', async (overrides) => {
    const h = harness(overrides as Partial<Config>);
    const a = h.agent('disabled');
    await h.start(a);
    await change();
    h.iteration(a);
    await h.host.dispose();
    expect(h.director.spawn).not.toHaveBeenCalled();
    expect(h.notices.some((n) => n.event === 'chimera.report_available')).toBe(false);
  });

  it('ignores reviewer iterations and keeps a delayed report bound to the originating session', async () => {
    const h = harness();
    const a = h.agent('tab-a');
    await h.start(a);
    await change();
    h.iteration({ ctx: { ...a.ctx } } as Agent);
    // Only the registered leader context reaches the producer.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.director.spawn).not.toHaveBeenCalled();
    await writeFile(join(root, 'answer.ts'), 'export const answer = 3;\n');
    h.iteration(a);
    const b = h.agent('tab-b');
    await h.start(b);
    await vi.waitFor(
      () => expect(h.notices.some((n) => n.event === 'chimera.report_available')).toBe(true),
      { timeout: 15000 },
    );
    expect(h.notices.find((n) => n.event === 'chimera.report_available')?.payload.sessionId).toBe(
      'tab-a',
    );
    expect(h.director.spawn).toHaveBeenCalledTimes(1);
  });

  it('joins a quiet-window post-session review before returning from session end', async () => {
    const h = harness({
      extensions: {
        'wstack-auto-review': { enabled: true, debounceMs: 15000, cascadeOn: 'off' },
        'wstack-chimera': { enabled: false },
      },
    } as Partial<Config>);
    const a = h.agent('closing');
    await h.start(a);
    await change();
    h.iteration(a);
    await h.host.finish('closing');
    expect(h.director.spawn).toHaveBeenCalledTimes(1);
    expect(h.notices.find((n) => n.event === 'chimera.report_available')?.payload.sessionId).toBe(
      'closing',
    );
  });

  it('leaves actionable findings passive even with cascade configured', async () => {
    const h = harness();
    h.director.awaitTasks.mockResolvedValue([
      {
        subagentId: 'reviewer',
        taskId: 'review',
        status: 'success',
        result:
          '### High (1)\n1. [BUG] answer.ts:1 — Wrong answer\n   → Verify answer before returning.',
        iterations: 1,
        toolCalls: 0,
        durationMs: 1,
      },
    ]);
    const a = h.agent('findings');
    await h.start(a);
    await change();
    h.iteration(a);
    await vi.waitFor(
      () => expect(h.notices.some((n) => n.event === 'chimera.report_available')).toBe(true),
      { timeout: 15000 },
    );
    expect(h.director.spawn).toHaveBeenCalledTimes(1);
    await h.host.dispose();
    expect(h.director.spawn.mock.calls.every(([config]) => config.name === 'chimera-review')).toBe(
      true,
    );
    expect(h.notices.some((n) => n.event === 'chimera.cascade_needed')).toBe(false);
  });

  it('keeps the next leader turn independent from an unfinished background reviewer', async () => {
    const h = harness();
    const a = h.agent('background');
    let complete!: () => void;
    const reviewing = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const result = {
      subagentId: 'reviewer',
      taskId: 'review',
      status: 'success',
      result: '## 🦂 Chimera Review — ALL CLEAR',
      iterations: 1,
      toolCalls: 0,
      durationMs: 1,
    };
    h.director.awaitTasks.mockImplementation(async () => {
      await reviewing;
      return [result];
    });
    try {
      await h.start(a);
      await change();
      h.iteration(a);
      await vi.waitFor(() => expect(h.director.spawn).toHaveBeenCalledTimes(1), { timeout: 15000 });
      const baseline = h.start(a).then(() => 'baseline');
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('blocked'), 5000);
      });
      try {
        expect(await Promise.race([baseline, timeout])).toBe('baseline');
      } finally {
        clearTimeout(timer!);
      }
    } finally {
      complete();
    }
  });

  it('captures the run-pinned journal when the displayed session has already changed', async () => {
    const h = harness();
    h.director.spawn.mockRejectedValue(new Error('fixture reviewer unavailable'));
    const a = h.agent('origin');
    const original = a.ctx.session;
    a.ctx.activeRunSessionWriter = original;
    const other = h.agent('displayed').ctx.session;
    a.ctx.session = other;
    await h.start(a);
    await change();
    h.iteration(a);
    await vi.waitFor(() => expect(original.append).toHaveBeenCalled(), { timeout: 15000 });
    expect(other.append).not.toHaveBeenCalled();
  });

  it('does not start reviews for a settings-only engine that never ran a leader', async () => {
    const h = harness();
    h.agent('settings');
    await change();
    await h.host.dispose();
    expect(h.director.spawn).not.toHaveBeenCalled();
  });
});
