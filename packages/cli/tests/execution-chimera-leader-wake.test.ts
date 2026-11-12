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
    persistReview?: (payload: unknown, projectDir: string, maintenance?: unknown) => Promise<void>;
    cwd?: string;
    config?: Record<string, unknown>;
    reviewFiles?: Array<Record<string, unknown>>;
    bundleOverrides?: Record<string, unknown>;
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
    config: (options.config ?? { provider: 'test', model: 'reviewer' }) as never,
    projectDir: options.projectDir ?? 'D:/project-data',
    ...(options.realPersistence
      ? {}
      : { persistReview: options.persistReview ?? vi.fn().mockResolvedValue(undefined) }),
    trackWork: (work) => {
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
          cwd: options.cwd ?? 'D:/repo',
          config: { provider: 'test', model: 'reviewer', autoFix },
          files: options.reviewFiles ?? [
            { path: 'src/a.ts', status: 'modified', content: 'export const a = 1;' },
          ],
          ...options.bundleOverrides,
        },
      );
    },
    wait: () => pending,
  };
}

describe('Chimera passive report integration', () => {
  // Create a real working tree so P0-2 disk verification passes for findings
  // that cite src/a.ts:1. The anchor is the longest meaningful token of the
  // finding's title+description (case-sensitive match), so `line1` must
  // contain that exact token.
  async function verifiableCwd(line1: string): Promise<string> {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'chimera-verify-'));
    await fs.mkdir(path.join(cwd, 'src'), { recursive: true });
    await fs.writeFile(path.join(cwd, 'src', 'a.ts'), `${line1}\n`);
    return cwd;
  }

  const REVIEW_FILES = (content: string) => [{ path: 'src/a.ts', status: 'modified', content }];

  it('publishes an actionable report without waking the session leader', async () => {
    // Longest token of 'Broken guard → Validate before returning.' is
    // 'returning' (9 chars) — line 1 must contain it.
    const cwd = await verifiableCwd('export function returning() { return accepts(); }');
    try {
      const h = harness(
        [
          '### High (1)',
          '1. [BUG] src/a.ts:1 — Broken guard',
          '   The guard accepts invalid state.',
          '   → Validate before returning.',
        ].join('\n'),
        'auto',
        { cwd, reviewFiles: REVIEW_FILES('export function returning() { return accepts(); }') },
      );

      h.emitReview();
      await h.wait();

      expect(h.director.spawn).toHaveBeenCalledTimes(1);
      expect(h.agentRun).not.toHaveBeenCalled();
      expect(h.events.emitCustom).toHaveBeenCalledWith(
        'chimera.report_available',
        expect.objectContaining({
          sessionId: 'session-1',
          hasActionableFindings: true,
          message: expect.stringContaining('No follow-up started'),
        }),
      );
      expect(h.mailbox.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'result',
          body: expect.stringContaining('no leader turn, fix agent, or cascade was started'),
        }),
      );
      expect(h.mailbox.ack).not.toHaveBeenCalled();
      expect(h.session.append).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'llm_response' }),
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
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

  it.each(['ask', 'auto'] as const)(
    'treats legacy %s mode as passive and never starts a leader turn',
    async (mode) => {
      // Longest token of 'Broken guard' is 'Broken' (6 chars) — line 1 must
      // contain it (case-sensitive).
      const cwd = await verifiableCwd('export function Broken() { return true; }');
      try {
        const h = harness('### High (1)\n1. src/a.ts:1 — Broken guard', mode, {
          cwd,
          reviewFiles: REVIEW_FILES('export function Broken() { return true; }'),
        });
        h.emitReview();
        await h.wait();
        expect(h.agentRun).not.toHaveBeenCalled();
        expect(h.mailbox.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'result' }));
        expect(h.events.emitCustom).toHaveBeenCalledWith(
          'chimera.report_available',
          expect.objectContaining({ hasActionableFindings: true }),
        );
      } finally {
        await fs.rm(cwd, { recursive: true, force: true });
      }
    },
  );

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

  // ── Operator store-retention caps are read from config by the CLI ──

  const ALL_CLEAR = '## 🦂 Chimera Review — all clear ✅\n\nNo issues found.';

  async function maintenanceArgFor(extensions: unknown): Promise<Record<string, unknown>> {
    const persistReview = vi.fn().mockResolvedValue(undefined);
    const h = harness(ALL_CLEAR, 'off', {
      persistReview,
      config: { provider: 'test', model: 'reviewer', extensions },
    });
    h.emitReview();
    await vi.waitFor(() => expect(persistReview).toHaveBeenCalledTimes(1));
    return persistReview.mock.calls[0]![2] as Record<string, unknown>;
  }

  it('passes both retention caps read from extensions["wstack-chimera"]', async () => {
    const maintenance = await maintenanceArgFor({
      'wstack-chimera': { openRetentionDays: 45, activeRetentionDays: 30 },
    });
    // Exact object: the CLI owns reading config, core owns interpreting it.
    expect(maintenance).toStrictEqual({ openRetentionDays: 45, activeRetentionDays: 30 });
  });

  it('leaves caps unset when no config exists, so core applies its defaults', async () => {
    expect(await maintenanceArgFor(undefined)).toStrictEqual({
      openRetentionDays: undefined,
      activeRetentionDays: undefined,
    });
  });

  it('ignores malformed retention values instead of forwarding them to core', async () => {
    // A string, a negative number and NaN must not reach the sweep: `0` means
    // "disabled" and a negative cap would evict every non-terminal row.
    expect(
      await maintenanceArgFor({
        'wstack-chimera': { openRetentionDays: '45', activeRetentionDays: -1 },
      }),
    ).toStrictEqual({ openRetentionDays: undefined, activeRetentionDays: undefined });
    expect(
      await maintenanceArgFor({
        'wstack-chimera': { openRetentionDays: Number.NaN, activeRetentionDays: null },
      }),
    ).toStrictEqual({ openRetentionDays: undefined, activeRetentionDays: undefined });
    // 0 is a legitimate operator value (sweep disabled) and must pass through.
    expect(
      await maintenanceArgFor({
        'wstack-chimera': { openRetentionDays: 0, activeRetentionDays: 0 },
      }),
    ).toStrictEqual({ openRetentionDays: 0, activeRetentionDays: 0 });
  });

  it('strips operator-suppressed findings at the execution boundary so they never trigger actionable alerts', async () => {
    const { JsonlFindingStore } = await import('@wrongstack/builtin-plugins');
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chimera-exec-suppress-'));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chimera-exec-repo-'));
    try {
      await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
      const fileContent = 'export const token = "guest-fallback";\n';
      await fs.writeFile(path.join(repoDir, 'src/a.ts'), fileContent, 'utf8');

      const findingStore = new JsonlFindingStore(projectDir);
      await findingStore.upsert(
        [
          {
            id: 'suppressed-1',
            fingerprint: 'fp-suppressed-1',
            severity: 'high',
            source: 'chimera',
            location: { file: 'src/a.ts', line: 1 },
            title: 'Hardcoded guest fallback token',
            description: 'token uses guest-fallback constant',
            createdAt: new Date().toISOString(),
            status: 'active',
            originReport: {
              reportId: 'r-old',
              sessionId: 'session-0',
              agentId: 'chimera-review',
              reviewerModel: 'reviewer',
            },
          },
        ],
        { sessionId: 'session-0', reportId: 'r-old', agentId: 'chimera-review', model: 'reviewer' },
      );
      await findingStore.transition(
        'suppressed-1',
        'ignored',
        { id: 'operator', kind: 'operator' },
        { reason: 'intentional guest fallback' },
      );

      const rawJsonFromLlm = JSON.stringify({
        findings: [
          {
            severity: 'high',
            category: 'security',
            confidence: 'high',
            file: 'src/a.ts',
            line: 1,
            title: 'Hardcoded guest fallback token',
            description: 'token = "guest-fallback" allows guest access',
            suggestedFix: 'Remove fallback',
          },
        ],
      });

      const h = harness(rawJsonFromLlm, 'off', {
        projectDir,
        cwd: repoDir,
        realPersistence: true,
        reviewFiles: [{ path: 'src/a.ts', status: 'modified', content: fileContent }],
      });

      h.emitReview();
      await h.wait();

      expect(h.mailbox.ack).toHaveBeenCalledWith(expect.objectContaining({ completed: true }));
      expect(h.events.emitCustom).toHaveBeenCalledWith(
        'chimera.report_available',
        expect.objectContaining({
          findingCount: 0,
          hasActionableFindings: false,
        }),
      );
      expect(h.events.emitCustom).toHaveBeenCalledWith(
        'chimera.review_complete',
        expect.objectContaining({
          parsedReport: expect.objectContaining({ findings: [] }),
        }),
      );
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('completes docs-only and comment-only automated reviews in 0 LLM tokens without spawning a subagent, unless manualTrigger is set', async () => {
    const persistedPayloads: Array<Record<string, unknown>> = [];
    const autoDocs = harness('{"findings":[]}', 'off', {
      persistReview: async (payload) => {
        persistedPayloads.push(payload as Record<string, unknown>);
      },
      reviewFiles: [{ path: 'docs/architecture.md', status: 'modified', content: '# Notes\n' }],
    });

    autoDocs.emitReview();
    await autoDocs.wait();

    expect(autoDocs.director.spawn).not.toHaveBeenCalled();
    expect(persistedPayloads).toHaveLength(1);
    expect(persistedPayloads[0]).toMatchObject({
      status: 'success',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        iterations: 0,
        toolCalls: 0,
      },
    });
    expect(autoDocs.mailbox.ack).toHaveBeenCalledWith(expect.objectContaining({ completed: true }));
    expect(autoDocs.events.emitCustom).toHaveBeenCalledWith(
      'chimera.report_available',
      expect.objectContaining({
        findingCount: 0,
        hasActionableFindings: false,
        message: expect.stringContaining('0 tokens'),
      }),
    );

    const manualDocs = harness('{"findings":[]}', 'off', {
      reviewFiles: [{ path: 'docs/architecture.md', status: 'modified', content: '# Notes\n' }],
      bundleOverrides: { manualTrigger: true },
    });
    manualDocs.emitReview();
    await manualDocs.wait();
    expect(manualDocs.director.spawn).toHaveBeenCalledTimes(1);
  });

  it('always emits chimera.review_complete when director is missing so auto-review inFlight slots never leak', async () => {
    let reviewHandler: ((event: unknown, payload: unknown) => void) | undefined;
    const events = {
      onPattern: vi.fn((name: string, handler: (event: unknown, payload: unknown) => void) => {
        if (name === 'chimera.review_needed') reviewHandler = handler;
        return () => undefined;
      }),
      emitCustom: vi.fn(),
    };
    const session = { id: 'session-no-dir', append: vi.fn().mockResolvedValue(undefined) };
    installChimeraReviewHandler({
      events: events as never,
      director: null,
      session: session as never,
      mailbox: { send: vi.fn(), ack: vi.fn() } as never,
      agent: { ctx: { activeRunSessionId: undefined, session } } as never,
      config: { provider: 'test', model: 'reviewer' } as never,
      projectDir: 'D:/project-data',
      trackWork: () => undefined,
    });

    const bundle = {
      cwd: 'D:/repo',
      config: { provider: 'test', model: 'reviewer' },
      files: [{ path: 'src/app.ts', status: 'modified', content: 'export const x = 1;\n' }],
    };
    reviewHandler?.('chimera.review_needed', bundle);
    await vi.waitFor(() =>
      expect(events.emitCustom).toHaveBeenCalledWith(
        'chimera.review_complete',
        expect.objectContaining({
          bundle,
          status: 'skipped',
          sessionId: 'session-no-dir',
        }),
      ),
    );
  });
});
