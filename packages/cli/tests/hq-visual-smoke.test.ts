/// <reference lib="dom" />
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
    // `version` is mandatory — `readHqAuthFile` throws on anything else, which
    // used to fail this test before the browser even launched.
    fs.writeFileSync(
      path.join(dataDir, 'auth.json'),
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        browserTokens: [],
        clientTokens: [],
      }),
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
        at: Date.now(),
      });
      event('brain.event', {
        kind: 'decision_answered',
        source: 'director',
        decision: 'proceed',
        detail: 'Flake is the known CI timer flake; safe to merge.',
        at: Date.now(),
      });
      // `handleId` is required by the worktree payload schema, and there is no
      // `at` field on it — an envelope missing the former is dropped server-side
      // and the Worktrees view stays empty.
      event('worktree.event', {
        kind: 'allocated',
        handleId: 'wt-phase-2',
        ownerId: 'phase-2',
        ownerLabel: 'phase-2',
        branch: 'ws/phase-2',
        baseBranch: 'main',
      });
      event('worktree.event', {
        kind: 'committed',
        handleId: 'wt-phase-2',
        ownerId: 'phase-2',
        ownerLabel: 'phase-2',
        branch: 'ws/phase-2',
        insertions: 120,
        deletions: 30,
        files: 6,
        sha: 'abc1234def',
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
      type Locator = ReturnType<import('@playwright/test').Page['locator']>;
      browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      // The HQ server sends a strict CSP (script-src 'self' 'wasm-unsafe-eval').
      // A violation surfaces here as a console error and nowhere else, so the
      // whole run collects them and asserts at the end.
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => consoleErrors.push(String(error)));
      await page.goto(`http://127.0.0.1:${handle.port}/`);
      await page.waitForSelector('[data-testid="hq-workbench"]');

      const shots = path.join(os.tmpdir(), 'wrongstack-hq-smoke');
      fs.mkdirSync(shots, { recursive: true });
      // Surfaces are addressed by their stable `data-view` id rather than by
      // label text, so renaming a tab never silently skips a screenshot.
      const shoot = async (view: string | null, name: string) => {
        if (view !== null) {
          await page.click(`[data-testid="nav-item"][data-view="${view}"]`);
          await page.waitForTimeout(600);
        }
        await page.screenshot({ path: path.join(shots, `${name}.png`) });
      };

      await page.waitForTimeout(1000);
      await shoot(null, '01-cockpit');
      await shoot('fleet', '02-fleet');

      // Clicking a client in the fleet navigator must land in the Console with
      // its transcript.
      await shoot('console', '03-console');
      await page.click('[data-testid="nav-client"]');
      await page.waitForTimeout(900);
      await expect
        .poll(async () => page.locator('[data-testid="tool-head"]').count(), { timeout: 10_000 })
        .toBeGreaterThanOrEqual(4);
      await page.screenshot({ path: path.join(shots, '03-console-collapsed.png') });

      // Expand thinking + every tool card; the bash card must show the merged
      // exit-code result (live merge path) and the edit card a real diff.
      // The transcript is a virtua VList: only the rows in view are mounted, and
      // expanding one pushes the rest out of the window. So indexing a snapshot
      // of heads taken up front misses the tail. Instead: always take the first
      // still-collapsed head, scroll it into view (which mounts it), click, and
      // repeat — pushing to the last row whenever the mounted window looks done,
      // until three consecutive passes find nothing left to open.
      const collapsedHeads = () =>
        page.locator(
          '[data-testid="thinking-head"][aria-expanded="false"], [data-testid="tool-head"][aria-expanded="false"]',
        );
      for (let pass = 0, idle = 0; pass < 60 && idle < 3; pass += 1) {
        if ((await collapsedHeads().count()) === 0) {
          idle += 1;
          await page
            .locator('[data-testid="transcript-turn"]')
            .last()
            .scrollIntoViewIfNeeded()
            .catch(() => {});
          await page.waitForTimeout(200);
          continue;
        }
        idle = 0;
        const head = collapsedHeads().first();
        await head.scrollIntoViewIfNeeded().catch(() => {});
        await head.click().catch(() => {});
        await page.waitForTimeout(120);
      }
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(shots, '04-console-expanded.png') });

      // Same virtualization caveat for the assertions: a card is only in the DOM
      // while it is near the viewport, so scroll the list until it mounts and
      // then assert INSIDE that card rather than page-wide.
      const scrollTranscript = async (delta: number): Promise<void> => {
        const box = await page.locator('[data-testid="transcript-list"]').boundingBox();
        if (box === null) return;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, delta);
        await page.waitForTimeout(140);
      };
      const findCard = async (name: string): Promise<Locator> => {
        const card = page
          .locator('[data-testid="transcript-turn"][data-role="tool"]')
          .filter({ has: page.locator(`[data-testid="tool-name"]:text-is("${name}")`) });
        await scrollTranscript(-6000);
        for (let step = 0; step < 40; step += 1) {
          if ((await card.count()) > 0) return card.first();
          await scrollTranscript(400);
        }
        throw new Error(`transcript card never mounted: ${name}`);
      };

      const editCard = await findCard('edit');
      expect(
        await editCard.locator('[data-testid="tool-diff-line"][data-kind="add"]').count(),
      ).toBeGreaterThan(0);

      const bashCard = await findCard('bash');
      expect(await bashCard.locator('[data-testid="tool-result-exit"]').textContent()).toContain(
        'exit code 0',
      );

      const todoCard = await findCard('TodoWrite');
      expect(await todoCard.locator('[data-testid="todo"]').count()).toBe(3);

      await scrollTranscript(-6000);
      expect(await page.locator('[data-testid="markdown-code-lang"]').first().textContent()).toBe(
        'ts',
      );

      await shoot('brain', '05-brain');
      expect(await page.locator('[data-testid="brain-entry"]').count()).toBeGreaterThan(0);
      await shoot('worktree', '06-worktrees');
      await shoot('cost', '07-cost');
      await shoot('trends', '08-trends');
      await shoot('control', '09-control');
      // Mailbox opens on the live event feed (empty here — only a snapshot was
      // seeded); the snapshot content lives under "Grouped by project".
      await shoot('mailbox', '10-mailbox');
      await page.click('[role="tab"]:has-text("Grouped by project")');
      await page.waitForTimeout(400);
      expect(await page.locator('[data-testid="message-row"]').count()).toBeGreaterThan(0);
      await shoot('alerts', '11-alerts');
      await shoot('kanban', '12-kanban');
      await shoot('settings', '13-security');

      // Appearance: light/dark is a CLASS on <html> and the accent palette an
      // ATTRIBUTE, so both must actually land on the document element — a
      // token stylesheet keyed on anything else is silently theme-less.
      const openAppearance = async () => {
        await page.click('[aria-label="Appearance"]');
        await page.waitForTimeout(250);
      };
      await openAppearance();
      await page.click('[role="menuitemradio"]:has-text("Light")');
      await page.waitForTimeout(350);
      expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(
        false,
      );
      await shoot('cockpit', '14-cockpit-light');

      await openAppearance();
      await page.click('[role="menuitemradio"]:has-text("Emerald / Gold")');
      await page.waitForTimeout(350);
      expect(await page.evaluate(() => document.documentElement.getAttribute('data-palette'))).toBe(
        'emerald-gold',
      );
      await page.screenshot({ path: path.join(shots, '15-cockpit-light-emerald.png') });

      await openAppearance();
      await page.click('[role="menuitemradio"]:has-text("Dark")');
      await page.waitForTimeout(350);
      await openAppearance();
      await page.click('[role="menuitemradio"]:has-text("Signal (default)")');
      await page.waitForTimeout(350);
      expect(await page.evaluate(() => document.documentElement.hasAttribute('data-palette'))).toBe(
        false,
      );

      // Narrow viewport: the rail collapses to an overlay with a scrim, so the
      // content is never squeezed to nothing on a laptop half-screen.
      await page.setViewportSize({ width: 820, height: 900 });
      await page.waitForTimeout(400);
      // Narrowing must fold the rail away rather than leave it covering the
      // content behind a scrim.
      expect(await page.locator('[data-testid="nav-sidebar"]').getAttribute('data-open')).toBe(
        'false',
      );
      await page.screenshot({ path: path.join(shots, '16-narrow-collapsed.png') });
      await page.keyboard.press('Control+b');
      await page.waitForTimeout(400);
      // The scrim is always in the DOM; what matters is that it is actually
      // covering the content, so assert visibility rather than presence.
      expect(await page.locator('[data-testid="nav-scrim"]').isVisible()).toBe(true);
      await page.screenshot({ path: path.join(shots, '17-narrow-rail-open.png') });
      await page.click('[data-testid="nav-scrim"]');
      await page.waitForTimeout(300);
      expect(await page.locator('[data-testid="nav-sidebar"]').getAttribute('data-open')).toBe(
        'false',
      );
      await page.setViewportSize({ width: 1440, height: 900 });

      expect(consoleErrors.join(' | ')).toBe('');

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
