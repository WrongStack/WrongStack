import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { filterOperatorSuppressedFindings } from '../src/review-finding-integration.js';
import { parseChimeraReviewReport } from '../src/review-finding-parser.js';
import { JsonlFindingStore } from '../src/review-finding-store.js';
import {
  createChimeraFollowupExtension,
  extractChimeraFollowupOutcomes,
  extractChimeraReportIdFromPrompt,
  reconcileChimeraFollowupOutcomes,
  resolveChimeraFollowupBriefing,
} from '../src/review-followup-briefing.js';
import { JsonlReportStore } from '../src/review-report-store.js';

describe('extractChimeraReportIdFromPrompt', () => {
  it('extracts report IDs across WebUI, Desktop-v2, and natural user prompts', () => {
    expect(
      extractChimeraReportIdFromPrompt(
        'Take a look at the tasks mentioned in this Chimera report (f47ac10b-58cc-4372-a567-0e02b2c3d479) — review the findings it flagged for this session and address them.',
      ),
    ).toBe('f47ac10b-58cc-4372-a567-0e02b2c3d479');

    expect(
      extractChimeraReportIdFromPrompt(
        'Review Chimera report "review-card-42" for this conversation. Read its current findings, citation verification and activity.',
      ),
    ).toBe('review-card-42');

    expect(extractChimeraReportIdFromPrompt('Please fix chimera report #f47ac10b right away')).toBe(
      'f47ac10b',
    );
  });

  it('ignores slash commands and unrelated prose mentioning chimera report', () => {
    expect(extractChimeraReportIdFromPrompt('/review report f47ac10b')).toBeUndefined();
    expect(
      extractChimeraReportIdFromPrompt('Why did the chimera report fail yesterday?'),
    ).toBeUndefined();
    expect(extractChimeraReportIdFromPrompt('')).toBeUndefined();
  });
});

