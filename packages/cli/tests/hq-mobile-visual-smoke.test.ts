/// <reference lib="dom" />
/**
 * Opt-in mobile HQ acceptance: password login -> /mobile shell -> live session
 * -> command delivery over the real client WebSocket.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HQ_PROTOCOL_VERSION } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import type { RawData } from 'ws';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';
import { resolveHqDistDir } from '../src/hq-static-serve.js';
import { WebSocket } from '../src/ws-runtime.js';

const E2E = process.env.WSTACK_E2E === '1';
const PASSWORD = 'mobile-hq-password';

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function waitForCommand(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('mobile command was not delivered')), 10_000);
    const onMessage = (data: RawData): void => {
      const parsed = JSON.parse(data.toString()) as {
        type?: string;
        commands?: Record<string, unknown>[];
      };
      if (parsed.type !== 'hq.command_batch' || parsed.commands?.[0] === undefined) return;
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(parsed.commands[0]);
    };
    socket.on('message', onMessage);
  });
}

describe.skipIf(!E2E)('HQ mobile visual smoke (WSTACK_E2E=1)', () => {
  it('logs in with a password and delivers a live-console message', {
    timeout: 120_000,
  }, async () => {
    expect(resolveHqDistDir(), 'hq-next dist must be built').not.toBeNull();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-hq-mobile-'));
    let handle: HqServerHandle | null = null;
    let socket: WebSocket | null = null;
    let browser: import('@playwright/test').Browser | null = null;

    try {
      handle = await startHqServer({
        host: '127.0.0.1',
        port: 34_996,
        dataDir,
        password: PASSWORD,
      });
      const clientToken = handle.firstRunSetup?.clientEnv.WRONGSTACK_HQ_TOKEN;
      expect(clientToken).toBeTruthy();
      socket = new WebSocket(
        `ws://127.0.0.1:${handle.port}/ws/client?token=${encodeURIComponent(clientToken ?? '')}`,
      );
      await waitForOpen(socket);

      const now = new Date().toISOString();
      const clientId = 'mobile-control-client';
      const projectId = 'mobile-project';
      const sessionId = 'mobile-session';
      socket.send(
        JSON.stringify({
          type: 'client.hello',
          payload: {
            protocolVersion: HQ_PROTOCOL_VERSION,
            client: {
              clientId,
              kind: 'tui',
              machineId: 'mobile-vps',
              hostname: 'VPS-MOBILE',
              pid: 7001,
              startedAt: now,
            },
            project: {
              projectId,
              projectRoot: '/srv/mobile-project',
              projectName: 'Mobile Project',
              machineId: 'mobile-vps',
              workspaceKind: 'git',
            },
            capabilities: [
              'telemetry.publish',
              'session.summary',
              'control.receive',
              'kanban.dispatch',
            ],
          },
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'client.event',
          event: {
            id: 'mobile-session-snapshot',
            type: 'session.snapshot',
            schemaVersion: HQ_PROTOCOL_VERSION,
            timestamp: now,
            clientId,
            projectId,
            sessionId,
            seq: 1,
            payload: {
              sessionId,
              clientKind: 'tui',
              machineId: 'mobile-vps',
              hostname: 'VPS-MOBILE',
              pid: 7001,
              projectId,
              projectName: 'Mobile Project',
              projectRoot: '/srv/mobile-project',
              status: 'active',
              startedAt: now,
              lastActivityAt: now,
              agentCount: 2,
              agents: [
                {
                  id: 'leader',
                  name: 'leader',
                  status: 'running',
                  iterations: 4,
                  toolCalls: 9,
                  lastActivityAt: now,
                },
                {
                  id: 'reviewer-1',
                  name: 'reviewer',
                  status: 'waiting_user',
                  iterations: 2,
                  toolCalls: 3,
                  lastActivityAt: now,
                },
              ],
            },
          },
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'client.event',
          event: {
            id: 'mobile-kanban-snapshot',
            type: 'kanban.snapshot',
            schemaVersion: HQ_PROTOCOL_VERSION,
            timestamp: now,
            clientId,
            projectId,
            seq: 2,
            payload: {
              projectId,
              generatedAt: now,
              boards: [
                {
                  boardId: 'mobile-board',
                  revision: 1,
                  updatedAt: now,
                  board: {
                    id: 'mobile-board',
                    title: 'VPS rollout',
                    columns: [
                      { id: 'todo', title: 'To Do', order: 0 },
                      { id: 'running', title: 'Running', order: 1 },
                    ],
                    tasks: [
                      {
                        id: 'ready-task',
                        title: 'Run migration checks',
                        columnId: 'todo',
                        order: 0,
                        priority: 'high',
                        status: 'ready',
                        assignee: 'reviewer-1',
                        assignment: { status: 'assigned', agentId: 'reviewer-1' },
                        lifecycle: { currentStage: 'todo' },
                      },
                      {
                        id: 'deploy-task',
                        title: 'Deploy production',
                        columnId: 'running',
                        order: 0,
                        priority: 'high',
                        status: 'in_progress',
                        assignee: 'reviewer-1',
                        lifecycle: { currentStage: 'running' },
                      },
                    ],
                  },
                },
              ],
              tombstones: [],
            },
          },
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'client.event',
          event: {
            id: 'mobile-transcript',
            type: 'session.transcript',
            schemaVersion: HQ_PROTOCOL_VERSION,
            timestamp: now,
            clientId,
            projectId,
            sessionId,
            seq: 3,
            payload: {
              sessionId,
              fromSeq: 0,
              entries: [{ ts: now, role: 'assistant', text: 'Mobile HQ is online.' }],
            },
          },
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'client.event',
          event: {
            id: 'mobile-mailbox-snapshot',
            type: 'mailbox.snapshot',
            schemaVersion: HQ_PROTOCOL_VERSION,
            timestamp: now,
            clientId,
            projectId,
            sessionId,
            seq: 4,
            payload: {
              mailboxId: 'mobile-project:mailbox',
              scope: 'project',
              agents: [],
              messages: [
                {
                  mailId: 'mobile-mail-1',
                  messageId: 'mobile-message-1',
                  from: 'reviewer-1',
                  to: 'leader',
                  type: 'ask',
                  subject: 'Approve production rollout',
                  priority: 'high',
                  timestamp: now,
                  completed: false,
                  hasBody: true,
                  bodyPreview: 'Deployment is waiting for operator approval.',
                },
              ],
              totals: {
                messages: 1,
                unread: 1,
                incomplete: 1,
                highPriority: 1,
                onlineAgents: 1,
              },
            },
          },
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'client.event',
          event: {
            id: 'mobile-mailbox-event',
            type: 'mailbox.event',
            schemaVersion: HQ_PROTOCOL_VERSION,
            timestamp: now,
            clientId,
            projectId,
            sessionId,
            seq: 5,
            payload: {
              mailboxId: 'mobile-project:mailbox',
              action: 'message.sent',
              message: {
                mailId: 'mobile-mail-1',
                messageId: 'mobile-message-1',
                from: 'reviewer-1',
                to: 'leader',
                type: 'ask',
                subject: 'Approve production rollout',
                priority: 'high',
                timestamp: now,
                completed: false,
                hasBody: true,
                bodyPreview: 'Deployment is waiting for operator approval.',
              },
            },
          },
        }),
      );
      // The VPS reports its health: memory nearly exhausted.
      socket.send(
        JSON.stringify({
          type: 'client.event',
          event: {
            id: 'mobile-heartbeat',
            type: 'client.heartbeat',
            schemaVersion: HQ_PROTOCOL_VERSION,
            timestamp: now,
            clientId,
            projectId,
            seq: 6,
            payload: {
              uptimeMs: 60_000,
              status: 'idle',
              host: {
                platform: 'linux',
                arch: 'arm64',
                cpuCount: 2,
                loadAvg1: 1.9,
                memTotalBytes: 4 * 1024 ** 3,
                memAvailableBytes: 100 * 1024 ** 2,
                osUptimeSec: 86_400,
                diskTotalBytes: 80 * 1024 ** 3,
                diskFreeBytes: 40 * 1024 ** 3,
                processRssBytes: 250 * 1024 ** 2,
              },
            },
          },
        }),
      );

      const { chromium } = await import('@playwright/test');
      browser = await chromium.launch();
      // axe needs a page that belongs to an explicit context.
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      const { default: AxeBuilder } = await import('@axe-core/playwright');
      const a11y: string[] = [];
      const audit = async (name: string): Promise<void> => {
        const result = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        for (const violation of result.violations) {
          const nodes = violation.nodes.slice(0, 3).map((node) => node.target.join(' '));
          a11y.push(`${name}: ${violation.id} (${violation.impact}) ${nodes.join(', ')}`);
        }
      };
      const errors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      page.on('pageerror', (error) => errors.push(String(error)));

      await page.goto(`http://127.0.0.1:${handle.port}/mobile/`);
      await page.locator('#hq-password-input').waitFor();
      await audit('00-login');
      await page.locator('#hq-password-input').fill(PASSWORD);
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.waitForSelector('[data-testid="hq-mobile"]');
      const shots = path.join(os.tmpdir(), 'wrongstack-hq-mobile-smoke');
      await fs.mkdir(shots, { recursive: true });
      const shot = async (name: string): Promise<void> => {
        await page.screenshot({ path: path.join(shots, `${name}.png`) });
        await audit(name);
      };
      const [manifestResponse, workerResponse] = await Promise.all([
        page.request.get(`http://127.0.0.1:${handle.port}/manifest.webmanifest`),
        page.request.get(`http://127.0.0.1:${handle.port}/mobile-sw.js`),
      ]);
      expect(manifestResponse.status()).toBe(200);
      expect(manifestResponse.headers()['content-type']).toContain('application/manifest+json');
      expect(workerResponse.status()).toBe(200);
      await expect
        .poll(() =>
          page.evaluate(
            async () => (await navigator.serviceWorker.getRegistration('/mobile')) !== undefined,
          ),
        )
        .toBe(true);
      const adminResponse = await page.request.get(
        `http://127.0.0.1:${handle.port}/api/auth/sessions`,
      );
      expect(adminResponse.status()).toBe(403);
      const runCommandResponse = await page.request.post(
        `http://127.0.0.1:${handle.port}/api/command`,
        {
          data: {
            clientId,
            type: 'run-command',
            payload: { sessionId, command: 'whoami' },
          },
        },
      );
      expect(runCommandResponse.status()).toBe(403);
      expect(await runCommandResponse.text()).toContain(
        'browser session lacks control.execute capability',
      );
      // Chat: a fresh phone opens the first live conversation and steers it.
      await page
        .getByRole('navigation', { name: 'Sections' })
        .getByRole('link', { name: 'Chat' })
        .click();
      await page.waitForURL(/\/mobile\/chat\/\?session=/);
      expect(new URL(page.url()).searchParams.get('session')).toBe(sessionId);
      await expect.poll(() => page.locator('main').textContent()).toContain('Mobile HQ is online.');
      await shot('01-chat');
      await page.getByLabel('Message Leader agent').fill('report current deployment status');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect
        .poll(() => page.getByRole('status').first().textContent())
        .toContain('Queued for');

      const commandPromise = waitForCommand(socket);
      socket.send(
        JSON.stringify({
          type: 'client.command_poll',
          clientId,
          projectId,
          limit: 25,
        }),
      );
      const command = await commandPromise;
      expect(command['type']).toBe('steer');
      expect(command['payload']).toMatchObject({
        sessionId,
        to: 'leader',
        body: 'report current deployment status',
      });
      socket.send(
        JSON.stringify({
          type: 'client.command_ack',
          clientId,
          projectId,
          commandId: command['commandId'],
          status: 'completed',
          message: 'steered',
        }),
      );

      // Mail: the mailbox message is readable on the phone.
      await page
        .getByRole('navigation', { name: 'Sections' })
        .getByRole('link', { name: /^Mail/ })
        .click();
      await page.waitForURL(/\/mobile\/mail\//);
      await expect
        .poll(() => page.locator('main').textContent())
        .toContain('Approve production rollout');
      await page.locator('[data-mail="mobile-mail-1"]').click();
      await expect
        .poll(() => page.locator('main').textContent())
        .toContain('Deployment is waiting for operator approval.');
      await shot('02-mail');

      // Now: the waiting agent is in the queue and opens its conversation.
      await page
        .getByRole('navigation', { name: 'Sections' })
        .getByRole('link', { name: /^Now/ })
        .click();
      await page.waitForURL(/\/mobile\/(\?|$)/);
      await shot('03-now');
      // The phone keeps its own scope: narrowing it here leaves the desktop
      // scope alone, and the queue badge still counts the whole fleet.
      await page.getByTestId('scope-picker').click();
      await page.getByRole('menuitem', { name: 'Mobile Project' }).click();
      await expect.poll(() => page.getByRole('menu').count()).toBe(0);
      await expect
        .poll(async () => page.getByTestId('scope-picker').textContent())
        .toContain('Mobile Project');
      await shot('03a-now-scoped');
      const prefs = await page.evaluate(() =>
        JSON.parse(window.localStorage.getItem('wrongstack.hq.local-prefs.v1') ?? '{}'),
      );
      expect(prefs.fleet).toMatchObject({ scope: 'all', phoneScope: 'project' });
      await page.getByTestId('scope-picker').click();
      await page.getByRole('menuitem', { name: 'Whole fleet' }).click();
      await expect.poll(() => page.getByRole('menu').count()).toBe(0);
      // A tap swaps the queue for the card (no stacked list pushing it off-screen);
      // Back returns to the queue.
      await page.locator('main button', { hasText: 'reviewer' }).first().click();
      await expect.poll(() => page.locator('[data-item]').first().isVisible()).toBe(false);
      await shot('03b-now-card');
      await page.getByRole('button', { name: 'All items' }).click();
      await expect.poll(() => page.locator('[data-item]').first().isVisible()).toBe(true);
      await page.locator('main button', { hasText: 'reviewer' }).first().click();
      await page.getByRole('button', { name: 'Open conversation' }).click();
      await page.waitForURL(/\/mobile\/chat\//);
      await expect.poll(() => new URL(page.url()).searchParams.get('agent')).toBe('reviewer-1');

      // Fleet: the VPS is flagged short of memory; it opens in place with its reading.
      await page
        .getByRole('navigation', { name: 'Sections' })
        .getByRole('link', { name: 'Fleet' })
        .click();
      await page.waitForURL(/\/mobile\/fleet\//);
      const vps = page.locator('[data-mobile-machine="host:vps-mobile"]');
      await vps.waitFor({ timeout: 10_000 });
      expect(await page.getByTestId('mobile-fleet-headline').textContent()).toBe(
        '1 of 1 machine online',
      );
      expect(await vps.textContent()).toContain('Short of memory');
      await vps.click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get('machine'))
        .toBe('host:vps-mobile');
      const detail = page.getByTestId('mobile-machine-detail');
      expect(await detail.textContent()).toContain('VPS-MOBILE is short of memory');
      expect(await detail.textContent()).toContain('load 1.90 on 2 cores');
      await shot('03c-fleet');
      // Its attention link opens the item's card in the installed app, not the desktop.
      expect(
        await detail.getByRole('link', { name: /short of memory/ }).getAttribute('href'),
      ).toMatch(/^\/mobile\/\?item=host-memory/);

      // Projects, the Fleet tab's second list: the project opens in place and
      // its links stay inside the installed app.
      await page
        .getByRole('navigation', { name: 'Fleet lists' })
        .getByRole('link', { name: 'Projects' })
        .click();
      await page.waitForURL(/\/mobile\/fleet\/projects\//);
      expect(
        await page
          .getByRole('navigation', { name: 'Sections' })
          .getByRole('link', { name: 'Fleet' })
          .getAttribute('aria-current'),
      ).toBe('page');
      const project = page.locator('[data-mobile-project="mobile-project"]');
      await project.waitFor({ timeout: 10_000 });
      expect(await page.getByTestId('mobile-projects-headline').textContent()).toBe(
        '1 of 1 project with a session open',
      );
      expect(await project.textContent()).toContain('Mobile Project');
      await project.click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get('project'))
        .toBe('mobile-project');
      const projectDetail = page.getByTestId('mobile-project-detail');
      expect(
        await projectDetail
          .getByRole('link', { name: /VPS-MOBILE/ })
          .first()
          .getAttribute('href'),
      ).toMatch(/^\/mobile\/fleet\/\?machine=host%3Avps-mobile/);
      expect(
        await projectDetail.getByRole('link', { name: 'Open its board' }).getAttribute('href'),
      ).toBe('/mobile/board/?project=mobile-project');
      await shot('03d-projects');

      // Board: move, assign and (after confirming) dispatch from the phone.
      await page
        .getByRole('navigation', { name: 'Sections' })
        .getByRole('link', { name: 'Board' })
        .click();
      await page.waitForURL(/\/mobile\/board\//);
      await page.locator('[data-task="deploy-task"]').click();
      await expect.poll(() => page.getByLabel('Move to stage').inputValue()).toBe('review');
      await shot('04-board-task');
      await page.getByRole('button', { name: 'Move', exact: true }).click();
      await expect
        .poll(() => page.getByRole('status').first().textContent())
        .toContain('Move queued');
      const kanbanCommandPromise = waitForCommand(socket);
      socket.send(
        JSON.stringify({
          type: 'client.command_poll',
          clientId,
          projectId,
          afterCommandId: command['commandId'],
          limit: 25,
        }),
      );
      const kanbanCommand = await kanbanCommandPromise;
      expect(kanbanCommand).toMatchObject({
        type: 'kanban-transition',
        payload: {
          boardId: 'mobile-board',
          taskId: 'deploy-task',
          to: 'review',
        },
      });

      await page
        .getByLabel('Assign to agent')
        .selectOption({ label: 'reviewer · VPS-MOBILE · waiting_user' });
      await page.getByRole('button', { name: 'Assign', exact: true }).click();
      await expect
        .poll(() => page.getByRole('status').first().textContent())
        .toContain('Assign queued');
      const assignmentCommandPromise = waitForCommand(socket);
      socket.send(
        JSON.stringify({
          type: 'client.command_poll',
          clientId,
          projectId,
          afterCommandId: kanbanCommand['commandId'],
          limit: 25,
        }),
      );
      const assignmentCommand = await assignmentCommandPromise;
      expect(assignmentCommand).toMatchObject({
        type: 'kanban-assign',
        payload: {
          boardId: 'mobile-board',
          taskId: 'deploy-task',
          agentId: 'reviewer-1',
          assignee: 'reviewer',
        },
      });

      await page.getByRole('button', { name: 'Close task' }).click();
      await page.locator('[data-task="ready-task"]').click();
      await page.getByRole('button', { name: /Start a worker/ }).click();
      await page.getByRole('button', { name: 'Confirm: start worker' }).click();
      await expect
        .poll(() => page.getByRole('status').first().textContent())
        .toContain('Dispatch queued');
      const dispatchCommandPromise = waitForCommand(socket);
      socket.send(
        JSON.stringify({
          type: 'client.command_poll',
          clientId,
          projectId,
          afterCommandId: assignmentCommand['commandId'],
          limit: 25,
        }),
      );
      const dispatchCommand = await dispatchCommandPromise;
      expect(dispatchCommand).toMatchObject({
        type: 'kanban-dispatch',
        payload: { boardId: 'mobile-board', taskId: 'ready-task' },
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
      expect(errors).toEqual([]);
      // The phone in the light theme: every tab, checked the same way.
      await page.evaluate(() => {
        const key = 'wrongstack.hq.local-prefs.v1';
        const prefs = JSON.parse(window.localStorage.getItem(key) ?? '{}');
        prefs.appearance = { ...(prefs.appearance ?? {}), theme: 'light' };
        window.localStorage.setItem(key, JSON.stringify(prefs));
      });
      for (const route of [
        '/mobile/',
        '/mobile/chat/',
        '/mobile/board/',
        '/mobile/mail/',
        '/mobile/fleet/',
        '/mobile/fleet/projects/',
      ]) {
        await page.goto(`http://127.0.0.1:${handle.port}${route}`);
        await page.waitForSelector('[data-testid="hq-mobile"]');
        await page.waitForLoadState('networkidle');
        expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(
          false,
        );
        await audit(`light${route.replaceAll('/', '-')}`);
      }

      await fs.writeFile(path.join(shots, 'a11y.txt'), a11y.join('\n'));
      expect(a11y).toEqual([]);
    } finally {
      await browser?.close().catch(() => undefined);
      socket?.close();
      await handle?.close().catch(() => undefined);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
