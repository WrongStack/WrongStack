import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SubagentRunContext, SubagentRunner, TaskSpec } from '@wrongstack/contracts/types';
import { type ArchitectureDecision, ArchitectureDecisionStore } from '@wrongstack/core/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startArchitectureDecisionRefresh,
  withArchitectureDecisions,
} from '../src/architecture-decision-context.js';

describe('external worker architecture context', () => {
  let dir: string;
  let root: string;
  let store: ArchitectureDecisionStore;
  let controller: AbortController;
  const content = {
    title: 'Provider boundary',
    context: 'Keep the core independent.',
    decision: 'Use a provider port.',
    alternatives: [],
    consequences: [],
    constraints: ['Keep implementation imports outside core.'],
    scope: [],
    revisitWhen: '',
  };
  const review = (record: ArchitectureDecision, action: 'accept' | 'deprecate' = 'accept') =>
    store.review(
      {
        projectId: record.projectId,
        id: record.id,
        revision: record.revision,
        contentHash: record.contentHash,
        action,
        reason: 'Reviewed the provider boundary.',
      },
      'user',
    );
  const task: TaskSpec = {
    id: 'external-task',
    description: 'Implement the task',
    context: { file: 'a.ts' },
  };
  const driver = vi.fn<SubagentRunner>();
  const submitted = (index = 0) => {
    const call = driver.mock.calls[index];
    if (!call) throw new Error('No external task was submitted.');
    return call[0];
  };
  const context = () =>
    ({ subagentId: 'external-worker', signal: controller.signal }) as SubagentRunContext;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'external-adr-'));
    vi.stubEnv('WRONGSTACK_HOME', path.join(dir, 'home'));
    root = path.join(dir, 'project');
    store = new ArchitectureDecisionStore(root);
    controller = new AbortController();
    driver.mockReset().mockResolvedValue({ iterations: 1, toolCalls: 0, result: 'done' });
  });
  afterEach(() => {
    controller.abort();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('delivers the same reviewed constraints on each assigned task without mutating the original task', async () => {
    const accepted = review(store.propose(content, 'leader'));
    const run = withArchitectureDecisions(driver, root);
    await run(task, context());
    expect(submitted().description).toContain(accepted.contentHash);
    expect(submitted().description).toContain(content.constraints[0]);
    expect(submitted().context).toEqual(task.context);
    expect(task.description).toBe('Implement the task');
    review(accepted, 'deprecate');
    await run(task, context());
    expect(submitted(1).description).not.toContain(content.decision);
  });

  it('never delivers pending proposals as active decision content', async () => {
    store.propose(content, 'worker');
    await withArchitectureDecisions(driver, root)(task, context());
    expect(submitted().description).not.toContain(content.decision);
  });

  it('injects accepted and retired snapshots once each during a steerable active turn', async () => {
    vi.useFakeTimers();
    await withArchitectureDecisions(driver, root)(task, context());
    const steer = vi.fn().mockResolvedValue('injected');
    const stop = startArchitectureDecisionRefresh({
      projectRoot: root,
      task: submitted(),
      signal: controller.signal,
      steer,
    });
    const accepted = review(store.propose(content, 'leader'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0]?.[0]).toContain(accepted.contentHash);
    await vi.advanceTimersByTimeAsync(5000);
    expect(steer).toHaveBeenCalledTimes(1);
    review(accepted, 'deprecate');
    await vi.advanceTimersByTimeAsync(5000);
    expect(steer.mock.calls[1]?.[0]).toContain('Active decisions: 0');
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not steer for unapproved proposal changes', async () => {
    vi.useFakeTimers();
    await withArchitectureDecisions(driver, root)(task, context());
    const steer = vi.fn().mockResolvedValue('injected');
    startArchitectureDecisionRefresh({
      projectRoot: root,
      task: submitted(),
      signal: controller.signal,
      steer,
    });
    store.propose(content, 'leader');
    await vi.advanceTimersByTimeAsync(15000);
    expect(steer).not.toHaveBeenCalled();
    controller.abort();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a rejected injection without marking that revision delivered', async () => {
    vi.useFakeTimers();
    await withArchitectureDecisions(driver, root)(task, context());
    const steer = vi
      .fn()
      .mockRejectedValueOnce(new Error('Transient transport failure'))
      .mockResolvedValue('injected');
    startArchitectureDecisionRefresh({
      projectRoot: root,
      task: submitted(),
      signal: controller.signal,
      steer,
    });
    review(store.propose(content, 'leader'));
    await vi.advanceTimersByTimeAsync(15000);
    expect(steer).toHaveBeenCalledTimes(2);
  });

  it('stops on unsupported steering and still refreshes the next assigned task', async () => {
    vi.useFakeTimers();
    const run = withArchitectureDecisions(driver, root);
    await run(task, context());
    const steer = vi.fn().mockResolvedValue('unsupported');
    startArchitectureDecisionRefresh({
      projectRoot: root,
      task: submitted(),
      signal: controller.signal,
      steer,
    });
    const accepted = review(store.propose(content, 'leader'));
    await vi.advanceTimersByTimeAsync(15000);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await run({ ...task, id: 'next-task' }, context());
    expect(submitted(1).description).toContain(accepted.contentHash);
  });

  it('never starts an aborted worker', async () => {
    controller.abort();
    await expect(withArchitectureDecisions(driver, root)(task, context())).rejects.toThrow();
    expect(driver).not.toHaveBeenCalled();
  });
});
