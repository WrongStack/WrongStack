/**
 * HQ visual smoke (e2e, opt-in) — boots the real HQ server, feeds it a fake
 * client with a rich session (markdown + thinking + tool cards + telemetry +
 * brain/worktree events), then drives the built `@wrongstack/webui-hq` panel
 * with Playwright and screenshots every view.
 *
 * Opt-in: runs only with `WSTACK_E2E=1` (needs the webui-hq dist built and a
 * Playwright chromium). Screenshots land in `<tmp>/wrongstack-hq-smoke/`.
 *
 *   WSTACK_E2E=1 pnpm vitest run packages/cli/tests/hq-visual-smoke.test.ts
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HQ_PROTOCOL_VERSION } from '@wrongstack/core/hq';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';
import { resolveHqDistDir } from '../src/hq-static-serve.js';

const E2E = process.env.WSTACK_E2E === '1';

describe.skipIf(!E2E)('HQ visual smoke (WSTACK_E2E=1)', () => {
  it('renders every view of the built panel with live data', { timeout: 120_000 }, async () => {
    expect(
      resolveHqDistDir(),
      'webui-hq dist must be built (pnpm --filter @wrongstack/webui-hq build)',
    ).not.toBeNull();

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-smoke-data-'));
    fs.writeFileSync(
      path.join(dataDir, 'auth.json'),
      JSON.stringify({ updatedAt: new Date().toISOString(), browserTokens: [], clientTokens: [] }),
    );

    let handle: HqServerHandle | null = null;
    let ws: WebSocket | null = null;
    let browser: import('@playwright/test').Browser | null = null;
    try {
      handle = await startHqServer({ port: 34_997, dataDir });
      ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
      await new Promise<void>((res, rej) => {
        ws!.on('open', () => res());
        ws!.on('error', rej);
      });

      const now = () => new Date().toISOString();
      let seq = 0;
      const send = (obj: unknown) => ws!.send(JSON.stringify(obj));
      const event = (type: string, payload: unknown, extra: Record<string, unknown> = {}) =>
        send({
          type: 'client.event',
          event: {
            id: `evt-${++seq}`,
            type,
            schemaVersion: HQ_PROTOCOL_VERSION,
            timestamp: now(),
            clientId: 'smoke-client',
            projectId: 'proj-smoke',
            seq,
            payload,
            ...extra,
          },
        });

      send({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'smoke-client',
            kind: 'tui',
            machineId: 'machine-smoke',
            hostname: 'DEVBOX-01',
            pid: 4242,
            startedAt: now(),
          },
          project: {
            projectId: 'proj-smoke',
            projectRoot: 'D:/dev/WrongStack',
            projectName: 'WrongStack',
            machineId: 'machine-smoke',
            gitBranch: 'main',
            workspaceKind: 'git',
          },
          capabilities: ['telemetry.publish', 'session.summary', 'control.receive'],
          redactionPolicy: { rawContent: true, toolArgs: 'summary', paths: 'project-relative' },
        },
      });
      await new Promise((r) => setTimeout(r, 300));

      const SESSION = 'smoke-session-0001';
      event(
        'session.snapshot',
        {
          sessionId: SESSION,
          clientKind: 'tui',
          machineId: 'machine-smoke',
          hostname: 'DEVBOX-01',
          pid: 4242,
          projectId: 'proj-smoke',
          projectName: 'WrongStack',
          projectRoot: 'D:/dev/WrongStack',
          gitBranch: 'main',
          status: 'active',
          startedAt: now(),
          lastActivityAt: now(),
          agentCount: 2,
          agents: [
            {
              id: 'leader',
              name: 'leader',
              status: 'running',
              iterations: 7,
              toolCalls: 23,
              lastActivityAt: now(),
              currentTool: 'bash',
              costUsd: 0.4321,
              tokensIn: 182_000,
              tokensOut: 24_500,
              ctxPct: 38,
              model: 'claude-fable-5',
            },
            {
              id: 'sub-1',
              name: 'bug-hunter',
              status: 'idle',
              iterations: 3,
              toolCalls: 9,
              lastActivityAt: now(),
              costUsd: 0.101,
              ctxPct: 12,
              model: 'claude-haiku-4-5',
            },
          ],
        },
        { sessionId: SESSION },
      );

      const entries = [
        {
          ts: now(),
          role: 'user',
          text: 'Fix the failing auth tests and show me a summary table.',
        },
        {
          ts: now(),
          role: 'thinking',
          text: 'The auth tests probably fail because the token clock skews.\nLet me read the test first.',
        },
        {
          ts: now(),
          role: 'assistant',
          text: 'Looking at the failures now. Plan:\n\n1. Read the failing test\n2. Fix the skew window\n\n| test | status |\n| --- | --- |\n| auth/login | fail |\n| auth/refresh | fail |\n\n```ts\nconst SKEW_MS = 30_000; // widen\n```',
        },
        {
          ts: now(),
          role: 'tool',
          tool: 'read',
          toolInput: JSON.stringify({ file_path: 'src/auth/token.ts', offset: 10, limit: 4 }),
          text: '10→const SKEW_MS = 5_000;\n11→export function verify(t: Token) {\n12→  return t.exp + SKEW_MS > Date.now();\n13→}',
          toolUseId: 'tu-read-1',
          durationMs: 12,
        },
        {
          ts: now(),
          role: 'tool',
          tool: 'edit',
          toolInput: JSON.stringify({
            file_path: 'src/auth/token.ts',
            old_string: 'const SKEW_MS = 5_000;',
            new_string: 'const SKEW_MS = 30_000;',
          }),
          text: 'ok',
          toolUseId: 'tu-edit-1',
          durationMs: 45,
        },
        {
          ts: now(),
          role: 'tool',
          tool: 'TodoWrite',
          toolInput: JSON.stringify({
            todos: [
              { status: 'completed', content: 'Read failing test' },
              { status: 'in_progress', content: 'Fix skew window' },
              { status: 'pending', content: 'Re-run test suite' },
            ],
          }),
          text: '',
          toolUseId: 'tu-todo-1',
        },
        {
          ts: now(),
          role: 'tool',
          tool: 'bash',
          toolInput: JSON.stringify({ command: 'pnpm vitest run tests/auth' }),
          text: '',
          toolUseId: 'tu-bash-1',
        },
      ];
      event(
        'session.transcript',
        { sessionId: SESSION, fromSeq: 0, entries },
        { sessionId: SESSION },
      );

      await new Promise((r) => setTimeout(r, 250));
      event(
        'session.transcript',
        {
          sessionId: SESSION,
          fromSeq: entries.length,
          entries: [
            {
              ts: now(),
              role: 'tool',
              tool: '↳ result',
              text: ' OK tests/auth/login.test.ts (4)\n OK tests/auth/refresh.test.ts (3)\n\nexit code: 0',
              toolUseId: 'tu-bash-1',
              durationMs: 8123,
            },
          ],
        },
        { sessionId: SESSION },
      );

      for (let i = 0; i < 6; i++) {
        event(
          'session.usage',
          {
            sessionId: SESSION,
            agentId: 'leader',
            model: 'claude-fable-5',
            inputTokens: 12_000 + i * 900,
            outputTokens: 2_000 + i * 120,
            costUsd: 0.02 + i * 0.005,
            at: now(),
          },
          { sessionId: SESSION },
        );
      }

      event('brain.event', {
        kind: 'decision_requested',
        source: 'director',
        risk: 'medium',
        question: 'Merge worktree phase-2 into main despite 1 flaky test?',
        at: now(),
      });
      event('brain.event', {
        kind: 'decision_answered',
        source: 'director',
        decision: 'proceed',
        detail: 'Flake is the known CI timer flake; safe to merge.',
        at: now(),
      });
      event('worktree.event', {
        kind: 'allocated',
        ownerId: 'phase-2',
        branch: 'ws/phase-2',
        at: now(),
      });
      event('worktree.event', {
        kind: 'committed',
        ownerId: 'phase-2',
        branch: 'ws/phase-2',
        insertions: 120,
        deletions: 30,
        files: 6,
        sha: 'abc1234def',
        at: now(),
      });

      // Mailbox snapshot so the Mailbox view has content.
      event('mailbox.snapshot', {
        mailboxId: 'proj-smoke:mailbox',
        scope: 'project',
        agents: [
          {
            agentId: 'leader',
            name: 'leader',
            sessionId: SESSION,
            status: 'running',
            iterations: 7,
            toolCalls: 23,
            lastActivityAt: now(),
            lastSeenAt: now(),
            online: true,
          },
          {
            agentId: 'sub-1',
            name: 'bug-hunter',
            sessionId: SESSION,
            status: 'idle',
            iterations: 3,
            toolCalls: 9,
            lastActivityAt: now(),
            lastSeenAt: now(),
            online: false,
          },
        ],
        messages: [
          {
            mailId: 'mail-1',
            messageId: 'msg-1',
            from: 'operator',
            to: 'leader',
            type: 'note',
            subject: 'Prioritize the auth fix',
            priority: 'high',
            timestamp: now(),
            completed: false,
            hasBody: true,
            bodyPreview: 'Ship the skew-window change before anything else.',
          },
          {
            mailId: 'mail-2',
            messageId: 'msg-2',
            from: 'bug-hunter',
            to: 'leader',
            type: 'note',
            subject: 'Found a flaky timer test',
            priority: 'normal',
            timestamp: now(),
            completed: true,
            hasBody: true,
            bodyPreview: 'tests/ci/timer.test.ts flakes under load — known pattern.',
          },
        ],
        totals: { messages: 2, unread: 1, incomplete: 1, highPriority: 1, onlineAgents: 1 },
      });

      // Message content flows through mailbox.event envelopes (the snapshot
      // only carries counters into the aggregate view).
      event('mailbox.event', {
        mailboxId: 'proj-smoke:mailbox',
        action: 'message.sent',
        message: {
          mailId: 'mail-1',
          messageId: 'msg-1',
          from: 'operator',
          to: 'leader',
          type: 'steer',
          subject: 'Prioritize the auth fix',
          priority: 'high',
          timestamp: now(),
          completed: false,
          hasBody: true,
          bodyPreview: 'Ship the skew-window change before anything else.',
        },
      });
      event('mailbox.event', {
        mailboxId: 'proj-smoke:mailbox',
        action: 'message.completed',
        message: {
          mailId: 'mail-2',
          messageId: 'msg-2',
          from: 'bug-hunter',
          to: 'leader',
          type: 'note',
          subject: 'Found a flaky timer test',
          priority: 'normal',
          timestamp: now(),
          completed: true,
          hasBody: true,
          bodyPreview: 'tests/ci/timer.test.ts flakes under load — known pattern.',
        },
      });

      await new Promise((r) => setTimeout(r, 700));

      const { chromium } = await import('@playwright/test');
      browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`http://127.0.0.1:${handle.port}/`);
      await page.waitForSelector('.hq-nav');

      const shots = path.join(os.tmpdir(), 'wrongstack-hq-smoke');
      fs.mkdirSync(shots, { recursive: true });
      const shoot = async (tab: string | null, name: string) => {
        if (tab !== null) {
          await page.click(`.hq-tab:has-text("${tab}")`);
          await page.waitForTimeout(600);
        }
        await page.screenshot({ path: path.join(shots, `${name}.png`) });
      };

      await page.waitForTimeout(1000);
      await shoot(null, '01-cockpit');
      await shoot('Fleet', '02-fleet');
      // Clicking the session tree node must land in the Console with the transcript.
      await page.click('.hq-tree-node');
      await page.waitForTimeout(900);
      await expect
        .poll(async () => page.locator('.hq-tool-head').count(), { timeout: 10_000 })
        .toBeGreaterThanOrEqual(4);
      await page.screenshot({ path: path.join(shots, '03-console-collapsed.png') });

      // Expand thinking + every tool card; the bash card must show the merged
      // exit-code result (live merge path) and the edit card a real diff.
      for (const h of await page.locator('.hq-thinking-head, .hq-tool-head').all()) {
        await h.click().catch(() => {});
      }
      await page.waitForTimeout(500);
      expect(await page.locator('.hq-diff-line.add').count()).toBeGreaterThan(0);
      expect(await page.locator('.hq-result-exit').textContent()).toContain('exit code 0');
      expect(await page.locator('.hq-todo').count()).toBe(3);
      expect(await page.locator('.hq-md-code-lang').first().textContent()).toBe('ts');
      await page.screenshot({ path: path.join(shots, '04-console-expanded.png') });

      await shoot('Brain', '05-brain');
      expect(await page.locator('.hq-card').count()).toBeGreaterThan(0);
      await shoot('Worktrees', '06-worktrees');
      await shoot('Cost', '07-cost');
      await shoot('Trends', '08-trends');
      await shoot('Control', '09-control');
      // Mailbox: the default mode is the live event feed (empty here — we only
      // seeded a snapshot); the snapshot renders in grouped-by-project mode.
      await shoot('Mailbox', '10-mailbox');
      expect(await page.locator('.hq-msg').count()).toBeGreaterThan(0);
      await shoot('Alerts', '11-alerts');

      // eslint-disable-next-line no-console
      console.log(`HQ smoke screenshots: ${shots}`);
    } finally {
      await browser?.close().catch(() => {});
      ws?.close();
      await handle?.close().catch(() => {});
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