describe('resolveChimeraFollowupBriefing & createChimeraFollowupExtension', () => {
  let rootDir: string;
  let cwdDir: string;
  let projectDir: string;

  beforeEach(async () => {
    rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chimera-briefing-'));
    cwdDir = path.join(rootDir, 'workspace');
    projectDir = path.join(rootDir, 'project-store');
    await fsp.mkdir(path.join(cwdDir, 'src'), { recursive: true });
    await fsp.mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  it('pre-loads open findings with 1-based disk context, transitions open->actioned, detects drift, and blocks path traversal', async () => {
    const reportId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const authCode = [
      'export function verifyToken(token: string) {',
      '  if (!token) return false;',
      '  return token === "hardcoded-dev-token";',
      '}',
      '',
    ].join('\n');
    await fsp.writeFile(path.join(cwdDir, 'src', 'auth.ts'), authCode, 'utf8');
    // Outside-workspace secret that must NEVER be read even if a finding cites ../secret.txt
    await fsp.writeFile(path.join(rootDir, 'secret.txt'), 'SUPER_SECRET_KEY=12345\n', 'utf8');

    const sha = createHash('sha256').update(authCode).digest('hex');
    const reportStore = new JsonlReportStore(projectDir);
    await reportStore.persist({
      id: reportId,
      sessionId: 'sess-1',
      agentId: 'chimera-review',
      reviewerModel: 'anthropic/claude-sonnet-4-6',
      source: 'chimera-session',
      reviewStatus: 'success',
      files: [{ path: 'src/auth.ts', status: 'modified' }],
      counts: { critical: 0, high: 2, medium: 0, low: 0 },
      totalFindings: 2,
      unparseableCount: 0,
      rawText: '## 🦂 Chimera Review',
      scopeManifest: {
        headSha: 'abc1234',
        files: [{ path: 'src/auth.ts', status: 'modified', sha256: sha }],
      },
    });

    const parsed = parseChimeraReviewReport(
      JSON.stringify({
        findings: [
          {
            severity: 'high',
            category: 'security',
            file: 'src/auth.ts',
            line: 3,
            title: 'Hardcoded dev token bypass',
            description: 'verifyToken compares against a hardcoded literal.',
            suggestedFix: 'Verify against a cryptographic HMAC or session store.',
          },
          {
            severity: 'high',
            category: 'security',
            file: '../secret.txt',
            line: 1,
            title: 'Out-of-workspace traversal probe',
            description: 'Must never read outside workspace.',
          },
        ],
      }),
      {
        sessionId: 'sess-1',
        agentId: 'chimera-review',
        reviewerModel: 'anthropic/claude-sonnet-4-6',
        reviewType: 'chimera-session',
        reportId,
      },
    );
    parsed.findings[0]!.verification = { status: 'verified', matchedLine: 3 };

    const findingStore = new JsonlFindingStore(projectDir);
    await findingStore.upsert(parsed.findings, {
      sessionId: 'sess-1',
      reportId,
      agentId: 'chimera-review',
      model: 'anthropic/claude-sonnet-4-6',
    });

    const res = await resolveChimeraFollowupBriefing(
      `Take a look at the tasks mentioned in this Chimera report (${reportId}) — review the findings it flagged for this session and address them.`,
      { projectDir, cwd: cwdDir },
    );

    expect(res).not.toBeNull();
    expect(res!.reportId).toBe(reportId);
    expect(res!.actionableCount).toBe(2);
    expect(res!.transitionedToActioned).toBe(true);
    expect(res!.briefingText).toContain(`<chimera-report-briefing reportId="${reportId}">`);
    expect(res!.briefingText).toContain('diskDrift=current');
    expect(res!.briefingText).toContain('[HIGH/security]');
    expect(res!.briefingText).toContain(
      '[disk:verified] src/auth.ts:3 — Hardcoded dev token bypass',
    );
    expect(res!.briefingText).toContain('>   3 |   return token === "hardcoded-dev-token";');
    // Traversal path outside cwd must never leak file contents
    expect(res!.briefingText).not.toContain('SUPER_SECRET_KEY');

    const updatedReport = await reportStore.get(reportId);
    expect(updatedReport?.lifecycle).toBe('actioned');

    // Modify disk file -> subsequent short-prefix lookup reports STALE drift
    await fsp.writeFile(
      path.join(cwdDir, 'src', 'auth.ts'),
      authCode.replace('"hardcoded-dev-token"', 'process.env.TOKEN'),
      'utf8',
    );
    const drifted = await resolveChimeraFollowupBriefing('fix chimera report f47ac10b', {
      projectDir,
      cwd: cwdDir,
    });
    expect(drifted?.briefingText).toContain('diskDrift=STALE (src/auth.ts (modified))');
  });

  it('folds the briefing into Iteration 0 user message for leader runs and skips Chimera reviewer runs', async () => {
    const reportId = '11223344-5566-7788-99aa-bbccddeeff00';
    const reportStore = new JsonlReportStore(projectDir);
    await reportStore.persist({
      id: reportId,
      sessionId: 'sess-2',
      agentId: 'chimera-review',
      reviewerModel: 'anthropic/claude-sonnet-4-6',
      source: 'chimera-session',
      reviewStatus: 'success',
      files: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
      totalFindings: 0,
      unparseableCount: 0,
      rawText: '## 🦂 Chimera Review — All Clear',
    });

    const ext = createChimeraFollowupExtension({
      getCwd: () => cwdDir,
      getProjectDir: () => projectDir,
    });

    const appendBlockToLastUserMessage = vi.fn(() => true);
    const leaderCtx = {
      cwd: cwdDir,
      projectRoot: cwdDir,
      meta: {},
      state: { appendBlockToLastUserMessage },
    } as never;

    await ext.beforeRun?.(leaderCtx, {
      text: `Review Chimera report "${reportId}" for this conversation.`,
      content: [],
      ctx: leaderCtx,
    });
    await ext.beforeIteration?.(leaderCtx, 0);
    expect(appendBlockToLastUserMessage).toHaveBeenCalledTimes(1);
    expect(appendBlockToLastUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining(`<chimera-report-briefing reportId="${reportId}">`),
      }),
    );

    // Iteration 1 must NOT re-inject the briefing
    await ext.beforeIteration?.(leaderCtx, 1);
    expect(appendBlockToLastUserMessage).toHaveBeenCalledTimes(1);

    // Ephemeral Chimera reviewer must NEVER get briefed
    const reviewerAppend = vi.fn(() => true);
    const reviewerCtx = {
      cwd: cwdDir,
      projectRoot: cwdDir,
      meta: { isChimeraReviewer: true },
      state: { appendBlockToLastUserMessage: reviewerAppend },
    } as never;
    await ext.beforeRun?.(reviewerCtx, {
      text: `Review Chimera report "${reportId}" for this conversation.`,
      content: [],
      ctx: reviewerCtx,
    });
    await ext.beforeIteration?.(reviewerCtx, 0);
    expect(reviewerAppend).not.toHaveBeenCalled();
  });

  it('parses structured chimera_outcomes blocks and downgrades agent wontfix to deferred', () => {
    expect(extractChimeraFollowupOutcomes('No JSON block here')).toBeNull();

    const parsed = extractChimeraFollowupOutcomes(
      [
        'Fixed the auth bug and checked the second item.',
        '```json',
        '{"unrelated": true}',
        '```',
        '```json',
        JSON.stringify({
          chimera_outcomes: [
            { id: '12345678', outcome: 'fixed', reason: 'Replaced literal with HMAC check' },
            { id: '87654321', outcome: 'wontfix', reason: 'Needs product signoff' },
          ],
        }),
        '```',
      ].join('\n'),
    );

    expect(parsed).toEqual([
      { id: '12345678', outcome: 'fixed', reason: 'Replaced literal with HMAC check' },
      { id: '87654321', outcome: 'deferred', reason: 'Needs product signoff' },
    ]);
  });

  it('steers once on unverified edits and missing outcomes, then reconciles verified fixes & completes the report on afterRun', async () => {
    const reportId = 'aabbccdd-1122-3344-5566-77889900aabb';
    const initialCode = 'export const check = (x: string) => x === "bad";\n';
    const authFile = path.join(cwdDir, 'src', 'auth.ts');
    await fsp.writeFile(authFile, initialCode, 'utf8');
    const initialSha = createHash('sha256').update(initialCode).digest('hex');

    const reportStore = new JsonlReportStore(projectDir);
    await reportStore.persist({
      id: reportId,
      sessionId: 'sess-followup',
      agentId: 'chimera-review',
      reviewerModel: 'anthropic/claude-sonnet-4-6',
      source: 'chimera-session',
      reviewStatus: 'success',
      files: [{ path: 'src/auth.ts', status: 'modified' }],
      counts: { critical: 0, high: 1, medium: 1, low: 0 },
      totalFindings: 2,
      unparseableCount: 0,
      rawText: '## 🦂 Chimera Review',
      scopeManifest: {
        headSha: 'deadbeef',
        files: [{ path: 'src/auth.ts', status: 'modified', sha256: initialSha }],
      },
    });

    const parsed = parseChimeraReviewReport(
      JSON.stringify({
        findings: [
          {
            severity: 'high',
            category: 'security',
            file: 'src/auth.ts',
            line: 1,
            title: 'Insecure literal comparison',
            description: 'Uses static string literal.',
          },
          {
            severity: 'medium',
            category: 'style',
            file: 'src/auth.ts',
            line: 1,
            title: 'Arrow export style nit',
            description: 'False alarm.',
          },
        ],
      }),
      {
        sessionId: 'sess-followup',
        agentId: 'chimera-review',
        reviewerModel: 'anthropic/claude-sonnet-4-6',
        reviewType: 'chimera-session',
        reportId,
      },
    );
    const findingStore = new JsonlFindingStore(projectDir);
    await findingStore.upsert(parsed.findings, {
      sessionId: 'sess-followup',
      reportId,
      agentId: 'chimera-review',
      model: 'anthropic/claude-sonnet-4-6',
    });

    const [f1, f2] = parsed.findings;
    const emittedEvents: Array<{ name: string; payload: unknown }> = [];
    const ext = createChimeraFollowupExtension({
      getCwd: () => cwdDir,
      getProjectDir: () => projectDir,
      events: {
        emitCustom: (name, payload) => {
          emittedEvents.push({ name, payload });
        },
      },
    });

    const messages: Array<Record<string, unknown>> = [];
    const writtenFiles = new Set<string>();
    const ctx = {
      cwd: cwdDir,
      projectRoot: cwdDir,
      meta: {},
      tools: [{ name: 'edit' }, { name: 'bash' }],
      messages,
      writtenFiles,
      state: { appendBlockToLastUserMessage: vi.fn(() => true) },
    } as never;

    await ext.beforeRun?.(ctx, {
      text: `Take a look at the tasks mentioned in this Chimera report (${reportId}) — review the findings it flagged for this session and address them.`,
      content: [],
      ctx,
    });
    expect(emittedEvents).toContainEqual({
      name: 'chimera.report.updated',
      payload: { reportId, lifecycle: 'actioned', success: true },
    });

    // Simulate file edit on disk + edit tool execution
    await fsp.writeFile(authFile, 'export const check = (x: string) => verifyHmac(x);\n', 'utf8');
    writtenFiles.add(authFile);
    await ext.afterToolExecution?.(ctx, [
      {
        tool: { name: 'edit' } as never,
        settlement: 'completed',
        result: { tool_use_id: 'tu-edit', content: 'Updated src/auth.ts' },
      } as never,
    ]);

    // Failing test run must NOT count as passing verification
    messages.push({
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu-test-fail', name: 'bash', input: { command: 'bun run test' } },
      ],
    });
    await ext.afterToolExecution?.(ctx, [
      {
        tool: { name: 'bash' } as never,
        settlement: 'completed',
        result: { tool_use_id: 'tu-test-fail', content: '1 failed\nExit code: 1' },
      } as never,
    ]);
    messages.push({ role: 'assistant', content: 'Done fixing!' });

    // 1st beforeTurnEnd: steers to run real verification checks
    const steer1 = await ext.beforeTurnEnd?.(ctx);
    expect(steer1).toContain('have not run verification checks since the last edit');

    // Simulate passing test run, still omitting chimera_outcomes JSON
    messages.push({
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu-test-pass', name: 'bash', input: { command: 'bun run test' } },
      ],
    });
    await ext.afterToolExecution?.(ctx, [
      {
        tool: { name: 'bash' } as never,
        settlement: 'completed',
        result: { tool_use_id: 'tu-test-pass', content: 'All tests passed\nExit code: 0' },
      } as never,
    ]);
    messages.push({ role: 'assistant', content: 'All tests pass now!' });

    // 2nd beforeTurnEnd: steers once for missing chimera_outcomes JSON
    const steer2 = await ext.beforeTurnEnd?.(ctx);
    expect(steer2).toContain('chimera_outcomes');

    // Never loops infinitely if model still omits JSON on the retry
    const steer3 = await ext.beforeTurnEnd?.(ctx);
    expect(steer3).toBeUndefined();

    // Final response includes chimera_outcomes -> afterRun reconciles store + completes report
    const finalText = [
      'Addressed all items and verified with `bun run test`.',
      '```json',
      JSON.stringify({
        chimera_outcomes: [
          { id: f1!.id.slice(0, 8), outcome: 'fixed', reason: 'Switched to verifyHmac' },
          {
            id: f2!.id.slice(0, 8),
            outcome: 'false_positive',
            reason: 'Intentional project convention',
          },
        ],
      }),
      '```',
    ].join('\n');

    await ext.afterRun?.(ctx, {
      status: 'done',
      finalText,
      iterations: 3,
      toolCalls: 3,
      usage: { input: 1000, output: 200 },
    } as never);

    const updatedF1 = await findingStore.get(f1!.id);
    const updatedF2 = await findingStore.get(f2!.id);
    expect(updatedF1?.status).toBe('resolved');
    expect(updatedF1?.resolution?.outcome).toBe('fixed');
    expect(updatedF1?.resolution?.resolvedBy).toBe('leader');
    expect(updatedF2?.status).toBe('resolved');
    expect(updatedF2?.resolution?.outcome).toBe('false_positive');

    const completedReport = await reportStore.get(reportId);
    expect(completedReport?.lifecycle).toBe('completed');
    expect(emittedEvents).toContainEqual({
      name: 'chimera.report.updated',
      payload: { reportId, lifecycle: 'completed', success: true },
    });

    // Leader-resolved false_positive must NOT permanently blind future Chimera reviews,
    // whereas an explicit operator suppression DOES suppress future re-triggers.
    const stillAllowedForLeader = await filterOperatorSuppressedFindings([f2!], projectDir);
    expect(stillAllowedForLeader.findings).toHaveLength(1);
    expect(stillAllowedForLeader.suppressedCount).toBe(0);

    const fOp = parseChimeraReviewReport(
      JSON.stringify({
        findings: [
          {
            severity: 'low',
            category: 'style',
            file: 'src/other.ts',
            line: 5,
            title: 'Operator silenced nit',
            description: 'Explicitly silenced by operator.',
          },
        ],
      }),
      {
        sessionId: 'sess-followup',
        agentId: 'chimera-review',
        reviewerModel: 'anthropic/claude-sonnet-4-6',
        reviewType: 'chimera-session',
        reportId,
      },
    ).findings[0]!;
    await findingStore.upsert([fOp], {
      sessionId: 'sess-followup',
      reportId,
      agentId: 'chimera-review',
      model: 'anthropic/claude-sonnet-4-6',
    });
    await findingStore.transition(
      fOp.id,
      'resolved',
      { id: 'operator', kind: 'user' },
      { outcome: 'false_positive', reason: 'Confirmed by human' },
    );
    const suppressedByOperator = await filterOperatorSuppressedFindings([fOp], projectDir);
    expect(suppressedByOperator.findings).toHaveLength(0);
    expect(suppressedByOperator.suppressedCount).toBe(1);
  });

  it('honesty guard rejects fixed claims when disk SHA-256 is unchanged or edits were unverified', async () => {
    const reportId = 'deadbeef-0000-4444-8888-ffffffffffff';
    const unchangedCode = 'export const token = "still-broken";\n';
    await fsp.writeFile(path.join(cwdDir, 'src', 'broken.ts'), unchangedCode, 'utf8');
    const baselineSha = createHash('sha256').update(unchangedCode).digest('hex');

    const reportStore = new JsonlReportStore(projectDir);
    await reportStore.persist({
      id: reportId,
      sessionId: 'sess-honesty',
      agentId: 'chimera-review',
      reviewerModel: 'anthropic/claude-sonnet-4-6',
      source: 'chimera-session',
      reviewStatus: 'success',
      files: [{ path: 'src/broken.ts', status: 'modified' }],
      counts: { critical: 0, high: 1, medium: 0, low: 0 },
      totalFindings: 1,
      unparseableCount: 0,
      rawText: '## 🦂 Chimera Review',
      scopeManifest: {
        files: [{ path: 'src/broken.ts', status: 'modified', sha256: baselineSha }],
      },
    });

    const finding = parseChimeraReviewReport(
      JSON.stringify({
        findings: [
          {
            severity: 'high',
            category: 'bug',
            file: 'src/broken.ts',
            line: 1,
            title: 'Broken token constant',
            description: 'Still broken on disk.',
          },
        ],
      }),
      {
        sessionId: 'sess-honesty',
        agentId: 'chimera-review',
        reviewerModel: 'anthropic/claude-sonnet-4-6',
        reviewType: 'chimera-session',
        reportId,
      },
    ).findings[0]!;

    const findingStore = new JsonlFindingStore(projectDir);
    await findingStore.upsert([finding], {
      sessionId: 'sess-honesty',
      reportId,
      agentId: 'chimera-review',
      model: 'anthropic/claude-sonnet-4-6',
    });

    // Disk SHA matches baseline -> fixed claim rejected
    const resUnchanged = await reconcileChimeraFollowupOutcomes({
      reportId,
      projectDir,
      cwd: cwdDir,
      outcomes: [{ id: finding.id, outcome: 'fixed', reason: 'Claimed fixed without editing' }],
      reviewedFileHashes: { 'src/broken.ts': baselineSha },
      editedInRun: false,
      verifiedAfterEdit: true,
    });
    expect(resUnchanged.resolvedCount).toBe(0);
    expect(resUnchanged.rejectedUnverifiedCount).toBe(1);
    expect((await findingStore.get(finding.id))?.status).toBe('active');

    // Disk modified, but verifiedAfterEdit is false -> fixed claim still rejected
    await fsp.writeFile(
      path.join(cwdDir, 'src', 'broken.ts'),
      'export const token = "fixed";\n',
      'utf8',
    );
    const resUnverified = await reconcileChimeraFollowupOutcomes({
      reportId,
      projectDir,
      cwd: cwdDir,
      outcomes: [{ id: finding.id, outcome: 'fixed', reason: 'Edited without running tests' }],
      reviewedFileHashes: { 'src/broken.ts': baselineSha },
      editedInRun: true,
      verifiedAfterEdit: false,
    });
    expect(resUnverified.resolvedCount).toBe(0);
    expect(resUnverified.rejectedUnverifiedCount).toBe(1);
    expect((await findingStore.get(finding.id))?.status).toBe('active');
  });
});
