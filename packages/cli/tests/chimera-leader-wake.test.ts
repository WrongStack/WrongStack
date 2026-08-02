import { describe, expect, it, vi } from 'vitest';
import {
  buildChimeraLeaderWakePrompt,
  type ChimeraLeaderWakeAgent,
  type ChimeraLeaderWakeRequest,
  chimeraLeaderWakeKey,
  createChimeraLeaderWakeQueue,
  shouldWakeChimeraLeader,
} from '../src/chimera-leader-wake.js';

function request(overrides: Partial<ChimeraLeaderWakeRequest> = {}): ChimeraLeaderWakeRequest {
  return {
    sessionId: 'session-1',
    cwd: 'D:\\repo',
    changedFiles: ['src/a.ts'],
    structuredReport: '[HIGH] src/a.ts:7 - broken guard',
    ...overrides,
  };
}

function agent(run = vi.fn()): ChimeraLeaderWakeAgent {
  return {
    ctx: {},
    run: run.mockResolvedValue({ status: 'done', iterations: 2, finalText: 'fixed' }),
  } as ChimeraLeaderWakeAgent;
}

describe('chimera leader wake queue', () => {
  it('deduplicates the same review and runs the leader once', async () => {
    const run = vi.fn();
    const events = { emitCustom: vi.fn() };
    const queue = createChimeraLeaderWakeQueue({ agent: agent(run), events });

    const first = queue.enqueue(request());
    const second = queue.enqueue(request());

    await expect(first).resolves.toMatchObject({ status: 'done', finalText: 'fixed' });
    await expect(second).resolves.toMatchObject({ status: 'done', finalText: 'fixed' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(events.emitCustom).toHaveBeenCalledWith(
      'chimera.leader_wake_started',
      expect.objectContaining({ sessionId: 'session-1', fileCount: 1 }),
    );
    expect(events.emitCustom).toHaveBeenCalledWith(
      'chimera.leader_wake_completed',
      expect.objectContaining({ status: 'done', iterations: 2 }),
    );
  });

  it('waits until the current leader turn releases its pinned session', async () => {
    const run = vi.fn();
    const wakeAgent = agent(run);
    wakeAgent.ctx.activeRunSessionId = 'session-1';
    const queue = createChimeraLeaderWakeQueue({
      agent: wakeAgent,
      events: { emitCustom: vi.fn() },
      idlePollMs: 5,
    });

    const work = queue.enqueue(request());
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(run).not.toHaveBeenCalled();

    wakeAgent.ctx.activeRunSessionId = undefined;
    await work;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('serializes different reports through the same leader', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const run = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstGate;
        return { status: 'done', iterations: 1, finalText: 'first' };
      })
      .mockResolvedValueOnce({ status: 'done', iterations: 1, finalText: 'second' });
    const queue = createChimeraLeaderWakeQueue({
      agent: agent(run),
      events: { emitCustom: vi.fn() },
    });

    const first = queue.enqueue(request({ reportId: 'report-1' }));
    const second = queue.enqueue(request({ reportId: 'report-2' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not inject a stale report after the host switched sessions', async () => {
    const run = vi.fn();
    const wakeAgent = agent(run);
    wakeAgent.ctx.session = { id: 'session-2' };
    const events = { emitCustom: vi.fn() };
    const queue = createChimeraLeaderWakeQueue({ agent: wakeAgent, events });

    await expect(queue.enqueue(request({ sessionId: 'session-1' }))).resolves.toMatchObject({
      status: 'aborted',
      iterations: 0,
    });
    expect(run).not.toHaveBeenCalled();
    expect(events.emitCustom).toHaveBeenCalledWith(
      'chimera.leader_wake_skipped',
      expect.objectContaining({
        sessionId: 'session-1',
        currentSessionId: 'session-2',
        reason: 'session_changed',
      }),
    );
  });

  it('builds a scoped system follow-up instead of replaying mailbox prose', () => {
    const prompt = buildChimeraLeaderWakePrompt(
      request({ reportId: 'report-42', changedFiles: ['src/a.ts', 'src/b.ts'] }),
    );

    expect(prompt).toContain('Resume the leader workflow automatically');
    expect(prompt).toContain('Review reference: report-42');
    expect(prompt).toContain('Only edit files listed under Changed files');
    expect(prompt).toContain('- src/a.ts');
    expect(prompt).toContain('- src/b.ts');
  });

  it('uses report ids when available and deterministic content keys otherwise', () => {
    expect(chimeraLeaderWakeKey(request({ reportId: ' report-7 ' }))).toBe('report:report-7');
    expect(chimeraLeaderWakeKey(request())).toBe(chimeraLeaderWakeKey(request()));
    expect(chimeraLeaderWakeKey(request())).not.toBe(
      chimeraLeaderWakeKey(request({ structuredReport: '[LOW] different' })),
    );
  });

  it('wakes only for actionable auto-approved work', () => {
    expect(
      shouldWakeChimeraLeader({
        autoFix: 'auto',
        hasActionableFindings: true,
        leaderApproved: false,
        reviewLength: 20,
      }),
    ).toBe(true);
    expect(
      shouldWakeChimeraLeader({
        autoFix: 'ask',
        hasActionableFindings: true,
        leaderApproved: true,
        reviewLength: 20,
      }),
    ).toBe(true);

    for (const input of [
      {
        autoFix: 'off' as const,
        hasActionableFindings: true,
        leaderApproved: true,
        reviewLength: 20,
      },
      {
        autoFix: 'ask' as const,
        hasActionableFindings: true,
        leaderApproved: false,
        reviewLength: 20,
      },
      {
        autoFix: 'auto' as const,
        hasActionableFindings: false,
        leaderApproved: false,
        reviewLength: 20,
      },
      {
        autoFix: 'auto' as const,
        hasActionableFindings: true,
        leaderApproved: false,
        reviewLength: 0,
      },
    ]) {
      expect(shouldWakeChimeraLeader(input)).toBe(false);
    }
  });
});
