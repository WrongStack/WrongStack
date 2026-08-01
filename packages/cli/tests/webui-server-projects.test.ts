import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWebUI } from '../src/webui-server.js';
import { openWs } from './_ws-client.js';

const ports = { next: 45_840 };
const nextPort = (): number => ports.next++;

let serverDone: Promise<void> | null = null;
let tmpDir: string;
let globalConfigPath: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ws-projects-test-'));
  globalConfigPath = path.join(tmpDir, 'config.json');
  await fs.promises.writeFile(
    globalConfigPath,
    JSON.stringify({ providers: [{ id: 'test-provider', family: 'anthropic', models: [] }] }, null, 2),
  );
});

afterEach(async () => {
  if (serverDone) {
    process.emit('SIGTERM');
    await serverDone;
    serverDone = null;
  }
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Regression: `projects.select` used to spawn a whole new interactive wstack
 * into the host terminal and change NOTHING in the browser — the WebUI stayed
 * rooted in the old project (sessions, file manager, mailbox all unchanged).
 * It must now switch in-process: re-root projectRoot/ctx, swap the session
 * store, and broadcast a reset session.start carrying the new cwd.
 */
describe('runWebUI projects.select', () => {
  it('switches the server to the selected project in-process', async () => {
    const wsPort = nextPort();
    const httpPort = wsPort; // single-port design: HTTP and WS share one listener
    let signalReady: (() => void) | undefined;
    const listening = new Promise<void>((r) => { signalReady = r; });

    const projectA = path.join(tmpDir, 'project-a');
    const projectB = path.join(tmpDir, 'project-b');
    await fs.promises.mkdir(projectA, { recursive: true });
    await fs.promises.mkdir(projectB, { recursive: true });

    const oldWriter = {
      id: 'old-session',
      append: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const ctx = {
      model: 'test-model',
      provider: { id: 'test-provider' },
      projectRoot: projectA,
      cwd: projectA,
      messages: [],
      todos: [],
      meta: {},
      readFiles: new Set<string>(),
      fileMtimes: new Map<string, number>(),
      tokenCounter: {
        total: () => ({ input: 0, output: 0 }),
        reset: vi.fn(),
        cacheStats: () => ({}),
      },
      state: { replaceMessages: vi.fn(), replaceTodos: vi.fn() },
      session: oldWriter,
    };

    serverDone = runWebUI({
      port: wsPort,
      httpPort,
      profileConfigPath: '/tmp/test-profile.json',
  onListening: () => signalReady?.(),
      events: new EventBus(),
      session: { id: 'old-session' } as never,
      agent: { ctx: ctx as never, run: vi.fn() } as never,
      projectRoot: projectA,
      globalConfigPath,
    });

    await listening;
    const { ws, waitForMessage } = await openWs(`ws://127.0.0.1:${wsPort}`);
    const initial = await waitForMessage('session.start');
    expect((initial.payload as { cwd: string }).cwd).toBe(projectA);

    ws.send(JSON.stringify({ type: 'projects.select', payload: { root: projectB, name: 'beta' } }));

    const selected = await waitForMessage('projects.selected');
    expect((selected.payload as { message: string }).message).toContain('Switched to beta');
    expect((selected.payload as { root: string }).root).toBe(path.resolve(projectB));

    // The broadcast reset re-roots every client panel.
    const restarted = await waitForMessage('session.start');
    const payload = restarted.payload as { cwd: string; reset?: boolean; clearedSessionId?: string };
    expect(payload.reset).toBe(true);
    expect(payload.cwd).toBe(path.resolve(projectB));
    expect(payload.clearedSessionId).toBe('old-session');

    // Old writer finalized; ctx re-rooted; fresh writer swapped in.
    expect(oldWriter.close).toHaveBeenCalled();
    expect(ctx.projectRoot).toBe(path.resolve(projectB));
    expect(ctx.cwd).toBe(path.resolve(projectB));
    expect((ctx.session as { id: string }).id).not.toBe('old-session');
    expect(ctx.tokenCounter.reset).toHaveBeenCalled();
    expect(ctx.state.replaceMessages).toHaveBeenCalledWith([]);

    // The manifest auto-registered the new root.
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(tmpDir, 'projects.json'), 'utf8'),
    ) as { projects: Array<{ root: string; name: string }> };
    expect(manifest.projects.some((p) => path.resolve(p.root) === path.resolve(projectB))).toBe(true);

    ws.close();
  });

  it('projects.add registers a folder; working_dir.set stays inside the root', async () => {
    const wsPort = nextPort();
    const httpPort = wsPort; // single-port design: HTTP and WS share one listener
    let signalReady: (() => void) | undefined;
    const listening = new Promise<void>((r) => { signalReady = r; });

    const projectA = path.join(tmpDir, 'project-a');
    const newProject = path.join(tmpDir, 'fresh-project');
    const subDir = path.join(projectA, 'src');
    await fs.promises.mkdir(subDir, { recursive: true });
    await fs.promises.mkdir(newProject, { recursive: true });

    const ctx = {
      model: 'test-model',
      provider: { id: 'test-provider' },
      projectRoot: projectA,
      cwd: projectA,
      messages: [],
      todos: [],
      meta: {},
      readFiles: new Set<string>(),
      fileMtimes: new Map<string, number>(),
      tokenCounter: { total: () => ({ input: 0, output: 0 }), reset: vi.fn(), cacheStats: () => ({}) },
      state: { replaceMessages: vi.fn(), replaceTodos: vi.fn() },
    };

    serverDone = runWebUI({
      port: wsPort,
      httpPort,
      profileConfigPath: '/tmp/test-profile.json',
  onListening: () => signalReady?.(),
      events: new EventBus(),
      session: { id: 'sess-1' } as never,
      agent: { ctx: ctx as never, run: vi.fn() } as never,
      projectRoot: projectA,
      globalConfigPath,
    });

    await listening;
    const { ws, waitForMessage } = await openWs(`ws://127.0.0.1:${wsPort}`);
    await waitForMessage('session.start');

    // projects.add — used to be an unknown message on the embedded server.
    ws.send(JSON.stringify({ type: 'projects.add', payload: { root: newProject, name: 'Fresh' } }));
    const added = await waitForMessage('projects.added');
    expect((added.payload as { message: string }).message).toContain('Registered project "Fresh"');
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(tmpDir, 'projects.json'), 'utf8'),
    ) as { projects: Array<{ root: string }> };
    expect(manifest.projects.some((p) => path.resolve(p.root) === path.resolve(newProject))).toBe(true);

    // working_dir.set within the project root updates ctx.cwd + broadcasts.
    ws.send(JSON.stringify({ type: 'working_dir.set', payload: { path: 'src' } }));
    const changed = await waitForMessage('working_dir.changed');
    expect((changed.payload as { cwd: string }).cwd).toBe(path.resolve(subDir));
    expect(ctx.cwd).toBe(path.resolve(subDir));
    // Drain the success result so the rejection below reads ITS result.
    const okResult = await waitForMessage('key.operation_result');
    expect((okResult.payload as { success: boolean }).success).toBe(true);

    // Escaping the project root is rejected.
    ws.send(JSON.stringify({ type: 'working_dir.set', payload: { path: '..' } }));
    const rejected = await waitForMessage('key.operation_result');
    expect((rejected.payload as { success: boolean }).success).toBe(false);
    expect(ctx.cwd).toBe(path.resolve(subDir));

    ws.close();
  });
});
