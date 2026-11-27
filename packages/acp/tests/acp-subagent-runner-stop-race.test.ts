import type { SubagentRunContext, TaskSpec } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';

const { startSpy, closeSpy, promptSpy } = vi.hoisted(() => ({
  startSpy: vi.fn(),
  closeSpy: vi.fn(async () => {}),
  promptSpy: vi.fn(async () => ({
    text: 'ok',
    stopReason: 'end_turn',
    hasText: true,
    toolCalls: [],
    diffs: [],
    thoughts: '',
  })),
}));

vi.mock('../src/client/acp-session.js', () => {
  class ACPSessionError extends Error {
    readonly kind = 'closed';
  }
  class ACPSession {
    prompt = promptSpy;
    close = closeSpy;
    canSteer = vi.fn(() => false);
    steer = vi.fn(async () => 'injected');
    getAgentInfo = vi.fn(() => undefined);
    getSessionId = vi.fn(() => 's-1');
    static start = startSpy.mockImplementation(async () => new ACPSession());
  }
  return {
    ACPSession,
    ACPSessionError,
    textContent: (t: string) => ({ type: 'text', text: t }),
  };
});

import { makeACPSubagentRunnerWithStop } from '../src/integration/acp-subagent-runner.js';

const task = { id: 't1', description: 'do it' } as unknown as TaskSpec;
const ctx = {
  budget: { recordUsage: () => {}, markActivity: () => {} },
  signal: new AbortController().signal,
  config: {},
  subagentId: 'worker-1',
  sessionId: 's1',
} as unknown as SubagentRunContext;

describe('makeACPSubagentRunnerWithStop stop() during sessionSetup (F2707)', () => {
  it('revokes setup and does not spawn ACPSession when stop() fires during sessionSetup', async () => {
    startSpy.mockClear();
    closeSpy.mockClear();
    promptSpy.mockClear();

    let setupCleaned = 0;
    let releaseSetup!: () => void;
    let markSetupEntered!: () => void;
    const setupEntered = new Promise<void>((resolve) => {
      markSetupEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });

    const { runner, stop } = await makeACPSubagentRunnerWithStop({
      command: 'fake-agent',
      persistent: true,
      sessionSetup: async () => {
        markSetupEntered();
        await gate;
        return {
          cleanup: () => {
            setupCleaned += 1;
          },
        };
      },
    });

    const runPromise = runner(task, ctx).catch((err) => err);
    await setupEntered;
    await stop();
    releaseSetup();
    const err = await runPromise;

    expect(err).toBeDefined();
    expect(startSpy).not.toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
    expect(setupCleaned).toBe(1);
  });
});
