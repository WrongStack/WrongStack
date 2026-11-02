/// <reference lib="dom" />
/**
 * HQ visual smoke (e2e, opt-in) — boots the real HQ server, feeds it a fake
 * client with a rich session (markdown + thinking + tool cards + telemetry +
 * brain/worktree events), then drives the built `@wrongstack/hq-next` dashboard
 * with Playwright and screenshots every surface.
 *
 * Opt-in: runs only with `WSTACK_E2E=1` (needs the hq-next dist built and a
 * Playwright chromium). Screenshots land in `<tmp>/wrongstack-hq-smoke/`.
 *
 *   WSTACK_E2E=1 bun run test packages/cli/tests/hq-visual-smoke.test.ts
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { HQ_PROTOCOL_VERSION, type HqSnapshot } from '@wrongstack/hq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';
import { resolveHqDistDir } from '../src/hq-static-serve.js';
import { CLI_VERSION } from '../src/version.js';
import { WebSocket } from '../src/ws-runtime.js';

const E2E = process.env.WSTACK_E2E === '1';

describe.skipIf(!E2E)('HQ visual smoke (WSTACK_E2E=1)', () => {
  // A real browser against a real server: right after a heavy test run a
  // render can take longer than the 1 s `expect.poll` default. Waiting longer
  // changes no assertion, only how long a correct page may take to appear.
  beforeAll(() => vi.setConfig({ expect: { poll: { timeout: 5_000 } } }));
  afterAll(() => vi.resetConfig());

  it('renders every view of the built panel with live data', { timeout: 360_000 }, async () => {
    expect(
      resolveHqDistDir(),
      'hq-next dist must be built (bun run --filter @wrongstack/hq-next build)',
    ).not.toBeNull();

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-smoke-data-'));
    // `version` is mandatory — `readHqAuthFile` throws on anything else, which
    // used to fail this test before the browser even launched.
    // Token mode, like a default install (first-run auth mints tokens): the
    // admin screens (notifications, machine tokens, alert rules) refuse a
    // caller with no credential at all.
    const ADMIN_TOKEN = 'a1'.repeat(32);
    const CLIENT_TOKEN = 'c1'.repeat(32);
    fs.writeFileSync(
      path.join(dataDir, 'auth.json'),
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        browserTokens: [
          { id: 'smoke-admin', token: ADMIN_TOKEN, createdAt: new Date().toISOString() },
        ],
        clientTokens: [
          {
            id: 'smoke-client',
            token: CLIENT_TOKEN,
            label: 'fixture machines',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );

    // Three days of LAB-02 readings: its project disk losing 10 GB a day.
    fs.writeFileSync(
      path.join(dataDir, 'health-history.jsonl'),
      [72, 48, 24]
        .map((hoursAgo, index) =>
          JSON.stringify({
            key: 'host:lab-02',
            at: new Date(Date.now() - hoursAgo * 60 * 60_000).toISOString(),
            memUsedPct: 55 + index * 5,
            diskFreeBytes: (31.5 - index * 10) * 1024 ** 3,
            diskTotalBytes: 500 * 1024 ** 3,
            load1: 1,
            cpuCount: 8,
          }),
        )
        .join('\n')
        .concat('\n'),
    );

    let handle: HqServerHandle | null = null;
    let ws: WebSocket | null = null;
    let lab: WebSocket | null = null;
    let browser: import('@playwright/test').Browser | null = null;
    try {
      handle = await startHqServer({
        port: 34_997,
        dataDir,
        // The fixture clients publish once; the run outlasts the live TTLs.
        clientTtlMs: 15 * 60_000,
        sessionSnapshotTtlMs: 15 * 60_000,
      });
      ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client?token=${CLIENT_TOKEN}`);
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
            version: CLI_VERSION,
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

      // A second machine, on another project, one release behind the hub.
      lab = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client?token=${CLIENT_TOKEN}`);
      await new Promise<void>((res, rej) => {
        lab!.on('open', () => res());
        lab!.on('error', rej);
      });
      lab.send(
        JSON.stringify({
          type: 'client.hello',
          payload: {
            protocolVersion: HQ_PROTOCOL_VERSION,
            client: {
              clientId: 'lab-client',
              kind: 'cli',
              machineId: 'machine-lab',
              hostname: 'LAB-02',
              pid: 777,
              version: '0.9.0',
              startedAt: now(),
            },
            project: {
              projectId: 'proj-lab',
              projectRoot: 'D:/dev/datapipe',
              projectName: 'Datapipe',
              machineId: 'machine-lab',
              gitBranch: 'main',
              workspaceKind: 'git',
            },
            capabilities: ['telemetry.publish', 'session.summary', 'control.receive'],
            redactionPolicy: { rawContent: true, toolArgs: 'summary', paths: 'project-relative' },
            // Started with --hq-allow-exec: HQ may open sessions here.
            startsSessions: true,
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 300));
      const LAB_SESSION = 'lab-session-0001';
      lab.send(
        JSON.stringify({
          type: 'client.event',
          event: {
            id: 'lab-evt-1',
            type: 'session.snapshot',
            schemaVersion: HQ_PROTOCOL_VERSION,
            timestamp: now(),
            clientId: 'lab-client',
            projectId: 'proj-lab',
            sessionId: LAB_SESSION,
            seq: 1,
            payload: {
              sessionId: LAB_SESSION,
              clientKind: 'cli',
              machineId: 'machine-lab',
              hostname: 'LAB-02',
              pid: 777,
              projectId: 'proj-lab',
              projectName: 'Datapipe',
              projectRoot: 'D:/dev/datapipe',
              status: 'active',
              startedAt: now(),
              lastActivityAt: now(),
              agentCount: 1,
              agents: [
                {
                  id: 'leader',
                  name: 'leader',
                  status: 'running',
                  iterations: 2,
                  toolCalls: 4,
                  lastActivityAt: now(),
                  currentTool: 'read',
                },
              ],
            },
          },
        }),
      );

      // The lab machine spent exactly $0.25, so its scoped trend is checkable.
      lab.send(
        JSON.stringify({
          type: 'client.event',
          event: {
            id: 'lab-evt-2',
            type: 'session.usage',
            schemaVersion: HQ_PROTOCOL_VERSION,
            timestamp: now(),
            clientId: 'lab-client',
            projectId: 'proj-lab',
            sessionId: LAB_SESSION,
            seq: 2,
            payload: {
              sessionId: LAB_SESSION,
              agentId: 'leader',
              model: 'claude-haiku-4-5',
              inputTokens: 4_000,
              outputTokens: 500,
              costUsd: 0.25,
              at: now(),
            },
          },
        }),
      );

      // The lab machine reports its health with a heartbeat: nearly out of disk.
      lab.send(
        JSON.stringify({
          type: 'client.event',
          event: {
            id: 'lab-evt-3',
            type: 'client.heartbeat',
            schemaVersion: HQ_PROTOCOL_VERSION,
            timestamp: now(),
            clientId: 'lab-client',
            projectId: 'proj-lab',
            seq: 3,
            payload: {
              uptimeMs: 60_000,
              status: 'idle',
              host: {
                platform: 'linux',
                arch: 'x64',
                cpuCount: 8,
                loadAvg1: 1.25,
                memTotalBytes: 16 * 1024 ** 3,
                memAvailableBytes: 6 * 1024 ** 3,
                osUptimeSec: 5 * 86_400,
                diskTotalBytes: 500 * 1024 ** 3,
                diskFreeBytes: 1.5 * 1024 ** 3,
                processRssBytes: 320 * 1024 ** 2,
              },
            },
          },
        }),
      );

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
        // The brain bridge always sends the request id; it is what folds the
        // answer into the same decision.
        requestId: 'req-merge-phase-2',
        source: 'director',
        risk: 'medium',
        question: 'Merge worktree phase-2 into main despite 1 flaky test?',
        at: Date.now(),
      });
      event('brain.event', {
        kind: 'decision_answered',
        requestId: 'req-merge-phase-2',
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

      // MCP health: one server answering, one whose connection keeps breaking.
      const mcpServer = (name: string, extra: Record<string, unknown>) => ({
        name,
        connectionState: 'connected',
        healthState: 'healthy',
        consecutiveFailures: 0,
        failures: { transport: 0, protocol: 0, tool: 0 },
        reconnectCount: 0,
        wakeCount: 0,
        sleepCount: 0,
        restartCount: 0,
        connectionLatency: { count: 2, p50Ms: 180, p95Ms: 240 },
        discoveryLatency: { count: 2, p50Ms: 60, p95Ms: 90 },
        callLatency: { count: 14, p50Ms: 120, p95Ms: 900 },
        inFlightCalls: 0,
        peakInFlightCalls: 2,
        healthChecks: [],
        ...extra,
      });
      event(
        'mcp.health.snapshot',
        {
          servers: [
            mcpServer('github', {}),
            mcpServer('postgres', {
              connectionState: 'failed',
              healthState: 'failed',
              consecutiveFailures: 3,
              lastFailureKind: 'transport',
              lastFailureAt: now(),
              failures: { transport: 3, protocol: 0, tool: 0 },
              reconnectCount: 3,
            }),
          ],
        },
        { sessionId: SESSION },
      );

      // A subagent run that spent its spawn budget with work still queued.
      event(
        'fleet.snapshot',
        {
          runId: 'run-smoke-1',
          activeSubagents: 1,
          queuedTasks: 2,
          completedTasks: 4,
          failedTasks: 0,
          subagents: [],
          maxConcurrent: 3,
          maxSpawns: 6,
          usedSpawns: 6,
          remainingSpawns: 0,
        },
        { sessionId: SESSION },
      );

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
      // axe needs a page that belongs to an explicit context.
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        // `page.request` calls carry the admin token like the dashboard does.
        extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      // The dashboard keeps its credential in localStorage.
      await context.addInitScript((token) => {
        window.localStorage.setItem('wrongstack.hq.token.v1', token);
      }, ADMIN_TOKEN);
      const page = await context.newPage();
      // The HQ server sends a strict CSP (script-src 'self' 'wasm-unsafe-eval').
      // A violation surfaces here as a console error and nowhere else, so the
      // whole run collects them and asserts at the end.
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => consoleErrors.push(String(error)));
      const base = `http://127.0.0.1:${handle.port}`;
      const shots = path.join(os.tmpdir(), 'wrongstack-hq-smoke');
      fs.mkdirSync(shots, { recursive: true });
      // Every screenshot is also an accessibility check (WCAG 2.2 A/AA). axe
      // runs through page.evaluate, which the page CSP does not govern.
      const { default: AxeBuilder } = await import('@axe-core/playwright');
      const a11y: { page: string; id: string; impact: string; help: string; nodes: string[] }[] =
        [];
      const shot = async (name: string): Promise<void> => {
        await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
        await audit(name);
      };
      const audit = async (name: string): Promise<void> => {
        // A fading overlay measures as low contrast; check the settled page.
        await page.waitForFunction(() =>
          document
            .getAnimations()
            // Looping pulses (the live LED) never finish and are not overlays.
            .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
            .every((animation) => animation.playState !== 'running'),
        );
        const result = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        for (const violation of result.violations) {
          a11y.push({
            page: name,
            id: violation.id,
            impact: violation.impact ?? 'unknown',
            help: violation.help,
            nodes: violation.nodes.slice(0, 4).map((node) => node.target.join(' ')),
          });
        }
      };
      const main = page.locator('main');

      // Overview: the project that reported shows up by name.
      await page.goto(`${base}/`);
      await main.getByText('WrongStack').first().waitFor({ timeout: 15_000 });
      // The first Tab reaches the skip link, and it moves focus into the page.
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(
        'Skip to content',
      );
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('hq-main');
      // The real server reports token counts (never token strings) in the snapshot.
      await expect
        .poll(async () => main.textContent())
        .toMatch(/Access tokens\s*\d+ browser · \d+ client/);
      expect(await main.textContent()).toMatch(/MCP servers\s*1 failing of 2/);
      // Both reach the attention queue, so the headline is not "All clear".
      expect(await main.textContent()).toContain('MCP server postgres is failing');
      expect(await main.textContent()).toContain('Subagent run in WrongStack is out of spawns');
      expect(await main.textContent()).not.toContain('All clear');
      // The subagent run shows its spent budget and why that matters.
      const run = main.locator('[data-run="run-smoke-1"]');
      expect(await run.textContent()).toContain('6 of 6 spawns used · 0 left');
      expect(await run.textContent()).toContain('No spawns left and 2 tasks still queued');
      await shot('01-overview');

      // Fleet: the machine is on the map.
      await page.goto(`${base}/fleet/`);
      await main.getByText('DEVBOX-01').first().waitFor({ timeout: 10_000 });
      await shot('02-fleet');

      // Console: the transcript renders every kind of turn, and tool rows open
      // to their real bodies (diff lines, exit code, todo list, code language).
      await page.goto(`${base}/fleet/console/?session=${SESSION}`);
      await expect
        .poll(async () => page.locator('[data-testid="transcript-turn"]').count(), {
          timeout: 10_000,
        })
        .toBeGreaterThan(3);
      // The header describes the leader the client reported.
      expect(await page.getByTestId('agent-facts').textContent()).toMatch(
        /claude-fable-5.*Context 38%.*182k in · 24\.5k out/,
      );
      await shot('03-console-collapsed');
      const openTool = async (tool: string): Promise<Locator> => {
        const row = page.locator(`[data-testid="transcript-turn"][data-tool="${tool}"]`).first();
        await row.scrollIntoViewIfNeeded();
        const head = row.locator('button[aria-expanded]').first();
        if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
        return row;
      };
      const editCard = await openTool('edit');
      expect(
        await editCard.locator('[data-testid="tool-diff-line"][data-kind="add"]').count(),
      ).toBeGreaterThan(0);
      const bashCard = await openTool('bash');
      expect(await bashCard.locator('[data-testid="tool-result-exit"]').textContent()).toContain(
        '0',
      );
      const todoCard = await openTool('TodoWrite');
      expect(await todoCard.locator('[data-testid="todo"]').count()).toBe(3);
      expect(await page.locator('[data-testid="markdown-code-lang"]').count()).toBeGreaterThan(0);
      await shot('04-console-expanded');

      // Mailbox: both messages are listed once done ones are shown.
      await page.goto(`${base}/work/mailbox/`);
      await main.getByLabel('Show done').check();
      await expect.poll(async () => main.locator('[data-mail]').count()).toBeGreaterThan(1);
      await shot('05-mailbox');

      // Brain and worktrees read the persisted events.
      await page.goto(`${base}/telemetry/brain/`);
      await expect
        .poll(async () => main.locator('[data-decision], [data-intervention]').count(), {
          timeout: 10_000,
        })
        .toBeGreaterThan(0);
      // Request and answer are one decision, not two cards.
      expect(await main.locator('[data-decision]').count()).toBe(1);
      expect(await main.textContent()).toContain('Flake is the known CI timer flake');
      expect(await main.textContent()).not.toContain('No answer yet');
      await shot('06-brain');
      await page.goto(`${base}/system/worktrees/`);
      await expect
        .poll(async () => main.locator('[data-lane]').count(), { timeout: 10_000 })
        .toBeGreaterThan(0);
      await shot('07-worktrees');

      // MCP, reached through the command palette: the failing server leads and
      // the detail names the cause.
      await page.keyboard.press('Control+k');
      await page.getByLabel('Search HQ views').fill('mcp');
      await page.keyboard.press('Enter');
      await page.waitForURL('**/system/mcp/**');
      await main.locator('[data-mcp-server]').first().waitFor({ timeout: 10_000 });
      expect(
        await main
          .locator('[data-mcp-server]')
          .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-mcp-server'))),
      ).toEqual(['postgres', 'github']);
      expect(await main.getByTestId('mcp-headline').textContent()).toBe('1 MCP server failing');
      expect(await main.getByTestId('mcp-detail').textContent()).toContain(
        'Last error: the connection broke (3 times in a row).',
      );
      await main.locator('[data-mcp-server="github"]').click();
      await expect.poll(() => page.url()).toContain('server=smoke-client');
      expect(await main.getByTestId('mcp-detail').textContent()).toContain('p50 120 ms');
      await shot('07b-mcp');

      // Every other surface loads without a console error.
      const rest = [
        ['08-kanban', '/work/'],
        ['09-queue', '/inbox/'],
        ['10-alerts', '/inbox/alerts/'],
        ['11-cost', '/telemetry/'],
        ['12-trends', '/telemetry/trends/'],
        ['13-events', '/telemetry/events/'],
        ['14-control', '/system/'],
        ['15-security', '/system/security/'],
      ] as const;
      for (const [name, route] of rest) {
        await page.goto(`${base}${route}`);
        await page.waitForLoadState('networkidle');
        await shot(name);
      }

      // A phone-width viewport never scrolls sideways.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${base}/fleet/console/?session=${SESSION}`);
      await page.locator('[data-testid="transcript-turn"]').first().waitFor({ timeout: 10_000 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      await shot('16-console-phone');
      await page.setViewportSize({ width: 1440, height: 900 });

      // ── Many machines from one place ──────────────────────────────────────
      // Machines: both boxes, and the lab one flagged as behind the hub.
      await page.goto(`${base}/fleet/machines/`);
      await expect.poll(() => main.locator('[data-machine]').count(), { timeout: 10_000 }).toBe(2);
      expect(await main.getByTestId('machines-headline').textContent()).toBe(
        '2 of 2 machines online',
      );
      await main.locator('[data-machine="host:lab-02"]').click();
      await expect
        .poll(async () => main.getByTestId('machine-detail').textContent())
        .toContain('LAB-02');
      expect(await main.getByTestId('machine-detail').textContent()).toMatch(/0\.9\.0\s*behind HQ/);
      // Its health reading: a near-full project disk, flagged.
      const health = await main.getByTestId('machine-health').textContent();
      expect(health).toContain('Linux · x64');
      expect(health).toContain('1.5 GB free of 500 GB');
      expect(health).toContain('load 1.25 on 8 cores');
      expect(health).toContain('5d 0h');
      // The 7-day trend from the stored readings plus today's: still filling.
      const trend = main.getByTestId('health-history');
      await trend.waitFor({ timeout: 10_000 });
      expect(await trend.textContent()).toContain(
        'Free space went from 31.5 GB to 1.5 GB over 3 days.',
      );
      expect(await main.getByTestId('disk-full-projection').textContent()).toMatch(
        /^At this rate the project disk is full (within a day|in about \d+ days?)\.$/,
      );
      expect(await main.getByTestId('machine-detail').textContent()).toContain(
        'LAB-02 is low on disk space',
      );
      // Label the lab box, then filter the list down to it.
      const labels = main.getByTestId('machine-labels');
      await labels.getByRole('button', { name: 'Add labels' }).click();
      await labels.getByRole('textbox').fill('Lab, gpu');
      await labels.getByRole('button', { name: 'Save labels' }).click();
      await expect
        .poll(async () => main.locator('[data-machine="host:lab-02"]').textContent())
        .toContain('gpu');
      expect(await labels.getByRole('button', { name: 'Edit labels' }).count()).toBe(1);
      await main.locator('[data-label-filter="lab"]').click();
      await expect.poll(() => main.locator('[data-machine]').count()).toBe(1);
      expect(new URL(page.url()).searchParams.get('label')).toBe('lab');
      expect(await main.getByTestId('machines-headline').textContent()).toBe(
        '1 of 1 lab machine online',
      );
      await shot('17-machines');
      // The label becomes a scope for the whole of HQ, then back to the fleet.
      await main.getByRole('button', { name: 'Scope HQ to lab machines' }).click();
      await expect
        .poll(() => page.getByTestId('scope-picker').textContent())
        .toContain('lab machines');
      await page.getByTestId('scope-picker').click();
      await page.getByRole('menuitem', { name: 'Whole fleet' }).click();
      await expect.poll(() => page.getByRole('menu').count()).toBe(0);
      await page.goto(`${base}/fleet/machines/`);

      // The drift reaches the attention queue as one fleet-wide item.
      await page.goto(`${base}/`);
      await expect
        .poll(async () => main.textContent())
        .toContain('1 client runs a different WrongStack than HQ');

      // Scope HQ to the lab machine: the Overview narrows and says what it hides.
      await page.getByTestId('scope-picker').click();
      await page.getByRole('menuitem', { name: 'LAB-02' }).click();
      // The menu hides the page from assistive tech while open; wait it out.
      await expect.poll(() => page.getByRole('menu').count()).toBe(0);
      await expect.poll(async () => main.getByTestId('outside-scope').count()).toBe(1);
      const scopedText = await main.textContent();
      expect(scopedText).toContain('Datapipe');
      expect(scopedText).not.toContain('MCP server postgres is failing');
      expect(await page.getByTestId('scope-picker').textContent()).toMatch(/LAB-02\s*\+\d+/);
      await shot('18-scoped-overview');
      // A link to another project still opens it while HQ is scoped elsewhere.
      await page.goto(`${base}/system/worktrees/?project=proj-smoke`);
      await expect
        .poll(() => main.locator('[data-lane]').count(), { timeout: 10_000 })
        .toBeGreaterThan(0);
      await page.goto(`${base}/work/?project=proj-smoke`);
      await expect
        .poll(async () => main.getByRole('combobox', { name: 'Project' }).inputValue())
        .toBe('proj-smoke');
      // Trends follow the scope: only the lab machine's spend.
      await page.goto(`${base}/telemetry/trends/`);
      await expect.poll(async () => main.getByTestId('trends-scope').count()).toBe(1);
      await expect
        .poll(async () => main.locator('h2 + p').first().textContent(), { timeout: 10_000 })
        .toMatch(/^\$0\.25 · 4\.5k tokens/);
      await page.goto(`${base}/`);
      await main.getByRole('button', { name: 'Show the whole fleet' }).click();
      await expect.poll(async () => main.getByTestId('outside-scope').count()).toBe(0);

      // One steer to both machines: two separate, audited commands.
      await page.goto(`${base}/system/`);
      await main.locator('[data-control-mode="many"]').click();
      await main.getByRole('button', { name: 'Select all in scope' }).click();
      await main.getByLabel('Message to every selected leader').fill('Pause and post a status.');
      await main.getByRole('button', { name: 'Review 2 commands' }).click();
      const reviewText = await main.getByTestId('fanout-review').textContent();
      expect(reviewText).toContain('LAB-02');
      expect(reviewText).toContain('DEVBOX-01');
      await main.getByLabel('Confirmation').fill('2');
      await main.getByRole('button', { name: 'Send to 2' }).click();
      await expect
        .poll(async () => main.getByTestId('fanout-result').textContent(), { timeout: 10_000 })
        .toContain('Sent to 2 of 2');
      const commandAudit = (await (
        await page.request.get(`${base}/api/commands?limit=10`)
      ).json()) as {
        commands: { clientId: string; type: string }[];
      };
      expect(
        commandAudit.commands
          .filter((command) => command.type === 'steer')
          .map((command) => command.clientId)
          .sort(),
      ).toEqual(['lab-client', 'smoke-client']);
      await shot('19-fanout');

      // A machine that drops out is remembered, not erased: it stays listed
      // as offline with what it last ran, until the operator forgets it.
      const old = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client?token=${CLIENT_TOKEN}`);
      await new Promise<void>((res, rej) => {
        old.on('open', () => res());
        old.on('error', rej);
      });
      old.send(
        JSON.stringify({
          type: 'client.hello',
          payload: {
            protocolVersion: HQ_PROTOCOL_VERSION,
            client: {
              clientId: 'old-client',
              kind: 'cli',
              machineId: 'machine-old',
              hostname: 'OLD-03',
              pid: 303,
              version: '0.8.0',
              startedAt: now(),
            },
            project: {
              projectId: 'proj-old',
              projectRoot: 'D:/dev/legacy',
              projectName: 'Legacy',
              machineId: 'machine-old',
              workspaceKind: 'git',
            },
            capabilities: ['telemetry.publish'],
          },
        }),
      );
      await expect
        .poll(async () =>
          ((await (await page.request.get(`${base}/api/snapshot`)).json()) as HqSnapshot).clients
            .map((client) => client.clientId)
            .includes('old-client'),
        )
        .toBe(true);
      // It ran one short session before dropping out; that session is
      // remembered after it ends.
      const oldEvent = (id: string, type: string, payload: unknown): string =>
        JSON.stringify({
          type: 'client.event',
          event: {
            id,
            type,
            schemaVersion: HQ_PROTOCOL_VERSION,
            timestamp: now(),
            clientId: 'old-client',
            projectId: 'proj-old',
            sessionId: 'old-session-1',
            seq: id === 'old-evt-1' ? 1 : 2,
            payload,
          },
        });
      old.send(
        oldEvent('old-evt-1', 'session.snapshot', {
          sessionId: 'old-session-1',
          clientKind: 'cli',
          machineId: 'machine-old',
          hostname: 'OLD-03',
          projectId: 'proj-old',
          projectName: 'Legacy',
          projectRoot: 'D:/dev/legacy',
          status: 'active',
          startedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
          lastActivityAt: now(),
          agentCount: 1,
          agents: [
            {
              id: 'leader',
              name: 'leader',
              status: 'idle',
              iterations: 4,
              toolCalls: 11,
              costUsd: 0.42,
              model: 'legacy-model',
              lastActivityAt: now(),
            },
          ],
        }),
      );
      await expect
        .poll(async () =>
          (
            ((await (await page.request.get(`${base}/api/snapshot`)).json()) as HqSnapshot)
              .liveSessions ?? []
          ).some((session) => session.sessionId === 'old-session-1'),
        )
        .toBe(true);
      old.send(
        oldEvent('old-evt-2', 'session.ended', { sessionId: 'old-session-1', endedAt: now() }),
      );
      await expect
        .poll(async () =>
          (
            ((await (await page.request.get(`${base}/api/snapshot`)).json()) as HqSnapshot)
              .liveSessions ?? []
          ).some((session) => session.sessionId === 'old-session-1'),
        )
        .toBe(false);
      await page.goto(`${base}/telemetry/sessions/`);
      const ended = main.locator('[data-history-session="old-session-1"]');
      await ended.waitFor({ timeout: 10_000 });
      expect(await ended.textContent()).toMatch(/Legacy.*OLD-03.*12m.*\$0\.42.*11.*legacy-model/);
      expect(await ended.textContent()).not.toContain('lost');
      await shot('20a-session-history');
      const [csvDownload] = await Promise.all([
        page.waitForEvent('download'),
        main.getByRole('button', { name: /as CSV$/ }).click(),
      ]);
      const csv = fs.readFileSync((await csvDownload.path()) as string, 'utf8');
      expect(csv.startsWith('ended_at,')).toBe(true);
      expect(csv).toContain('old-session-1');
      expect(csv).toContain('Legacy');
      old.close();
      // The Overview says so, and its row leads to the machine.
      await page.goto(`${base}/`);
      await expect.poll(async () => main.textContent()).toContain('OLD-03 went offline');
      await page.goto(`${base}/fleet/machines/`);
      await expect.poll(() => main.locator('[data-machine]').count(), { timeout: 10_000 }).toBe(3);
      expect(await main.getByTestId('machines-headline').textContent()).toBe(
        '2 of 3 machines online',
      );
      await main.locator('[data-machine="host:old-03"]').click();
      const remembered = main.locator('[data-testid="machine-detail"][data-remembered="true"]');
      await remembered.waitFor();
      expect(await remembered.textContent()).toContain('0.8.0');
      expect(await remembered.textContent()).toContain('Legacy');
      await shot('20-machine-offline');
      // Projects: every project across its machines. Legacy has no client
      // left, so HQ lists it from the roster, with the session that ended.
      await page.goto(`${base}/fleet/projects/`);
      await expect.poll(() => main.locator('[data-project]').count(), { timeout: 10_000 }).toBe(3);
      expect(await main.getByTestId('projects-headline').textContent()).toMatch(
        /^\d of 3 projects with a session open$/,
      );
      await main.locator('[data-project="proj-smoke"]').click();
      const projectDetail = main.getByTestId('project-detail');
      await expect.poll(async () => projectDetail.textContent()).toContain('WrongStack');
      expect(await projectDetail.textContent()).toContain('DEVBOX-01');
      expect(await projectDetail.locator('[data-project-session]').count()).toBeGreaterThan(0);
      await shot('20b-project');
      // Start a session on the lab machine: write, then review what will run.
      // (Confirming is refused for this bearer-token browser at the trust
      // boundary; the cookie path is covered by hq-start-session.test.ts.)
      await main.locator('[data-project="proj-lab"]').click();
      await expect.poll(async () => projectDetail.textContent()).toContain('Datapipe');
      await projectDetail.getByTestId('start-session').click();
      const startDialog = page.getByRole('dialog');
      await startDialog.waitFor();
      await startDialog.getByTestId('start-session-prompt').fill('Fix the flaky export test');
      await startDialog.getByRole('button', { name: 'Review' }).click();
      const review = startDialog.getByTestId('start-session-review');
      await review.waitFor();
      const reviewed = await review.textContent();
      expect(reviewed).toContain('LAB-02');
      expect(reviewed).toContain('Fix the flaky export test');
      expect(reviewed).toContain('Inbox');
      await shot('20d-start-session-review');
      await page.keyboard.press('Escape');
      await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
      // The project without a capable client says how to enable it.
      await main.locator('[data-project="proj-smoke"]').click();
      await expect.poll(async () => projectDetail.textContent()).toContain('--hq-allow-exec');
      await main.locator('[data-project="proj-old"]').click();
      const rememberedProject = main.locator(
        '[data-testid="project-detail"][data-remembered="true"]',
      );
      await rememberedProject.waitFor();
      expect(await rememberedProject.textContent()).toContain('OLD-03');
      await rememberedProject.getByTestId('project-recent-sessions').waitFor({ timeout: 10_000 });
      expect(await rememberedProject.textContent()).toMatch(/12m.*\$0\.42/);
      await shot('20c-project-remembered');
      await page.goto(`${base}/fleet/machines/`);
      await main.locator('[data-machine="host:old-03"]').click();
      await remembered.waitFor();
      await main.getByTestId('forget-machine').click();
      await main.getByTestId('forget-machine-confirm').waitFor();
      await shot('21-forget-machine');
      await main.getByTestId('forget-machine-confirm-button').click();
      await expect.poll(() => main.locator('[data-machine]').count(), { timeout: 10_000 }).toBe(2);

      // Notifications: add a channel, send a test, and the receiver gets it.
      const hooks: Array<Record<string, unknown>> = [];
      const receiver = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          hooks.push(JSON.parse(body) as Record<string, unknown>);
          res.writeHead(204).end();
        });
      });
      await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
      try {
        const hookUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/hook/SECRET-9f2c`;
        await page.goto(`${base}/system/notifications/`);
        await main.getByLabel('Where').selectOption('webhook');
        await main.getByLabel('Name').fill('Ops hook');
        await main.getByLabel('URL', { exact: true }).fill(hookUrl);
        await main.getByRole('button', { name: 'Add channel' }).click();
        const channel = main.locator('[data-channel]');
        await channel.waitFor();
        expect(await channel.textContent()).not.toContain('SECRET');
        await channel.getByTestId('notify-test').click();
        await expect.poll(() => hooks.length, { timeout: 10_000 }).toBe(1);
        expect(hooks[0]).toMatchObject({ title: 'WrongStack HQ test notification' });
        await expect.poll(async () => channel.textContent()).toContain('Test message delivered.');
        await shot('22-notifications');

        // A daily budget on the lab project, which already spent $0.25: the
        // next alert check fires it, the channel is told, and the alert
        // history can mute it.
        const budget = main.locator('[data-budget="project:proj-lab"] input');
        await budget.fill('0.1');
        await main.getByRole('button', { name: 'Save alert rules' }).click();
        await expect
          .poll(async () => main.getByRole('status').allTextContents())
          .toContainEqual(expect.stringContaining('Saved.'));
        await expect
          .poll(() => hooks.some((hook) => String(hook.body).includes('Project Datapipe spent')), {
            timeout: 25_000,
          })
          .toBe(true);
        await page.goto(`${base}/inbox/alerts/`);
        const mute = main.locator('[data-mute="budget-project:proj-lab"]');
        await mute.waitFor({ timeout: 10_000 });
        await mute.getByRole('button', { name: '1 hour' }).click();
        await expect.poll(async () => mute.textContent()).toContain('Muted');
        await shot('23-budget-alert-muted');
      } finally {
        await new Promise<void>((resolve) => receiver.close(() => resolve()));
      }

      // Adding a machine mints its token right in the dialog: shown once,
      // inside the commands to paste; then it can be revoked from Machines.
      await page.goto(`${base}/fleet/machines/`);
      const tokens = main.getByTestId('machine-tokens');
      await expect.poll(async () => tokens.textContent()).toContain('fixture machines');
      await main.getByRole('button', { name: 'Add a machine' }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Machine name').fill('LAB-03');
      await dialog.getByRole('button', { name: 'Create a token' }).click();
      await dialog.getByTestId('machine-token-minted').waitFor();
      const commands = (await dialog.locator('code').allTextContents()).join('\n');
      expect(commands).toMatch(/\/hq set \S+ [0-9a-f]{64}/);
      await shot('24-machine-token-minted');
      await page.keyboard.press('Escape');
      await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
      await page.reload();
      const minted = tokens.locator('li', { hasText: 'LAB-03' });
      await minted.waitFor();
      // The list never carries the secret.
      expect(await tokens.textContent()).not.toMatch(/[0-9a-f]{64}/);
      await minted.getByRole('button', { name: 'Revoke' }).click();
      await minted.getByRole('button', { name: 'Revoke LAB-03' }).click();
      await expect.poll(() => tokens.locator('li', { hasText: 'LAB-03' }).count()).toBe(0);
      // The fixture machines keep their own token and stay connected.
      await expect.poll(() => main.locator('[data-machine]').count()).toBe(2);

      // The light theme is checked on every surface too; colours differ there.
      await page.evaluate(() => {
        const key = 'wrongstack.hq.local-prefs.v1';
        const prefs = JSON.parse(window.localStorage.getItem(key) ?? '{}');
        prefs.appearance = { ...(prefs.appearance ?? {}), theme: 'light' };
        window.localStorage.setItem(key, JSON.stringify(prefs));
      });
      const lightRoutes = [
        ['L01-overview', '/'],
        ['L02-fleet', '/fleet/'],
        ['L03-console', `/fleet/console/?session=${SESSION}`],
        ['L04-mailbox', '/work/mailbox/'],
        ['L05-kanban', '/work/'],
        ['L06-queue', '/inbox/'],
        ['L07-alerts', '/inbox/alerts/'],
        ['L08-cost', '/telemetry/'],
        ['L09-trends', '/telemetry/trends/'],
        ['L10-events', '/telemetry/events/'],
        ['L11-brain', '/telemetry/brain/'],
        ['L12-control', '/system/'],
        ['L13-worktrees', '/system/worktrees/'],
        ['L14-mcp', '/system/mcp/'],
        ['L15-security', '/system/security/'],
        ['L16-notifications', '/system/notifications/'],
        ['L17-sessions', '/telemetry/sessions/'],
        ['L18-projects', '/fleet/projects/'],
      ] as const;
      for (const [name, route] of lightRoutes) {
        await page.goto(`${base}${route}`);
        await page.waitForLoadState('networkidle');
        expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(
          false,
        );
        await shot(name);
      }

      // Overlays are invisible to axe until they are open, so each one is
      // opened and checked in place.
      const setAppearance = (patch: Record<string, string>) =>
        page.evaluate((next) => {
          const key = 'wrongstack.hq.local-prefs.v1';
          const prefs = JSON.parse(window.localStorage.getItem(key) ?? '{}');
          prefs.appearance = { ...(prefs.appearance ?? {}), ...next };
          window.localStorage.setItem(key, JSON.stringify(prefs));
        }, patch);
      const closeOverlay = async (): Promise<void> => {
        await page.keyboard.press('Escape');
        // Closing animates; the next overlay must not meet this one on its way out.
        await expect
          .poll(() => page.locator('[role="menu"], [role="dialog"], [role="alertdialog"]').count())
          .toBe(0);
      };
      const overlays = async (theme: string): Promise<void> => {
        await page.goto(`${base}/`);
        // The shell must be hydrated before its controls answer.
        await page.getByTestId('scope-picker').waitFor();
        await page.getByRole('button', { name: /Jump to/ }).click();
        await page.getByRole('dialog').waitFor();
        await audit(`O-${theme}-palette`);
        await closeOverlay();
        await page.getByTestId('scope-picker').click();
        await page.getByRole('menu').waitFor();
        await audit(`O-${theme}-scope-menu`);
        await closeOverlay();
        await page.getByRole('button', { name: 'Appearance' }).click();
        await page.getByRole('menu').waitFor();
        await audit(`O-${theme}-appearance-menu`);
        await closeOverlay();
        await page.goto(`${base}/fleet/machines/`);
        await page.getByRole('button', { name: 'Add a machine' }).first().click();
        await page.getByRole('dialog').waitFor();
        await audit(`O-${theme}-add-machine`);
        await closeOverlay();
        await page.goto(`${base}/fleet/console/?session=${SESSION}`);
        await main.getByRole('button', { name: 'Interrupt' }).click();
        await page.getByRole('alertdialog').waitFor();
        await audit(`O-${theme}-interrupt`);
        await closeOverlay();
      };
      await overlays('light');
      await setAppearance({ theme: 'dark' });
      await overlays('dark');

      // Every brand palette, in both themes, on the surfaces that use the
      // brand colour most (primary buttons, focus, the active rail item).
      const palettes = [
        ...fs
          .readFileSync(
            path.join(import.meta.dirname, '../../hq-next/src/hq/data/local-prefs.ts'),
            'utf8',
          )
          .matchAll(/^\s+'([a-z]+(?:-[a-z]+)*)',\r?$/gm),
      ]
        .map((match) => match[1] as string)
        .filter((id) => id !== 'dark' && id !== 'light' && id !== 'system');
      expect(palettes.length).toBeGreaterThan(5);
      for (const theme of ['dark', 'light']) {
        for (const palette of palettes) {
          await setAppearance({ theme, palette });
          for (const [name, route] of [
            ['overview', '/'],
            ['control', '/system/'],
          ] as const) {
            await page.goto(`${base}${route}`);
            await page.waitForLoadState('networkidle');
            await audit(`P-${theme}-${palette}-${name}`);
          }
        }
      }
      await setAppearance({ theme: 'dark', palette: 'signal' });

      expect(consoleErrors.join(' | ')).toBe('');
      fs.writeFileSync(path.join(shots, 'a11y.json'), JSON.stringify(a11y, null, 2));
      // WCAG 2.2 AA in both themes on every surface; the JSON names each node.
      expect(a11y).toEqual([]);

      // eslint-disable-next-line no-console
      console.log(`HQ smoke screenshots: ${shots}`);
    } finally {
      await browser?.close().catch(() => {});
      ws?.close();
      lab?.close();
      await handle?.close().catch(() => {});
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
