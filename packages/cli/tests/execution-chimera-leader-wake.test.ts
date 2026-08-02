import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { installChimeraReviewHandler } from '../src/execution-chimera-review.js';

function harness(
  reviewText: string,
  autoFix: 'off' | 'ask' | 'auto' = 'auto',
  options: {
    projectDir?: string;
    realPersistence?: boolean;
    persistReview?: (payload: unknown, projectDir: string) => Promise<void>;
  } = {},
) {
  let reviewHandler: ((event: unknown, payload: unknown) => void) | undefined;
  let pending: Promise<void> | undefined;
  const events = {
    onPattern: vi.fn((name: string, handler: (event: unknown, payload: unknown) => void) => {
      if (name === 'chimera.review_needed') reviewHandler = handler;
      return () => undefined;
    }),
    emitCustom: vi.fn(),
  };
  const director = {
    spawn: vi.fn().mockResolvedValue('reviewer-1'),
    assign: vi.fn().mockResolvedValue(undefined),
    awaitTasks: vi.fn().mockResolvedValue([
      {
        subagentId: 'reviewer-1',
        taskId: 'task-1',
        status: 'success',
        result: reviewText,
        iterations: 1,
        toolCalls: 1,
        durationMs: 1,
      },
    ]),
    terminate: vi.fn().mockResolvedValue(undefined),
  };
  const session = {
    id: 'session-1',
    append: vi.fn().mockResolvedValue(undefined),
  };
  const agentRun = vi.fn().mockResolvedValue({
    status: 'done',
    iterations: 2,
    finalText: 'Leader fixed and verified the findings.',
  });
  const agent = {
    ctx: {
      activeRunSessionId: undefined,
      meta: { chimeraAutoFix: autoFix },
      session,
    },
    run: agentRun,
  };
  const mailbox = {
    send: vi.fn().mockResolvedValue({ id: 'mail-1' }),
    ack: vi.fn().mockResolvedValue({ id: 'mail-1', completed: true }),
    getOnlineAgents: vi.fn().mockResolvedValue([]),
  };

  installChimeraReviewHandler({
    events: events as never,
    director: director as never,
    session: session as never,
    mailbox: mailbox as never,
    agent: agent as never,
    config: { provider: 'test', model: 'reviewer' } as never,
    projectDir: options.projectDir ?? 'D:/project-data',
    ...(options.realPersistence
      ? {}
      : { persistReview: options.persistReview ?? vi.fn().mockResolvedValue(undefined) }),
    setPendingWork: (work) => {
      pending = work;
    },
  });

  return {
    events,
    director,
    session,
    agentRun,
    mailbox,
    emitReview() {
      reviewHandler?.(
        {},
        {
          cwd: 'D:/repo',
          config: { provider: 'test', model: 'reviewer', autoFix },
          files: [{ path: 'src/a.ts', status: 'modified', content: 'export const a = 1;' }],
        },
      );
    },
    wait: () => pending,
  };
}

describe('Chimera leader wake integration', () => {
  it('routes actionable auto-fix work back through the session leader', async () => {
    const h = harness(
      [
        '### High (1)',
        '1. [BUG] src/a.ts:1 — Broken guard',
        '   The guard accepts invalid state.',
        '   → Validate before returning.',
      ].join('\n'),
    );

    h.emitReview();
    await h.wait();

    expect(h.director.spawn).toHaveBeenCalledTimes(1);
    expect(h.agentRun).toHaveBeenCalledTimes(1);
    expect(h.agentRun.mock.calls[0]?.[0]?.[0]?.text).toContain(
      'Resume the leader workflow automatically',
    );
    expect(h.agentRun.mock.calls[0]?.[0]?.[0]?.text).toContain('[HIGH] src/a.ts:1');
    expect(h.events.emitCustom).toHaveBeenCalledWith(
      'chimera.leader_wake_completed',
      expect.objectContaining({ sessionId: 'session-1', status: 'done' }),
    );
    expect(h.mailbox.ack).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'mail-1',
        completed: true,
        outcome: expect.stringContaining('Leader resumed automatically'),
      }),
    );
  });

  it('does not wake the leader for an all-clear or review-only mode', async () => {
    const allClear = harness('## 🦂 Chimera Review — all clear ✅\n\nNo issues found.');
    allClear.emitReview();
    await allClear.wait();
    expect(allClear.agentRun).not.toHaveBeenCalled();
    expect(allClear.mailbox.ack).toHaveBeenCalledWith({
      messageId: 'mail-1',
      readerId: 'chimera',
      completed: true,
      outcome: 'Review completed with no actionable findings.',
    });

    const reviewOnly = harness('### High (1)\n1. src/a.ts:1 — Broken guard', 'off');
    reviewOnly.emitReview();
    await reviewOnly.wait();
    expect(reviewOnly.agentRun).not.toHaveBeenCalled();
    expect(reviewOnly.mailbox.ack).not.toHaveBeenCalled();
  });

  it('persists reports and findings when the optional Chimera plugin is not installed', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chimera-execution-owner-'));
    try {
      const h = harness(
        [
          '### High (1)',
          '1. [BUG] src/a.ts:1 — Broken guard',
          '   The guard accepts invalid state.',
          '   → Validate before returning.',
        ].join('\n'),
        'off',
        { projectDir, realPersistence: true },
      );

      h.emitReview();
      await h.wait();

      const reportLines = (await fs.readFile(path.join(projectDir, 'review-reports.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const findingLines = (
        await fs.readFile(path.join(projectDir, 'review-findings.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(reportLines.some((line) => line['__report'] === 1)).toBe(true);
      expect(findingLines.some((line) => line['__finding'] === 1)).toBe(true);
      expect(h.events.emitCustom).toHaveBeenCalledWith(
        'chimera.review_persisted',
        expect.objectContaining({ sessionId: 'session-1', cwd: 'D:/repo' }),
      );
      expect(h.events.emitCustom).toHaveBeenCalledWith(
        'chimera.review_complete',
        expect.objectContaining({ reportId: expect.any(String) }),
      );
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('keeps completion inside pending Chimera work until persistence finishes', async () => {
    let releasePersistence: (() => void) | undefined;
    const persistReview = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releasePersistence = resolve;
        }),
    );
    const h = harness('## 🦂 Chimera Review — all clear ✅\n\nNo issues found.', 'off', {
      persistReview,
    });

    h.emitReview();
    await vi.waitFor(() => expect(persistReview).toHaveBeenCalledTimes(1));
    expect(h.events.emitCustom).not.toHaveBeenCalledWith(
      'chimera.review_complete',
      expect.anything(),
    );

    releasePersistence?.();
    await h.wait();
    expect(h.events.emitCustom).toHaveBeenCalledWith(
      'chimera.review_complete',
      expect.objectContaining({ reportId: expect.any(String) }),
    );
  });
});
