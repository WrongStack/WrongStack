/// <reference lib="dom" />
/**
 * Opt-in mobile HQ acceptance: password login -> /mobile shell -> live session
 * -> command delivery over the real client WebSocket.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HQ_PROTOCOL_VERSION } from '@wrongstack/core/hq';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';
import { resolveHqDistDir } from '../src/hq-static-serve.js';

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
    const onMessage = (data: WebSocket.RawData): void => {
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
    expect(resolveHqDistDir(), 'webui-hq dist must be built').not.toBeNull();
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

      const { chromium } = await import('@playwright/test');
      browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const errors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      page.on('pageerror', (error) => errors.push(String(error)));

      await page.goto(`http://127.0.0.1:${handle.port}/mobile`);
      await page.locator('#hq-password-input').fill(PASSWORD);
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.waitForSelector('[data-testid="hq-mobile"]');
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
      await expect.poll(() => page.getByLabel('Mobile session').inputValue()).toBe(sessionId);
      await expect.poll(() => page.getByText('Mobile HQ is online.').isVisible()).toBe(true);
      await expect.poll(() => page.getByText('control', { exact: true }).isVisible()).toBe(true);

      await page.getByLabel('Message Leader').fill('report current deployment status');
      await page.getByRole('button', { name: 'Send message' }).click();
      await expect.poll(() => page.getByRole('status').textContent()).toContain('steer queued');

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

      await page.getByTestId('mobile-pane').filter({ hasText: 'Inbox' }).click();
      await expect
        .poll(() => page.getByTestId('mobile-inbox').textContent())
        .toContain('Approve production rollout');
      await expect
        .poll(() => page.getByTestId('mobile-inbox').textContent())
        .toContain('Deployment is waiting for operator approval.');

      await page.getByTestId('mobile-pane').filter({ hasText: 'Attention' }).click();
      await expect
        .poll(() => page.getByTestId('mobile-attention').textContent())
        .toContain('reviewer · waiting_user');
      await expect
        .poll(() => page.getByTestId('mobile-attention').textContent())
        .toContain('1 unread mailbox message');
      await page.getByRole('button', { name: 'Open' }).click();
      await expect.poll(() => page.getByLabel('Mobile agent').inputValue()).toBe('reviewer-1');

      await page.getByTestId('mobile-pane').filter({ hasText: 'Kanban' }).click();
      await expect
        .poll(() => page.getByTestId('mobile-kanban').textContent())
        .toContain('Deploy production');
      await page.getByRole('button', { name: /Deploy production in_progress/ }).click();
      await expect
        .poll(() => page.getByLabel('Kanban transition target').inputValue())
        .toBe('review');
      await page.getByRole('button', { name: 'Confirm transition' }).click();
      await expect
        .poll(() => page.getByTestId('mobile-kanban').textContent())
        .toContain('Transition queued');
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

      await page.getByRole('button', { name: 'Assign Deploy production' }).click();
      await page
        .getByLabel('Kanban assignment target')
        .selectOption({ label: 'reviewer · VPS-MOBILE · waiting_user' });
      await expect
        .poll(() => page.getByLabel('Kanban assignment target').inputValue())
        .toContain('reviewer-1');
      await page.getByRole('button', { name: 'Confirm assignment' }).click();
      await expect
        .poll(() => page.getByTestId('mobile-kanban').textContent())
        .toContain('Assignment queued');
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
        },
      });

      await page.getByRole('button', { name: 'Dispatch Run migration checks' }).click();
      await expect
        .poll(() =>
          page.getByText('the Director will claim the ready card', { exact: false }).isVisible(),
        )
        .toBe(true);
      await page.getByRole('button', { name: 'Confirm dispatch' }).click();
      await expect
        .poll(() => page.getByTestId('mobile-kanban').textContent())
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
    } finally {
      await browser?.close().catch(() => undefined);
      socket?.close();
      await handle?.close().catch(() => undefined);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
