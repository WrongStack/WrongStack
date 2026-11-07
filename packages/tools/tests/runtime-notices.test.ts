/**
 * Tools that raise runtime notices for the leader: session_wakeup timers,
 * process_watch output lines, and background bash exits.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { type LeaderDelivery, leaderDeliveryHub } from '@wrongstack/coordination';
import type { Context } from '@wrongstack/core/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bashTool } from '../src/bash.js';
import { getProcessRegistry } from '../src/process-registry.js';
import {
  _resetProcessWatches,
  listProcessWatches,
  processWatchControlTool,
  processWatchTool,
} from '../src/process-watch.js';
import { _resetSessionWakeups, sessionWakeupTool } from '../src/session-wakeup.js';
import { mkSandbox, newSignal, processCleanupDeadline, type Sandbox } from './fixtures.js';
import { runtimeFixtureCommand } from './shell-fixture-command.js';

let seq = 0;
const sandboxes: Sandbox[] = [];

/** A sandbox whose context is a leader of a fresh session. */
async function leaderSandbox(agentId: string | undefined = 'leader') {
  const sb = await mkSandbox();
  sandboxes.push(sb);
  const sessionId = `notice-test-${process.pid}-${++seq}`;
  const ctx = sb.ctx as unknown as { agentId?: string; session: { id: string } };
  if (agentId) ctx.agentId = agentId;
  ctx.session.id = sessionId;
  return { sb, ctx: sb.ctx as Context, sessionId };
}

async function fixture(sb: Sandbox, name: string, source: string): Promise<string> {
  const file = path.join(sb.dir, name);
  await fs.writeFile(file, source);
  return file;
}

