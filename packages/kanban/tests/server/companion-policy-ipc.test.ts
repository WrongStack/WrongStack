/**
 * Durable Kanban companion policy over real IPC.
 *
 * Drives the public API (`@wrongstack/kanban`) against a spawned project
 * daemon (`dist/project-server.js`) with `WRONGSTACK_KANBAN_FORCE_IPC=1`, so
 * every policy read/write, claim, renewal and board read crosses the daemon
 * boundary exactly as it does in production — and the policy record lands in
 * the daemon's SQLite metadata, where a restart must find it.
 *
 * Modelled on `tests/sqlite-project-server.test.ts`.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimBoardManagement,
  getKanbanCompanionEnabled,
  getKanbanServerConnection,
  kanbanProjectServerEndpoint,
  managementTaskVersion,
  renewBoardManagement,
  setKanbanCompanionEnabled,
  updateTask,
} from '../../src/index.js';
import { addTask, createBoard, getBoard } from '../helpers/session-manager.js';

// Emitted at the dist ROOT, not under dist/server/: `client.ts` is bundled
// into dist/index.js, so its spawn URL resolves next to the index bundle.
const distServer = fileURLToPath(new URL('../../dist/project-server.js', import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  delete process.env['WRONGSTACK_KANBAN_FORCE_IPC'];
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('durable Kanban companion policy over IPC', () => {
  it('publishes, enforces, and persists the policy across a daemon restart', async () => {
    process.env['WRONGSTACK_KANBAN_FORCE_IPC'] = '1';
    const root = await tempRoot('policy-ipc');
    const endpoint = kanbanProjectServerEndpoint(root);
    const first = startDaemon(root);
    await waitForEndpoint(endpoint);

    // Default policy is enabled, read through the daemon.
    expect(await getKanbanCompanionEnabled(root)).toBe(true);

    const board = await createBoard(root, { title: 'Companion IPC' });
    await addTask(root, board.id, { title: 'Card' });
    const claimInput = (token: string, fingerprint: string) => ({
      token,
      fingerprint,
      cooldownMs: 0,
    });
    expect(await claimBoardManagement(root, board.id, claimInput('ipc-1', 'fp-1'))).toBe(true);
    const leasedBoard = (await getBoard(root, board.id))!;
    const task = leasedBoard.tasks[0]!;
    const managerEdit = (description: string, reviewedBoard = leasedBoard) =>
      updateTask(
        root,
        board.id,
        task.id,
        { description },
        {
          sessionId: 'manager-session',
          expectedManagementToken: 'ipc-1',
          expectedManagementTaskVersions: {
            [task.id]: managementTaskVersion(reviewedBoard, reviewedBoard.tasks[0]!),
          },
        },
      );
    const edited = (await managerEdit('Saved before disabling'))!;

    // Disable over IPC: no more edits from the old manager, even using a current card version.
    expect(await setKanbanCompanionEnabled(root, false)).toBe(false);
    expect(await getKanbanCompanionEnabled(root)).toBe(false);
    await expect(managerEdit('Must not be written', edited)).rejects.toThrow(/companion|lease/i);
    expect((await getBoard(root, board.id))?.tasks[0]?.description).toBe('Saved before disabling');
    expect(await claimBoardManagement(root, board.id, claimInput('ipc-2', 'fp-2'))).toBe(false);
    const fenced = await getBoard(root, board.id);
    expect(fenced?.management?.lease).toBeUndefined();
    expect(fenced?.management?.status).toBe('failed');

    // Durability: the policy record survives a full daemon restart.
    const firstConnection = await getKanbanServerConnection(root);
    await firstConnection!.request('shutdown', { reason: 'companion-policy-restart' });
    await waitForExit(first);

    const second = startDaemon(root);
    await waitForEndpoint(endpoint);
    expect(await getKanbanCompanionEnabled(root)).toBe(false);
    // The pre-restart worker stays fenced across re-enable.
    expect(await renewBoardManagement(root, board.id, 'ipc-1')).toBe(false);
    expect(await setKanbanCompanionEnabled(root, true)).toBe(true);
    expect(await renewBoardManagement(root, board.id, 'ipc-1')).toBe(false);
    // A fresh claim is accepted and carries the current epoch.
    expect(await claimBoardManagement(root, board.id, claimInput('ipc-2', 'fp-2'))).toBe(true);
    const claimed = await getBoard(root, board.id);
    expect(claimed?.management?.lease?.token).toBe('ipc-2');
    expect(claimed?.management?.lease?.companionEpoch).toBe(1);

    const lastConnection = await getKanbanServerConnection(root);
    await lastConnection!.request('shutdown', { reason: 'test-complete' });
    await waitForExit(second);
  });
});

async function tempRoot(label: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `wstack-kanban-${label}-`));
  roots.push(root);
  return root;
}

function startDaemon(projectRoot: string): ChildProcess {
  const child = spawn(process.execPath, [distServer, '--project-root', projectRoot], {
    env: {
      ...process.env,
      WRONGSTACK_KANBAN_FORCE_IPC: '1',
      WRONGSTACK_KANBAN_SERVER_IDLE_MS: '30000',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  children.push(child);
  return child;
}

async function waitForEndpoint(endpoint: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(endpoint);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (connected) return;
    if (Date.now() >= deadline) throw new Error(`Kanban endpoint did not open: ${endpoint}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Kanban daemon did not exit')), 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
