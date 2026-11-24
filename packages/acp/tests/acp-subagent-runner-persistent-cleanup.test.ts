import type { SubagentRunContext, TaskSpec } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';

/**
 * F106: in persistent mode the runner calls sessionSetup EVERY turn (each
 * call can acquire a fresh resource — the WrongStack bridge acquires an HTTP
 * gateway grant whose cleanup revokes it), but only the FIRST setup's cleanup
 * was retained (sharedCleanup, revoked at stop). Turn 2+ cleanups were
 * silently dropped: one leaked grant per turn for the process lifetime.
 * One-shot mode revokes each turn's setup in its finally; persistent mode
 * must revoke the unadopted per-turn setups too (the first grant lives with
 * the shared session because its MCP servers serve every turn).
 *
 * ACPSession is mocked (external dependency — no child processes); the
 * runner's setup/cleanup lifecycle is the unit under test.
 */
vi.mock('../src/client/acp-session.js', () => {
  class ACPSessionError extends Error {
    readonly kind = 'unknown';
  }
  class ACPSession {
    prompt = vi.fn(async () => ({
      text: 'ok',
      stopReason: 'end_turn',
      hasText: true,
      toolCalls: [],
      diffs: [],
      thoughts: '',
    }));
    close = vi.fn(async () => {});
    canSteer = vi.fn(() => false);
    steer = vi.fn(async () => 'injected');
    getAgentInfo = vi.fn(() => undefined);
    static start = vi.fn(async () => new ACPSession());
  }
  return {
    ACPSession,
    ACPSessionError,
    textContent: (t: string) => ({ type: 'text', text: t }),
  };
});

import { makeACPSubagentRunnerWithStop } from '../src/integration/acp-subagent-runner.js';

const task = { description: 'do it' } as unknown as TaskSpec;
const ctx = {
  budget: { recordUsage: () => {}, markActivity: () => {} },
  signal: new AbortController().signal,
  config: {},
  subagentId: 'worker-1',
  sessionId: 's1',
} as unknown as SubagentRunContext;

describe('persistent mode revokes unadopted per-turn setups (F106)', () => {
  it('calls every turn cleanup exactly once across two turns and stop', async () => {
    const revoked: number[] = [];
    let issued = 0;
    const { runner, stop } = await makeACPSubagentRunnerWithStop({
      command: 'fake-agent',
      persistent: true,
      sessionSetup: () => {
        const id = ++issued;
        return { cleanup: () => void revoked.push(id) };
      },
    });
    await runner(task, ctx);
    await runner(task, ctx);
    // Turn 2's grant was never adopted into the shared session: it must be
    // revoked after the turn, not leaked.
    expect(revoked, 'turn-2 cleanup ran after its turn').toEqual([2]);
    await stop();
    expect([...revoked].sort(), 'first grant revoked at stop; no double revoke').toEqual([1, 2]);
  });

  it('does not double-revoke a caller that caches one setup object', async () => {
    const revoked: number[] = [];
    const cached = { cleanup: () => void revoked.push(1) };
    const { runner, stop } = await makeACPSubagentRunnerWithStop({
      command: 'fake-agent',
      persistent: true,
      sessionSetup: () => cached,
    });
    await runner(task, ctx);
    await runner(task, ctx);
    await stop();
    expect(revoked).toEqual([1]);
  });

  it('one-shot mode still revokes each turn setup (control)', async () => {
    const revoked: number[] = [];
    let issued = 0;
    const { runner } = await makeACPSubagentRunnerWithStop({
      command: 'fake-agent',
      sessionSetup: () => {
        const id = ++issued;
        return { cleanup: () => void revoked.push(id) };
      },
    });
    await runner(task, ctx);
    await runner(task, ctx);
    expect(revoked).toEqual([1, 2]);
  });
});