function drain(sessionId: string): LeaderDelivery[] {
  return leaderDeliveryHub.take(sessionId, { maxItems: 1_000, maxChars: 10_000_000 });
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

afterEach(async () => {
  vi.useRealTimers();
  _resetSessionWakeups();
  _resetProcessWatches();
  for (const sb of sandboxes.splice(0)) await sb.cleanup().catch(() => undefined);
});

describe('session_wakeup', () => {
  it('delivers the scheduled prompt as a runtime notice when it fires', async () => {
    vi.useFakeTimers();
    const { ctx, sessionId } = await leaderSandbox();
    const out = await sessionWakeupTool.execute(
      { action: 'schedule', delay_s: 600, prompt: 'check the CI run' },
      ctx,
      { signal: newSignal() },
    );
    const id = out.wakeup?.id as string;
    expect(id).toMatch(/^wk-\d+$/);
    expect(leaderDeliveryHub.pending(sessionId)).toBe(0);

    await vi.advanceTimersByTimeAsync(599_000);
    expect(leaderDeliveryHub.pending(sessionId)).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);

    const [item] = drain(sessionId);
    expect(item?.kind).toBe('runtime_notice');
    expect(item?.wake).toBe(true);
    if (item?.kind !== 'runtime_notice') throw new Error('expected a notice');
    expect(item.payload).toMatchObject({ source: 'timer', handle: id });
    expect(item.payload.body).toContain('check the CI run');
    // One-shot: gone after firing.
    const list = await sessionWakeupTool.execute({ action: 'list' }, ctx, { signal: newSignal() });
    expect(list.wakeups).toEqual([]);
  });

  it('does not stack recurring notices the leader has not read yet', async () => {
    vi.useFakeTimers();
    const { ctx, sessionId } = await leaderSandbox();
    const scheduled = await sessionWakeupTool.execute(
      { every_s: 60, prompt: 'poll the deploy' },
      ctx,
      { signal: newSignal() },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(leaderDeliveryHub.pending(sessionId)).toBe(1);
    drain(sessionId);

    await vi.advanceTimersByTimeAsync(60_000);
    const [next] = drain(sessionId);
    if (next?.kind !== 'runtime_notice') throw new Error('expected a notice');
    expect(next.payload.title).toContain('(run 2)');
    expect(next.payload.body).toContain('2 earlier run(s) skipped');

    const cancelled = await sessionWakeupTool.execute({ action: 'cancel', id: 'all' }, ctx, {
      signal: newSignal(),
    });
    expect(cancelled.cancelled).toEqual([scheduled.wakeup?.id]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(leaderDeliveryHub.pending(sessionId)).toBe(0);
  });

  it('refuses invalid input and non-leader callers', async () => {
    const { ctx } = await leaderSandbox();
    const opts = { signal: newSignal() };
    await expect(sessionWakeupTool.execute({ delay_s: 60 }, ctx, opts)).rejects.toThrow(/prompt/);
    await expect(sessionWakeupTool.execute({ prompt: 'x' }, ctx, opts)).rejects.toThrow(/delay_s/);
    await expect(sessionWakeupTool.execute({ prompt: 'x', delay_s: 1 }, ctx, opts)).rejects.toThrow(
      /between/,
    );
    await expect(
      sessionWakeupTool.execute({ prompt: 'x', delay_s: 60, every_s: 5 }, ctx, opts),
    ).rejects.toThrow(/every_s/);

    const worker = await leaderSandbox('worker-1');
    await expect(
      sessionWakeupTool.execute({ prompt: 'x', delay_s: 60 }, worker.ctx, opts),
    ).rejects.toThrow(/only the session leader/);
  });

  it('keeps sessions apart for list and cancel', async () => {
    const a = await leaderSandbox();
    const b = await leaderSandbox();
    const opts = { signal: newSignal() };
    const made = await sessionWakeupTool.execute({ prompt: 'a', delay_s: 600 }, a.ctx, opts);
    const listB = await sessionWakeupTool.execute({ action: 'list' }, b.ctx, opts);
    expect(listB.wakeups).toEqual([]);
    await expect(
      sessionWakeupTool.execute({ action: 'cancel', id: made.wakeup?.id }, b.ctx, opts),
    ).rejects.toThrow(/no wakeup/);
  });
});

describe('process_watch', () => {
  it('delivers matching output lines and the exit, and nothing else', async () => {
    const { sb, ctx, sessionId } = await leaderSandbox();
    const script = await fixture(
      sb,
      'emit.js',
      "for (const l of ['noise 1', 'READY on :5173', 'noise 2', 'ERROR boom']) console.log(l);\n",
    );
    const out = await processWatchTool.execute(
      {
        command: runtimeFixtureCommand(script),
        description: 'dev server state',
        filter: 'READY|ERROR',
      },
      ctx,
      { signal: newSignal() },
    );
    expect(out.watch?.id).toMatch(/^pw-\d+$/);

    const collected: LeaderDelivery[] = [];
    await waitFor(() => {
      collected.push(...drain(sessionId));
      return collected.some(
        (d) => d.kind === 'runtime_notice' && /exited with code 0/.test(d.payload.title),
      )
        ? true
        : undefined;
    });
    const bodies = collected
      .flatMap((d) => (d.kind === 'runtime_notice' ? [d.payload.body ?? ''] : []))
      .join('\n');
    expect(bodies).toContain('READY on :5173');
    expect(bodies).toContain('ERROR boom');
    expect(bodies).not.toContain('noise');
    expect(listProcessWatches(sessionId)).toEqual([]);
  });

  it(
    'stops on request without a closing notice',
    async () => {
      const { sb, ctx, sessionId } = await leaderSandbox();
      const script = await fixture(sb, 'tick.js', "setInterval(() => console.log('tick'), 50);\n");
      const out = await processWatchTool.execute(
        { command: runtimeFixtureCommand(script), description: 'ticks', filter: 'never-matches' },
        ctx,
        { signal: newSignal() },
      );
      const pid = out.watch?.pid as number;
      const stopped = await processWatchControlTool.execute(
        { action: 'stop', id: out.watch?.id },
        ctx,
        { signal: newSignal() },
      );
      expect(stopped.stopped).toEqual([out.watch?.id]);
      expect(listProcessWatches(sessionId)).toEqual([]);
      // Windows tree-kill (taskkill /T) can take its whole budget on a loaded host.
      await waitFor(
        () => (getProcessRegistry().get(pid) === undefined ? true : undefined),
        processCleanupDeadline(10_000),
      );
      await new Promise((r) => setTimeout(r, 300));
      expect(drain(sessionId)).toEqual([]);
    },
    processCleanupDeadline(10_000) + 10_000,
  );

  it('rejects an invalid filter and a non-leader caller', async () => {
    const { ctx } = await leaderSandbox();
    const opts = { signal: newSignal() };
    await expect(
      processWatchTool.execute({ command: 'echo hi', description: 'x', filter: '(' }, ctx, opts),
    ).rejects.toThrow(/regular expression/);
    const worker = await leaderSandbox('worker-1');
    await expect(
      processWatchTool.execute({ command: 'echo hi', description: 'x' }, worker.ctx, opts),
    ).rejects.toThrow(/only the session leader/);
  });
});

describe('background bash exit notice', () => {
  it('reports the exit code and the last log lines to the leader', async () => {
    const { sb, ctx, sessionId } = await leaderSandbox();
    const script = await fixture(
      sb,
      'bg.js',
      "console.log('bg-line-1'); console.log('bg-line-2'); process.exitCode = 3;\n",
    );
    const out = await bashTool.execute(
      { command: runtimeFixtureCommand(script), background: true },
      ctx,
      { signal: newSignal() },
    );
    expect(out.output).toContain('[RUNTIME NOTICE]');
    const item = await waitFor(() => drain(sessionId)[0]);
    if (item.kind !== 'runtime_notice') throw new Error('expected a notice');
    expect(item.payload.source).toBe('process');
    expect(item.payload.handle).toBe(String(out.pid));
    expect(item.payload.title).toContain('exited with code 3');
    expect(item.payload.body).toContain('bg-line-2');
    expect(item.wake).toBe(true);
  });

  it('stays silent with notify_on_exit: false and for a non-leader', async () => {
    for (const [agentId, notify] of [
      ['leader', false],
      ['worker-1', undefined],
    ] as const) {
      const { sb, ctx, sessionId } = await leaderSandbox(agentId);
      const script = await fixture(sb, 'quiet.js', "console.log('quiet');\n");
      const out = await bashTool.execute(
        {
          command: runtimeFixtureCommand(script),
          background: true,
          ...(notify === undefined ? {} : { notify_on_exit: notify }),
        },
        ctx,
        { signal: newSignal() },
      );
      expect(out.output).not.toContain('[RUNTIME NOTICE]');
      await waitFor(() =>
        getProcessRegistry()
          .recentlyEnded()
          .some((p) => p.pid === out.pid)
          ? true
          : undefined,
      );
      await new Promise((r) => setTimeout(r, 300));
      expect(drain(sessionId)).toEqual([]);
    }
  });
});
