import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/core/kernel';
import { createProjectMailbox, resolveProjectDir } from '@wrongstack/core/coordination';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWebUI } from '../src/webui-server.js';
import { openWs } from './_ws-client.js';

const ports = { next: 45_720 };
const nextPort = (): number => ports.next++;

let serverDone: Promise<void> | null = null;
let tmpDir: string;
let globalConfigPath: string;
/** Project state dirs whose detached mailbox owner must be stopped on teardown. */
const mailboxProjectDirs: string[] = [];
/** Mailbox wrappers a test opened; closed before their owners are shut down. */
const openMailboxes: Array<{ close(): Promise<void> }> = [];

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ws-mailbox-test-'));
  // Create a minimal config.json with providers to satisfy config loading
  globalConfigPath = path.join(tmpDir, 'config.json');
  await fs.promises.writeFile(globalConfigPath, JSON.stringify({
    providers: [{ id: 'test-provider', family: 'anthropic', models: [] }],
  }, null, 2));
});

afterEach(async () => {
  if (serverDone) {
    process.emit('SIGTERM');
    await serverDone;
    serverDone = null;
  }
  // Each project mailbox has a detached owner holding `_mailbox.sqlite` open;
  // Windows refuses to remove the directory while it lives.
  for (const mailbox of openMailboxes.splice(0)) await mailbox.close().catch(() => undefined);
  const { MailboxProjectServerConnection } = await import('@wrongstack/core/coordination');
  for (const projectDir of mailboxProjectDirs.splice(0)) {
    const control = new MailboxProjectServerConnection(projectDir);
    try {
      await control.shutdown('test-teardown');
    } catch {
      // No owner running, or it exited on its own.
    } finally {
      control.close();
    }
  }
  // Best-effort: an owner that was still starting up when the shutdown request
  // arrived can hold the project directory a moment longer, and Windows `rm`
  // then blocks on EBUSY past the hook timeout. Vitest's daemon reaper cleans
  // up the process at the end of the run either way.
  await fs.promises
    .rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    .catch(() => undefined);
});

describe('runWebUI mailbox operations', () => {
  it('mailbox.clear sends mailbox.cleared response', async () => {
    const wsPort = nextPort();
    const httpPort = wsPort; // single-port design: HTTP and WS share one listener
    let signalReady: (() => void) | undefined;
    const listening = new Promise<void>((r) => { signalReady = r; });

    const projectRoot = path.join(tmpDir, 'project');
    await fs.promises.mkdir(projectRoot, { recursive: true });

    serverDone = runWebUI({
      port: wsPort,
      httpPort,
      onListening: () => signalReady?.(),
      events: new EventBus(),
      session: { id: 'test-session' } as never,
      agent: {
        ctx: { model: 'test-model', provider: { id: 'test-provider' }, projectRoot } as never,
        run: vi.fn(),
      } as never,
      projectRoot,
      globalConfigPath,
    });

    await listening;
    const { ws, waitForMessage } = await openWs(`ws://127.0.0.1:${wsPort}`);
    await waitForMessage('session.start');

    // Send mailbox.clear and expect mailbox.cleared response
    ws.send(JSON.stringify({ type: 'mailbox.clear' }));
    const cleared = await waitForMessage('mailbox.cleared');
    expect(cleared.type).toBe('mailbox.cleared');
    expect(cleared.payload).toEqual({});

    ws.close();
  });

  it('mailbox.clear returns error when no project root is available', async () => {
    const wsPort = nextPort();
    const httpPort = wsPort; // single-port design: HTTP and WS share one listener
    let signalReady: (() => void) | undefined;
    const listening = new Promise<void>((r) => { signalReady = r; });

    serverDone = runWebUI({
      port: wsPort,
      httpPort,
      onListening: () => signalReady?.(),
      events: new EventBus(),
      session: { id: 'test-session' } as never,
      agent: {
        ctx: { model: 'test-model', provider: { id: 'test-provider' } } as never,
        run: vi.fn(),
      } as never,
      // No projectRoot or globalConfigPath — should return an error
    });

    await listening;
    const { ws, waitForMessage } = await openWs(`ws://127.0.0.1:${wsPort}`);
    await waitForMessage('session.start');

    ws.send(JSON.stringify({ type: 'mailbox.clear' }));
    const cleared = await waitForMessage('mailbox.cleared');
    expect(cleared.type).toBe('mailbox.cleared');
    expect(cleared.payload).toHaveProperty('error');

    ws.close();
  });

  it('mailbox.clear actually clears messages from the mailbox', async () => {
    const wsPort = nextPort();
    const httpPort = wsPort; // single-port design: HTTP and WS share one listener
    let signalReady: (() => void) | undefined;
    const listening = new Promise<void>((r) => { signalReady = r; });

    const projectRoot = path.join(tmpDir, 'project');
    await fs.promises.mkdir(projectRoot, { recursive: true });

    // Pre-populate the mailbox with a message. The dir must be the SAME one
    // the server resolves (globalRoot = dirname(globalConfigPath) = tmpDir),
    // so use the canonical resolveProjectDir instead of a hand-rolled slug.
    const mbDir = resolveProjectDir(projectRoot, tmpDir);
    await fs.promises.mkdir(mbDir, { recursive: true });
    mailboxProjectDirs.push(mbDir);
    const mb = createProjectMailbox({ projectDir: mbDir, isolatedConnection: true });
    openMailboxes.push(mb);
    await mb.send({ from: 'agent#1', to: '*', type: 'broadcast', subject: 'test', body: 'test message' });

    serverDone = runWebUI({
      port: wsPort,
      httpPort,
      onListening: () => signalReady?.(),
      events: new EventBus(),
      session: { id: 'test-session' } as never,
      agent: {
        ctx: { model: 'test-model', provider: { id: 'test-provider' }, projectRoot } as never,
        run: vi.fn(),
      } as never,
      projectRoot,
      globalConfigPath,
    });

    await listening;
    const { ws, waitForMessage } = await openWs(`ws://127.0.0.1:${wsPort}`);
    await waitForMessage('session.start');

    // Verify there's a message
    ws.send(JSON.stringify({ type: 'mailbox.messages', payload: { limit: 10 } }));
    const messagesResp = await waitForMessage('mailbox.messages');
    expect((messagesResp.payload as { messages: unknown[] }).messages.length).toBeGreaterThan(0);

    // Clear the mailbox
    ws.send(JSON.stringify({ type: 'mailbox.clear' }));
    const cleared = await waitForMessage('mailbox.cleared');
    expect(cleared.type).toBe('mailbox.cleared');

    // Verify the mailbox is now empty (re-request — responses are not pushed)
    ws.send(JSON.stringify({ type: 'mailbox.messages', payload: { limit: 10 } }));
    const messagesResp2 = await waitForMessage('mailbox.messages');
    expect((messagesResp2.payload as { messages: unknown[] }).messages).toHaveLength(0);

    ws.close();
  });
});
