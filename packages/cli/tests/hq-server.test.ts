import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProjectMailbox } from '@wrongstack/core/coordination';
import { HQ_AUTH_FILE_VERSION, HQ_PROTOCOL_VERSION, writeHqAuthFile } from '@wrongstack/core/hq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createCliHqPublisher } from '../src/hq-publisher.js';
import { HQ_HTML, type HqServerHandle, startHqServer } from '../src/hq-server.js';
import { removeMailboxTempRoot } from './helpers/mailbox-daemon.js';

let handle: HqServerHandle | null = null;
let tempRoot: string;
let dataDir: string;

beforeEach(async () => {
  // Keep the HQ data dir one level below a per-test global root. The server
  // resolves the SessionRegistry from dirname(dataDir); placing dataDir
  // directly in os.tmpdir made every parallel test worker share the same
  // os.tmpdir/session-registry.json file, where a concurrent worker's
  // registry write can drop this test's seeded session under load.
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-server-'));
  dataDir = path.join(tempRoot, 'hq');
  await fs.mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  await stopProjectMailboxOwners();
  await removeMailboxTempRoot(tempRoot);
});

/**
 * Stop every detached mailbox owner this test started.
 *
 * The HQ server resolves project mailboxes SERVER-side (from a sessionId or
 * projectId), so the test never holds a handle to them — but each one leaves a
 * daemon whose cwd is the project directory, which Windows then refuses to
 * remove. Sweep whatever landed under `<tempRoot>/projects` plus the HQ data
 * dir, which doubles as a project dir in the same-process publisher test.
 */
async function stopProjectMailboxOwners(): Promise<void> {
  const { MailboxProjectServerConnection } = await import('@wrongstack/core/coordination');
  const candidates = [dataDir];
  try {
    const projectsRoot = path.join(tempRoot, 'projects');
    for (const entry of await fs.readdir(projectsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(projectsRoot, entry.name));
    }
  } catch {
    // No project mailboxes were created.
  }
  for (const projectDir of candidates) {
    const control = new MailboxProjectServerConnection(projectDir);
    try {
      await control.shutdown('test-teardown');
    } catch {
      // No owner running, or it exited on its own.
    } finally {
      control.close();
    }
  }
}

async function startOpenHqServer(
  options: Omit<Parameters<typeof startHqServer>[0], 'dataDir'> = {},
): Promise<HqServerHandle> {
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [],
    clientTokens: [],
  });
  return startHqServer({ host: '127.0.0.1', ...options, dataDir });
}

function getPort(): number {
  // Use a random high port to avoid conflicts with running services.
  return 30_000 + Math.floor(Math.random() * 10_000);
}

function occupyPort(port: number, host = '127.0.0.1'): Promise<http.Server> {
  const server = http.createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function waitForOpen(ws: WebSocket, timeout = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS open timeout')), timeout);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

interface HqSnapshotMessage {
  type: 'hq.snapshot';
  snapshot: {
    totals: {
      activeClients: number;
      unreadMailboxMessages: number;
      incompleteMailboxMessages: number;
    };
    mailboxes: { mailboxId: string; unreadCount: number }[];
  };
}

type BrowserMessage =
  | HqSnapshotMessage
  | { type: 'hq.event'; event: unknown }
  | { type: 'hq.alert' };

/**
 * Create a queue-based browser message collector. Resolves the next message
 * matching `predicate` (or re-queues messages that don't match).
 */
function makeBrowserCollector(ws: WebSocket) {
  const queue: BrowserMessage[] = [];
  let resolver: ((msg: BrowserMessage) => void) | null = null;

  const collector = (raw: unknown) => {
    let parsed: BrowserMessage | null = null;
    try {
      parsed = JSON.parse(
        typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Buffer),
      ) as BrowserMessage;
    } catch {
      return;
    }
    if (resolver) {
      // Resolver (armResolver) decides whether to clear itself based on
      // whether the predicate matched. We don't clear here.
      resolver(parsed);
      return;
    }
    queue.push(parsed);
  };
  ws.on('message', collector);

  const nextMessage = (
    predicate: (m: BrowserMessage) => boolean,
    timeoutMs = 15_000,
  ): Promise<BrowserMessage> =>
    new Promise((resolve, reject) => {
      const existing = queue.findIndex(predicate);
      if (existing >= 0) {
        const [msg] = queue.splice(existing, 1);
        if (!msg) {
          reject(new Error('collector queue unexpectedly empty'));
          return;
        }
        resolve(msg);
        return;
      }
      const timer = setTimeout(() => {
        if (resolver === armResolver) resolver = null;
        reject(new Error('WS message timeout'));
      }, timeoutMs);
      const armResolver = (msg: BrowserMessage) => {
        if (!predicate(msg)) {
          queue.push(msg);
          return;
        }
        clearTimeout(timer);
        resolver = null;
        resolve(msg);
      };
      resolver = armResolver;
    });

  return {
    nextMessage,
    queueSnapshot: () => queue.slice(),
    dispose: () => ws.off('message', collector),
  };
}

describe('HQ server', () => {
  it('writes and clears the runtime endpoint marker for same-machine discovery', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });
    expect(handle.host).toBe('127.0.0.1');
    const runtimePath = path.join(dataDir, 'runtime.json');

    const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8')) as {
      url: string;
      pid: number;
    };
    expect(runtime).toMatchObject({ url: `http://127.0.0.1:${handle.port}`, pid: process.pid });

    await handle.close();
    await handle.close();
    handle = null;
    await expect(fs.access(runtimePath)).rejects.toThrow();
  });

  it('prints tokenized browser and client links on every token-mode startup', async () => {
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [
        { id: 'bt-existing', token: 'existing-browser-token', createdAt: new Date().toISOString() },
      ],
      clientTokens: [
        { id: 'ct-existing', token: 'existing-client-token', createdAt: new Date().toISOString() },
      ],
    });
    const port = getPort();

    handle = await startHqServer({ port, dataDir });
    // A caller that names no host gets loopback. The wide bind is opted into
    // by the HQ CLI entry points (HQ_CLI_DEFAULT_HOST), not by this default.
    expect(handle.host).toBe('127.0.0.1');

    expect(handle.firstRunSetup).toMatchObject({
      dataDir,
      clientUrl: `ws://127.0.0.1:${handle.port}/ws/client?token=existing-client-token`,
      clientEnv: {
        WRONGSTACK_HQ_URL: `http://127.0.0.1:${handle.port}`,
        WRONGSTACK_HQ_TOKEN: 'existing-client-token',
      },
      createdAuth: false,
    });

    // The browser link carries a single-use bootstrap code in the fragment
    // (exchanged for an HttpOnly cookie at /api/auth/bootstrap), never the
    // long-lived browser token.
    expect(handle.firstRunSetup?.browserUrl).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${handle.port}/#bootstrap=[A-Za-z0-9_-]{43}$`),
    );
    expect(handle.firstRunSetup?.browserUrl).not.toContain('existing-browser-token');
  });

  it('rejects with EADDRINUSE when strictPort is true and the port is busy', async () => {
    const port = getPort();
    const blocker = await occupyPort(port);
    try {
      await expect(startOpenHqServer({ port, strictPort: true })).rejects.toMatchObject({
        code: 'EADDRINUSE',
      });
    } finally {
      await closeHttpServer(blocker);
    }
  });

  it('auto-advances past multiple busy ports when strictPort is false', async () => {
    const port = getPort();
    const blockers = [await occupyPort(port), await occupyPort(port + 1)];
    try {
      handle = await startOpenHqServer({ port, strictPort: false });
      expect(handle.port).toBe(port + 2);
    } finally {
      await Promise.all(blockers.map((server) => closeHttpServer(server)));
    }
  });

  it('starts on a single port, serves HTML and /api/snapshot', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const res = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // `/` serves a dashboard page. When @wrongstack/webui is built it serves
    // the React SPA; otherwise it falls back to the inline HQ_HTML dashboard.
    // The release:check runs tests *before* the build step, so the webui dist
    // may or may not exist here — assert only the contract shared by both:
    // a 200 + a valid HTML document. The HQ_HTML fallback markup is covered
    // exhaustively in the dedicated constant test below.
    expect(html.toLowerCase()).toContain('<!doctype html>');
    expect(html.toLowerCase()).toContain('<html');

    const snapRes = await fetch(`http://127.0.0.1:${handle.port}/api/snapshot`);
    expect(snapRes.status).toBe(200);
    const snapshot = (await snapRes.json()) as {
      totals: {
        activeClients: number;
        unreadMailboxMessages: number;
        incompleteMailboxMessages: number;
      };
      mailboxes: unknown[];
      clients: unknown[];
    };
    expect(snapshot.totals.activeClients).toBe(0);
    expect(snapshot.mailboxes).toEqual([]);
    expect(snapshot.clients).toEqual([]);
  });

  it('accepts client connections on /ws/client and pushes snapshots to /ws/browser', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const browser = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/browser`);
    await waitForOpen(browser);
    const browserCol = makeBrowserCollector(browser);

    const snapshotPromise = browserCol.nextMessage(
      (m) =>
        m.type === 'hq.snapshot' && (m as HqSnapshotMessage).snapshot.totals.activeClients === 1,
    );

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);

    client.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'test-client-1',
            kind: 'tui',
            machineId: 'test-machine',
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'test-project',
            projectRoot: '/test',
            projectName: 'Test Project',
            machineId: 'test-machine',
            gitBranch: 'main',
            workspaceKind: 'git',
          },
          capabilities: ['telemetry.publish', 'mailbox.summary'],
        },
      }),
    );

    const snapshot = (await snapshotPromise) as HqSnapshotMessage;
    expect(snapshot.snapshot.totals.activeClients).toBe(1);
    // The HqProjectRecord rollup is also produced by buildSnapshot — confirm
    // it surfaces the project count too.
    const snapshotBody = snapshot.snapshot as {
      totals: {
        activeClients: number;
        unreadMailboxMessages: number;
        incompleteMailboxMessages: number;
        activeProjects: number;
      };
      projects: Array<{
        projectName: string;
        projectRootDisplay: string;
        machineIds: string[];
        gitBranch?: string;
      }>;
      mailboxes: Array<{ mailboxId: string; unreadCount: number }>;
      clients: unknown[];
    };
    expect(snapshotBody.totals.activeProjects).toBe(1);
    expect(snapshotBody.projects[0]).toMatchObject({
      projectName: 'Test Project',
      projectRootDisplay: '/test',
      machineIds: ['test-machine'],
      gitBranch: 'main',
    });

    browserCol.dispose();
    browser.close();
    client.close();
  });

  it('does not emit peer.rehydrate when the same leader clientId reconnects', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const browser = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/browser`);
    await waitForOpen(browser);
    const browserCol = makeBrowserCollector(browser);

    const first = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(first);
    const firstClosed = new Promise<number>((resolve) =>
      first.once('close', (code) => resolve(code)),
    );
    const helloPayload = {
      protocolVersion: HQ_PROTOCOL_VERSION,
      client: {
        clientId: 'leader-same-id',
        kind: 'tui',
        machineId: 'machine',
        startedAt: new Date().toISOString(),
      },
      project: {
        projectId: 'project',
        projectRoot: '/project',
        projectName: 'Project',
        machineId: 'machine',
        workspaceKind: 'git',
      },
      capabilities: ['telemetry.publish', 'control.receive'],
    };
    first.send(JSON.stringify({ type: 'client.hello', payload: helloPayload }));
    await browserCol.nextMessage(
      (m) =>
        m.type === 'hq.snapshot' && (m as HqSnapshotMessage).snapshot.totals.activeClients === 1,
    );

    const second = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(second);
    second.send(JSON.stringify({ type: 'client.hello', payload: helloPayload }));

    expect(await firstClosed).toBe(4001);
    await expect(
      browserCol.nextMessage(
        (m) =>
          m.type === 'hq.event' &&
          typeof (m as { event?: { type?: unknown } }).event === 'object' &&
          (m as { event: { type?: unknown } }).event.type === 'peer.rehydrate',
        250,
      ),
    ).rejects.toThrow('WS message timeout');

    browserCol.dispose();
    browser.close();
    second.close();
  });

  it('supersedes duplicate publishers from the same process and surface', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const first = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(first);
    const firstClosed = new Promise<number>((resolve) =>
      first.once('close', (code) => resolve(code)),
    );
    first.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'first',
            kind: 'tui',
            machineId: 'machine',
            pid: 4242,
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'project',
            projectRoot: '/project',
            projectName: 'Project',
            machineId: 'machine',
            workspaceKind: 'git',
          },
          capabilities: ['telemetry.publish'],
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(second);
    second.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'second',
            kind: 'tui',
            machineId: 'machine',
            pid: 4242,
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'project',
            projectRoot: '/project',
            projectName: 'Project',
            machineId: 'machine',
            workspaceKind: 'git',
          },
          capabilities: ['telemetry.publish'],
        },
      }),
    );

    expect(await firstClosed).toBe(4001);
    await expect
      .poll(async () => {
        const snapshot = (await (
          await fetch(`http://127.0.0.1:${handle!.port}/api/snapshot`)
        ).json()) as { clients: { clientId: string }[] };
        return snapshot.clients.map((client) => client.clientId);
      })
      .toEqual(['second']);
    second.close();
  });

  it('survives an oversized inbound frame instead of crashing the process', async () => {
    // Regression: a frame larger than the server's 1 MiB `maxPayload` makes the
    // per-connection `ws` receiver throw (`RangeError: Max payload size
    // exceeded`, close 1009) and emit 'error' on that socket. Without a
    // per-connection `ws.on('error')` handler, that 'error' is unhandled and
    // crashes the whole host process. This test runs the server in-process, so
    // an unhandled socket 'error' would surface as an uncaught exception and
    // fail the test. We assert the server stays up by completing a fresh
    // round-trip afterwards.
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const offender = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(offender);
    // Swallow the expected close/error on the offending client itself.
    offender.on('error', () => {});
    // 2 MiB payload — comfortably over the 1 MiB server cap.
    offender.send(Buffer.alloc(2 * 1024 * 1024, 0x61));

    // Wait for the offending socket to be torn down by the server. Poll up to
    // 5 s so the test resolves the instant the close fires instead of always
    // paying the full fixed delay (which can exceed the per-test Vitest
    // timeout when the suite shares the machine with a large concurrent run).
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 5_000;
      const tick = () => {
        if (offender.readyState === WebSocket.CLOSED || Date.now() >= deadline) {
          resolve();
          return;
        }
        setTimeout(tick, 25);
      };
      offender.once('close', resolve);
      tick();
    });

    // Server must still be alive: a brand-new browser connection still gets a
    // snapshot. (If the process had crashed, this connect would hang/fail.)
    const browser = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/browser`);
    await waitForOpen(browser);
    const browserCol = makeBrowserCollector(browser);
    const snapshot = (await browserCol.nextMessage(
      (m) => m.type === 'hq.snapshot',
    )) as HqSnapshotMessage;
    expect(snapshot.type).toBe('hq.snapshot');

    browserCol.dispose();
    browser.close();
  });

  it('shows a same-process publisher registered through the project mailbox as an HQ project', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const browser = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/browser`);
    await waitForOpen(browser);
    const browserCol = makeBrowserCollector(browser);

    const publisher = createCliHqPublisher({
      clientKind: 'tui',
      projectRoot: path.join(dataDir, 'project-root'),
      projectName: 'HQ Integration Project',
      config: { url: `http://127.0.0.1:${handle.port}`, enabled: true },
    });
    expect(publisher).toBeDefined();
    publisher!.connect();

    const mailbox = createProjectMailbox({
      projectDir: dataDir,
      hqPublisher: publisher,
      isolatedConnection: true,
    });
    await mailbox.registerClient({
      clientId: 'tui@integration',
      sessionId: 'session-integration',
      name: 'TUI Integration',
      source: 'tui',
      pid: process.pid,
    });

    const snapshot = (await browserCol.nextMessage(
      (m) =>
        m.type === 'hq.snapshot' &&
        (m as HqSnapshotMessage).snapshot.totals.activeClients === 1 &&
        (m as HqSnapshotMessage).snapshot.mailboxes.length >= 1,
    )) as HqSnapshotMessage;
    const body = snapshot.snapshot as {
      totals: {
        activeClients: number;
        unreadMailboxMessages: number;
        incompleteMailboxMessages: number;
      };
      projects: Array<{ projectName: string; activeClients: number }>;
      clients: Array<{ kind: string }>;
      mailboxes: Array<{ mailboxId: string; unreadCount: number }>;
    };

    expect(body.projects[0]).toMatchObject({
      projectName: 'HQ Integration Project',
      activeClients: 1,
    });
    expect(body.clients[0]).toMatchObject({ kind: 'tui' });
    expect(body.mailboxes.length).toBeGreaterThanOrEqual(1);

    publisher!.close();
    browserCol.dispose();
    browser.close();
  });

  it('rejects wrong protocol version on /ws/client', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);

    const closePromise = new Promise<number>((resolve) => {
      client.on('close', (code) => resolve(code));
    });

    client.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: 999,
          client: {
            clientId: 'bad',
            kind: 'cli',
            machineId: 'm',
            startedAt: '2026-01-01T00:00:00Z',
          },
          project: {
            projectId: 'p',
            projectRoot: '/',
            projectName: 'p',
            machineId: 'm',
            workspaceKind: 'git',
          },
          capabilities: [],
        },
      }),
    );

    const code = await closePromise;
    expect(code).toBe(1008);
  });

  it('aggregates mailbox.snapshot envelopes into global totals for browsers', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const browser = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/browser`);
    const browserCol = makeBrowserCollector(browser);
    await waitForOpen(browser);

    // Drain the initial snapshot.
    await browserCol.nextMessage((m) => m.type === 'hq.snapshot');

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);

    client.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'telemetry-client-1',
            kind: 'cli',
            machineId: 'machine-1',
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'proj-1',
            projectRoot: '/tmp/proj-1',
            projectName: 'proj-1',
            machineId: 'machine-1',
            workspaceKind: 'directory',
          },
          capabilities: ['telemetry.publish', 'mailbox.summary'],
        },
      }),
    );

    // Wait for the post-hello snapshot (activeClients === 1). A short delay
    // ensures the server has registered before the client sends the next
    // event, mirroring how the publisher batches snapshots in practice.
    await new Promise((r) => setTimeout(r, 20));
    await browserCol.nextMessage(
      (m) =>
        m.type === 'hq.snapshot' && (m as HqSnapshotMessage).snapshot.totals.activeClients === 1,
    );

    // Publish a mailbox.snapshot event so the HQ aggregates it.
    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-1',
          type: 'mailbox.snapshot',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'telemetry-client-1',
          projectId: 'proj-1',
          seq: 1,
          payload: {
            mailboxId: 'proj-1:mailbox',
            scope: 'project',
            messages: [],
            agents: [],
            totals: { messages: 5, unread: 3, incomplete: 2, highPriority: 1, onlineAgents: 1 },
          },
        },
      }),
    );

    // Now wait for the snapshot triggered by the mailbox.snapshot event.
    const aggregated = (await browserCol.nextMessage(
      (m) =>
        m.type === 'hq.snapshot' &&
        (m as HqSnapshotMessage).snapshot.totals.unreadMailboxMessages === 3,
    )) as HqSnapshotMessage;

    expect(aggregated.snapshot.totals.unreadMailboxMessages).toBe(3);
    expect(aggregated.snapshot.totals.incompleteMailboxMessages).toBe(2);
    expect(aggregated.snapshot.mailboxes[0]?.mailboxId).toBe('proj-1:mailbox');
    expect(aggregated.snapshot.mailboxes[0]?.unreadCount).toBe(3);

    browserCol.dispose();
    browser.close();
    client.close();
  });

  it('serves /api/projects/:id with project, clients, and mailbox snapshots', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    // Connect a client and publish a mailbox.snapshot envelope so the
    // server has actual mailbox payloads to surface in the drilldown.
    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);

    client.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'drill-client',
            kind: 'cli',
            machineId: 'm1',
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'proj-drill',
            projectRoot: '/r',
            projectName: 'proj-drill',
            machineId: 'm1',
            workspaceKind: 'git',
          },
          capabilities: ['telemetry.publish', 'mailbox.summary'],
        },
      }),
    );

    // Wait briefly so the server processes the hello before we send the
    // mailbox snapshot (handleClient rejects events until registered=true).
    await new Promise((r) => setTimeout(r, 20));

    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-1',
          type: 'mailbox.snapshot',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'drill-client',
          projectId: 'proj-drill',
          seq: 1,
          payload: {
            mailboxId: 'proj-drill:mailbox',
            scope: 'project',
            messages: [
              {
                mailId: 'm-1',
                messageId: 'm-1',
                from: 'agent-a',
                to: 'agent-b',
                type: 'ask',
                subject: 'Need review',
                priority: 'high',
                timestamp: new Date().toISOString(),
                completed: false,
                hasBody: false,
              },
            ],
            agents: [
              {
                agentId: 'agent-a',
                name: 'A',
                sessionId: 's-1',
                status: 'idle',
                iterations: 0,
                toolCalls: 0,
                lastActivityAt: new Date().toISOString(),
                lastSeenAt: new Date().toISOString(),
                online: true,
              },
            ],
            totals: { messages: 1, unread: 1, incomplete: 1, highPriority: 1, onlineAgents: 1 },
          },
        },
      }),
    );

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/projects/proj-drill`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      project: { projectId: string; activeClients: number };
      clients: { clientId: string; kind: string }[];
      mailboxes: {
        mailboxId: string;
        messages: { messageId: string }[];
        agents: { agentId: string }[];
      }[];
    };
    expect(detail.project.projectId).toBe('proj-drill');
    expect(detail.project.activeClients).toBe(1);
    expect(detail.clients).toHaveLength(1);
    expect(detail.clients[0]?.clientId).toBe('drill-client');
    expect(detail.clients[0]?.kind).toBe('cli');
    expect(detail.mailboxes).toHaveLength(1);
    expect(detail.mailboxes[0]?.mailboxId).toBe('proj-drill:mailbox');
    expect(detail.mailboxes[0]?.messages[0]?.messageId).toBe('m-1');
    expect(detail.mailboxes[0]?.agents[0]?.agentId).toBe('agent-a');

    client.close();
  });

  it('returns 404 for unknown projects on /api/projects/:id', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/projects/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('HQ_HTML is a diagnostic-only missing-assets recovery shell', () => {
    const html = HQ_HTML;
    expect(html.toLowerCase()).toContain('<!doctype html>');
    expect(html).toContain('WrongStack HQ');
    expect(html).toContain('data-hq-recovery-shell');
    expect(html).toContain('@wrongstack/webui-hq');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('/api/fleet');
    expect(html).not.toContain('/ws/browser');
  });

  it('surfaces fresh mailbox.snapshot data through /api/projects/:id (powers drawer auto-refresh)', async () => {
    // The dashboard's auto-refresh is implemented in the browser JS:
    //   applySnapshot() → scheduleAutoRefresh() → fetchProjectDetail() → fetch(/api/projects/:id)
    // We can't drive a real browser from a unit test, so this test exercises
    // the server-side contract that auto-refresh depends on: each new
    // mailbox.snapshot envelope must show up in the next /api/projects/:id
    // response.
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);
    client.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'auto-client',
            kind: 'tui',
            machineId: 'm1',
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'proj-auto',
            projectRoot: '/r',
            projectName: 'proj-auto',
            machineId: 'm1',
            workspaceKind: 'git',
          },
          capabilities: ['telemetry.publish', 'mailbox.summary'],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    // First snapshot: 1 unread.
    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-init',
          type: 'mailbox.snapshot',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'auto-client',
          projectId: 'proj-auto',
          seq: 1,
          payload: {
            mailboxId: 'proj-auto:mailbox',
            scope: 'project',
            messages: [],
            agents: [],
            totals: { messages: 1, unread: 1, incomplete: 1, highPriority: 0, onlineAgents: 0 },
          },
        },
      }),
    );

    const first = (await (
      await fetch(`http://127.0.0.1:${handle.port}/api/projects/proj-auto`)
    ).json()) as {
      mailboxes: { totals: { unread: number; messages: number } }[];
    };
    expect(first.mailboxes).toHaveLength(1);
    expect(first.mailboxes[0]?.totals.unread).toBe(1);
    expect(first.mailboxes[0]?.totals.messages).toBe(1);

    // Second snapshot: 5 unread, 5 messages. The dashboard's auto-refresh
    // would re-call this endpoint on the next applySnapshot tick and the
    // browser should see the new numbers without any server restart.
    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-2',
          type: 'mailbox.snapshot',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'auto-client',
          projectId: 'proj-auto',
          seq: 2,
          payload: {
            mailboxId: 'proj-auto:mailbox',
            scope: 'project',
            messages: [],
            agents: [],
            totals: { messages: 5, unread: 5, incomplete: 5, highPriority: 0, onlineAgents: 0 },
          },
        },
      }),
    );

    const second = (await (
      await fetch(`http://127.0.0.1:${handle.port}/api/projects/proj-auto`)
    ).json()) as {
      mailboxes: { totals: { unread: number; messages: number } }[];
    };
    expect(second.mailboxes[0]?.totals.unread).toBe(5);
    expect(second.mailboxes[0]?.totals.messages).toBe(5);

    client.close();
  });

  it('forwards mailbox.event envelopes to browsers as hq.event messages (powers live drawer feed)', async () => {
    // The dashboard's "Live mailbox events" feed is fed by the browser's
    // WS handler: on every hq.event whose event.type === 'mailbox.event'
    // and projectId === currentDetailProjectId, a row is prepended. This
    // test verifies the server-side contract: client-side mailbox.event
    // envelopes must be broadcast to /ws/browser sockets as hq.event.
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const browser = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/browser`);
    const browserCol = makeBrowserCollector(browser);
    await waitForOpen(browser);

    // Drain the initial post-hello snapshot that the browser receives
    // once the client connects below. We pre-wire the event listener.
    const eventPromise = browserCol.nextMessage(
      (m) =>
        m.type === 'hq.event' && (m as { event: { type: string } }).event.type === 'mailbox.event',
      5_000,
    );

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);
    client.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'feed-client',
            kind: 'webui',
            machineId: 'm1',
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'proj-feed',
            projectRoot: '/r',
            projectName: 'proj-feed',
            machineId: 'm1',
            workspaceKind: 'git',
          },
          capabilities: ['telemetry.publish', 'mailbox.summary'],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-feed-1',
          type: 'mailbox.event',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'feed-client',
          projectId: 'proj-feed',
          seq: 1,
          payload: {
            mailboxId: 'proj-feed:mailbox',
            action: 'message.sent',
            summary: 'New ask from agent-a to agent-b: Need review',
          },
        },
      }),
    );

    const evt = (await eventPromise) as {
      type: 'hq.event';
      event: { type: string; projectId: string; payload: { action: string; summary?: string } };
    };
    expect(evt.event.type).toBe('mailbox.event');
    expect(evt.event.projectId).toBe('proj-feed');
    expect(evt.event.payload.action).toBe('message.sent');
    expect(evt.event.payload.summary).toContain('Need review');

    browserCol.dispose();
    browser.close();
    client.close();
  });
});

describe('HQ server frame validation', () => {
  /**
   * Open a client socket, send `payload`, then resolve with the WS close
   * code the server returns. Resolves to `null` if the socket closes without
   * a numeric code (e.g. connection reset).
   */
  function sendAndAwaitClose(
    port: number,
    path: string,
    payload: string,
    timeoutMs = 2_000,
  ): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('WS close timeout'));
      }, timeoutMs);
      ws.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.once('open', () => {
        ws.send(payload);
      });
    });
  }

  it('closes the client socket with 1003 (invalid-json) on non-JSON payloads', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });
    const code = await sendAndAwaitClose(port, '/ws/client', '{not json');
    expect(code).toBe(1003);
  });

  it('closes the client socket with 1008 (policy violation) on unknown frame types', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });
    const code = await sendAndAwaitClose(
      port,
      '/ws/client',
      JSON.stringify({ type: 'hq.snapshot', snapshot: {} }),
    );
    expect(code).toBe(1008);
  });

  it('closes the client socket with 1008 (policy violation) on a malformed client.hello', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });
    // payload.client is missing the required `kind`, `machineId`, `startedAt`
    // fields, so parseHqFrame rejects it as `malformed`.
    const code = await sendAndAwaitClose(
      port,
      '/ws/client',
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: { clientId: 'cli_1' },
          project: {
            projectId: 'p_1',
            projectRoot: '/tmp/p',
            projectName: 'p',
            machineId: 'm',
            workspaceKind: 'directory',
          },
          capabilities: [],
        },
      }),
    );
    expect(code).toBe(1008);
  });

  it('rejects pre-hello frames (drops them without closing the connection)', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/client`);
    await waitForOpen(client);

    // Send a valid-looking client.event before sending client.hello. The
    // server must drop it (no broadcast, no error) because the client is
    // not registered yet.
    const beforeSnapshot = (await fetch(`http://127.0.0.1:${port}/api/snapshot`).then((r) =>
      r.json(),
    )) as { totals: { activeClients: number } };
    expect(beforeSnapshot.totals.activeClients).toBe(0);

    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-pre',
          type: 'mailbox.snapshot',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'cli_1',
          projectId: 'p_1',
          seq: 1,
          payload: { mailboxId: 'p_1:mailbox', messages: [], agents: [], totals: {} },
        },
      }),
    );
    // Give the server a tick to process the dropped frame.
    await new Promise((r) => setTimeout(r, 30));

    const afterPre = (await fetch(`http://127.0.0.1:${port}/api/snapshot`).then((r) =>
      r.json(),
    )) as { totals: { activeClients: number; unreadMailboxMessages: number } };
    expect(afterPre.totals.activeClients).toBe(0);
    expect(afterPre.totals.unreadMailboxMessages).toBe(0);

    // Now send a valid client.hello and confirm the client is accepted.
    client.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'cli_1',
            kind: 'cli',
            machineId: 'm_1',
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'p_1',
            projectRoot: '/tmp/p',
            projectName: 'p',
            machineId: 'm_1',
            workspaceKind: 'directory',
          },
          capabilities: ['telemetry.publish'],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    const afterHello = (await fetch(`http://127.0.0.1:${port}/api/snapshot`).then((r) =>
      r.json(),
    )) as { totals: { activeClients: number } };
    expect(afterHello.totals.activeClients).toBe(1);

    client.close();
  });

  it('drops malformed mailbox.event envelopes (does not broadcast them to browsers)', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const browser = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/browser`);
    const browserCol = makeBrowserCollector(browser);
    await waitForOpen(browser);
    // Drain the initial browser snapshot so we are guaranteed to be
    // observing only post-connect traffic.
    await browserCol.nextMessage(
      (m) =>
        m.type === 'hq.snapshot' &&
        (m as { snapshot: { totals: { activeClients: number } } }).snapshot.totals.activeClients ===
          0,
      5_000,
    );

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);
    client.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'malformed-feed-client',
            kind: 'cli',
            machineId: 'm1',
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'proj-malformed',
            projectRoot: '/r',
            projectName: 'proj-malformed',
            machineId: 'm1',
            workspaceKind: 'git',
          },
          capabilities: ['telemetry.publish'],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    // Publish a malformed mailbox.event (unknown action). Server must drop it
    // silently — the browser must NOT see an hq.event for it. The connection
    // itself stays open so legitimate future events still flow.
    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-malformed-1',
          type: 'mailbox.event',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'malformed-feed-client',
          projectId: 'proj-malformed',
          seq: 1,
          payload: {
            mailboxId: 'proj-malformed:mailbox',
            action: 'not.a.real.action',
          },
        },
      }),
    );

    // Browser should not receive any mailbox.event. Wait a beat and assert.
    let receivedMalformed = false;
    const checker = setTimeout(() => {}, 150);
    await new Promise((r) => setTimeout(r, 150));
    void checker;
    // Use the queue — anything that arrived in the meantime would be there.
    const queued = browserCol.queueSnapshot();
    receivedMalformed = queued.some(
      (m) =>
        m.type === 'hq.event' && (m as { event: { id: string } }).event.id === 'evt-malformed-1',
    );
    expect(receivedMalformed).toBe(false);

    // The connection is still open: a follow-up well-formed event must broadcast.
    const followupPromise = browserCol.nextMessage(
      (m) =>
        m.type === 'hq.event' &&
        (m as { event: { type: string } }).event.type === 'mailbox.event' &&
        (m as { event: { id: string } }).event.id === 'evt-ok-1',
      5_000,
    );
    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-ok-1',
          type: 'mailbox.event',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'malformed-feed-client',
          projectId: 'proj-malformed',
          seq: 2,
          payload: {
            mailboxId: 'proj-malformed:mailbox',
            action: 'message.sent',
            summary: 'a well-formed follow-up',
          },
        },
      }),
    );
    const followup = await followupPromise;
    expect(followup).toBeDefined();

    client.close();
  });

  it('scrubs and truncates long or secret-laden mailbox.event summaries before broadcasting', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const browser = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/browser`);
    const browserCol = makeBrowserCollector(browser);
    await waitForOpen(browser);
    await browserCol.nextMessage((m) => m.type === 'hq.snapshot', 5_000);

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);
    client.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'scrub-client',
            kind: 'cli',
            machineId: 'm1',
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'proj-scrub',
            projectRoot: '/r',
            projectName: 'proj-scrub',
            machineId: 'm1',
            workspaceKind: 'git',
          },
          capabilities: ['telemetry.publish'],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    const longSecret = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const filler = 'x'.repeat(400);
    const summaryText = `attached ${longSecret} ${filler}`;
    const evtPromise = browserCol.nextMessage(
      (m) => m.type === 'hq.event' && (m as { event: { id: string } }).event.id === 'evt-scrub-1',
      5_000,
    );
    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'evt-scrub-1',
          type: 'mailbox.event',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'scrub-client',
          projectId: 'proj-scrub',
          seq: 1,
          payload: {
            mailboxId: 'proj-scrub:mailbox',
            action: 'message.sent',
            summary: summaryText,
          },
        },
      }),
    );

    const evt = (await evtPromise) as {
      type: 'hq.event';
      event: { id: string; payload: { summary?: string } };
    };
    const summary = evt.event.payload.summary;
    expect(typeof summary).toBe('string');
    // Truncated: must not exceed 280 chars + "[truncated:N]" suffix length.
    expect(summary!.length).toBeLessThan(summaryText.length);
    // WS-007: the summary body is still carried under the rawContent default,
    // but the server's re-redaction strips the credential inside it — matching
    // docs/configuration.md:1229. This test previously asserted the token
    // survived the hop.
    expect(summary!.toLowerCase()).not.toContain(longSecret.toLowerCase());
    expect(summary!).toContain('REDACTED');

    client.close();
  });
});

describe('HQ server Kanban synchronization', () => {
  it('persists a project snapshot, exposes it through the API, and returns it on reconnect', async () => {
    handle = await startOpenHqServer({ port: getPort() });
    const connect = async (clientId: string): Promise<WebSocket> => {
      const ws = new WebSocket(`ws://127.0.0.1:${handle!.port}/ws/client`);
      await waitForOpen(ws);
      ws.send(
        JSON.stringify({
          type: 'client.hello',
          payload: {
            protocolVersion: HQ_PROTOCOL_VERSION,
            client: {
              clientId,
              kind: 'cli',
              machineId: 'machine-1',
              startedAt: new Date().toISOString(),
            },
            project: {
              projectId: 'project-kanban',
              projectRoot: '/repo',
              projectName: 'repo',
              machineId: 'machine-1',
              workspaceKind: 'git',
            },
            capabilities: ['telemetry.publish'],
            redactionPolicy: { rawContent: true, toolArgs: 'summary', paths: 'project-relative' },
          },
        }),
      );
      return ws;
    };

    const first = await connect('kanban-client-1');
    first.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'kanban-event-1',
          type: 'kanban.snapshot',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: '2026-07-22T12:00:00Z',
          clientId: 'kanban-client-1',
          projectId: 'project-kanban',
          seq: 1,
          payload: {
            projectId: 'project-kanban',
            generatedAt: '2026-07-22T12:00:00Z',
            boards: [
              {
                boardId: 'board-1',
                revision: 1,
                updatedAt: '2026-07-22T12:00:00Z',
                board: { id: 'board-1', title: 'Central board' },
              },
            ],
            tombstones: [],
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));

    const response = await fetch(
      `http://127.0.0.1:${handle.port}/api/projects/project-kanban/kanban`,
    );
    expect(response.status).toBe(200);
    const kanbanPayload = (await response.json()) as {
      boards: Array<{ board: { title: string } }>;
    };
    expect(kanbanPayload.boards[0]?.board.title).toBe('Central board');

    first.close();
    const second = await connect('kanban-client-2');
    const snapshot = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Kanban snapshot timeout')), 2_000);
      second.on('message', (data) => {
        const message = JSON.parse(String(data)) as Record<string, unknown>;
        if (message.type === 'hq.kanban_snapshot') {
          clearTimeout(timer);
          resolve(message);
        }
      });
    });
    expect(snapshot.type).toBe('hq.kanban_snapshot');
    second.close();
  });

  it('broadcasts only the boards a delta touched, never the full merged set', async () => {
    handle = await startOpenHqServer({ port: getPort() });
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(ws);
    const snapshots: Array<{ boards: Array<{ boardId: string }> }> = [];
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        payload?: { boards: Array<{ boardId: string }> };
      };
      if (message.type === 'hq.kanban_snapshot' && message.payload) {
        snapshots.push(message.payload);
      }
    });
    ws.send(
      JSON.stringify({
        type: 'client.hello',
        payload: {
          protocolVersion: HQ_PROTOCOL_VERSION,
          client: {
            clientId: 'kanban-delta-client',
            kind: 'cli',
            machineId: 'machine-1',
            startedAt: new Date().toISOString(),
          },
          project: {
            projectId: 'project-kanban-delta',
            projectRoot: '/repo',
            projectName: 'repo',
            machineId: 'machine-1',
            workspaceKind: 'git',
          },
          capabilities: ['telemetry.publish'],
          redactionPolicy: { rawContent: true, toolArgs: 'summary', paths: 'project-relative' },
        },
      }),
    );
    const kanbanEvent = (seq: number, boardId: string): string =>
      JSON.stringify({
        type: 'client.event',
        event: {
          id: `kanban-delta-event-${seq}`,
          type: 'kanban.snapshot',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: '2026-07-22T12:00:00Z',
          clientId: 'kanban-delta-client',
          projectId: 'project-kanban-delta',
          seq,
          payload: {
            projectId: 'project-kanban-delta',
            generatedAt: '2026-07-22T12:00:00Z',
            boards: [
              {
                boardId,
                revision: 1,
                updatedAt: '2026-07-22T12:00:00Z',
                board: { id: boardId, title: `Board ${boardId}` },
              },
            ],
            tombstones: [],
          },
        },
      });
    await new Promise((resolve) => setTimeout(resolve, 40));
    ws.send(kanbanEvent(1, 'board-a'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    ws.send(kanbanEvent(2, 'board-b'));
    const deadline = Date.now() + 2_000;
    while (
      !snapshots.some((s) => s.boards.some((b) => b.boardId === 'board-b')) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // The broadcast for the board-b delta must NOT drag board-a along: with
    // thousands of accumulated boards the old full-set re-broadcast was a
    // multi-MB message per delta per client.
    const deltaBroadcast = snapshots.find((s) => s.boards.some((b) => b.boardId === 'board-b'));
    expect(deltaBroadcast).toBeDefined();
    expect(deltaBroadcast!.boards.map((b) => b.boardId)).toEqual(['board-b']);

    // The full merged set stays available through the REST snapshot API.
    const response = await fetch(
      `http://127.0.0.1:${handle.port}/api/projects/project-kanban-delta/kanban`,
    );
    const kanbanPayload = (await response.json()) as { boards: Array<{ boardId: string }> };
    expect(kanbanPayload.boards.map((b) => b.boardId).sort()).toEqual(['board-a', 'board-b']);
    ws.close();
  });
});

describe('HQ server fleet telemetry', () => {
  function helloFrame(
    clientId: string,
    machineId: string,
    projectId: string,
    kind = 'tui',
  ): string {
    return JSON.stringify({
      type: 'client.hello',
      payload: {
        protocolVersion: HQ_PROTOCOL_VERSION,
        client: {
          clientId,
          kind,
          machineId,
          hostname: machineId + '.local',
          pid: 4242,
          startedAt: new Date().toISOString(),
        },
        project: {
          projectId,
          projectRoot: '/r/' + projectId,
          projectName: projectId,
          machineId,
          workspaceKind: 'git',
        },
        capabilities: ['telemetry.publish'],
        redactionPolicy: { rawContent: true, toolArgs: 'summary', paths: 'project-relative' },
      },
    });
  }

  function sessionSnapshotFrame(
    clientId: string,
    machineId: string,
    projectId: string,
    sessionId: string,
    seq = 1,
  ): string {
    return JSON.stringify({
      type: 'client.event',
      event: {
        id: 'snap-' + sessionId + '-' + seq,
        type: 'session.snapshot',
        schemaVersion: HQ_PROTOCOL_VERSION,
        timestamp: new Date().toISOString(),
        clientId,
        projectId,
        sessionId,
        seq,
        payload: {
          sessionId,
          clientKind: 'tui',
          machineId,
          hostname: machineId + '.local',
          pid: 4242,
          projectId,
          projectName: projectId,
          projectRoot: '/r/' + projectId,
          gitBranch: 'main',
          status: 'active',
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          agentCount: 2,
          agents: [
            {
              id: 'leader',
              name: 'leader',
              status: 'running',
              iterations: 3,
              toolCalls: 5,
              costUsd: 0.12,
              model: 'opus',
              lastActivityAt: new Date().toISOString(),
            },
            {
              id: 'sub-1',
              name: 'bug-hunter',
              status: 'streaming',
              iterations: 1,
              toolCalls: 2,
              currentTool: 'grep',
              lastActivityAt: new Date().toISOString(),
            },
          ],
        },
      },
    });
  }

  it('never supersedes a live telemetry owner from a same-process sibling socket', async () => {
    // One process holds several publisher sockets (session telemetry +
    // mailbox). A sibling hello with the same pid/kind but a different
    // clientId must NOT kill the socket that owns live session snapshots —
    // that ping-pong showed up as terminals/agents flapping in the HQ map.
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const owner = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(owner);
    let ownerClosed = false;
    owner.once('close', () => {
      ownerClosed = true;
    });
    owner.send(helloFrame('owner', 'mach-A', 'projX'));
    await new Promise((r) => setTimeout(r, 20));
    owner.send(sessionSnapshotFrame('owner', 'mach-A', 'projX', 's-live'));
    await new Promise((r) => setTimeout(r, 30));

    const sibling = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(sibling);
    sibling.send(helloFrame('sibling', 'mach-A', 'projX'));
    await new Promise((r) => setTimeout(r, 50));

    expect(ownerClosed).toBe(false);
    const snapshot = (await (
      await fetch(`http://127.0.0.1:${handle.port}/api/snapshot`)
    ).json()) as {
      clients: { clientId: string }[];
      liveSessions: { sessionId: string }[];
      totals: { activeClients: number };
    };
    expect(snapshot.clients.map((c) => c.clientId).sort()).toEqual(['owner', 'sibling']);
    expect(snapshot.liveSessions.map((s) => s.sessionId)).toEqual(['s-live']);
    // Same machine + pid → the two sockets count as ONE client process.
    expect(snapshot.totals.activeClients).toBe(1);

    owner.close();
    sibling.close();
  });

  it('aggregates session.snapshot into the machine → project → terminal → agent tree via /api/fleet', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);
    client.send(helloFrame('c1', 'mach-A', 'projX'));
    await new Promise((r) => setTimeout(r, 20));
    client.send(sessionSnapshotFrame('c1', 'mach-A', 'projX', 's-1'));
    await new Promise((r) => setTimeout(r, 30));

    const fleet = (await (await fetch(`http://127.0.0.1:${handle.port}/api/fleet`)).json()) as {
      machines: {
        machineId: string;
        hostname?: string;
        sessionCount: number;
        agentCount: number;
      }[];
      liveSessions: { sessionId: string; clientId?: string; agents: { id: string }[] }[];
      totals: {
        activeMachines: number;
        activeSessions: number;
        activeAgents: number;
        activeSubagents: number;
        totalCostUsd: number;
      };
    };

    expect(fleet.totals.activeMachines).toBe(1);
    expect(fleet.totals.activeSessions).toBe(1);
    expect(fleet.totals.activeAgents).toBe(2);
    expect(fleet.totals.activeSubagents).toBe(1);
    expect(fleet.totals.totalCostUsd).toBeCloseTo(0.12, 5);
    const m = fleet.machines.find((x) => x.machineId === 'mach-A');
    expect(m).toBeDefined();
    expect(m!.hostname).toBe('mach-A.local');
    expect(m!.sessionCount).toBe(1);
    expect(m!.agentCount).toBe(2);
    expect(fleet.liveSessions).toHaveLength(1);
    expect(fleet.liveSessions[0]?.clientId).toBe('c1');
    expect(fleet.liveSessions[0]?.agents).toHaveLength(2);

    client.close();
  });

  it('expires session snapshots that stop refreshing while the socket stays alive on heartbeats', async () => {
    const port = getPort();
    handle = await startOpenHqServer({
      port,
      clientCleanupIntervalMs: 50,
      sessionSnapshotTtlMs: 200,
    });

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);
    client.send(helloFrame('c1', 'mach-A', 'projX'));
    await new Promise((r) => setTimeout(r, 20));

    // s-dead is published once and never refreshed — a bridge that died
    // without session.ended. s-live keeps republishing like a healthy bridge.
    client.send(sessionSnapshotFrame('c1', 'mach-A', 'projX', 's-dead', 1));
    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'dead-fleet',
          type: 'fleet.snapshot',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'c1',
          projectId: 'projX',
          sessionId: 's-dead',
          runId: 'run-dead',
          seq: 2,
          payload: {
            runId: 'run-dead',
            activeSubagents: 1,
            queuedTasks: 0,
            completedTasks: 0,
            failedTasks: 0,
            subagents: [{ subagentId: 'shadow-dead', status: 'running' }],
          },
        },
      }),
    );
    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'dead-mcp',
          type: 'mcp.health.snapshot',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'c1',
          projectId: 'projX',
          sessionId: 's-dead',
          seq: 3,
          payload: { servers: [] },
        },
      }),
    );
    let seq = 3;
    const refresher = setInterval(() => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(sessionSnapshotFrame('c1', 'mach-A', 'projX', 's-live', ++seq));
      }
    }, 40);

    const liveSessionIds = async (): Promise<string[]> => {
      const fleet = (await (await fetch(`http://127.0.0.1:${handle!.port}/api/fleet`)).json()) as {
        liveSessions: { sessionId: string }[];
      };
      return fleet.liveSessions.map((s) => s.sessionId).sort();
    };

    try {
      await expect.poll(liveSessionIds, { timeout: 5_000 }).toEqual(['s-dead', 's-live']);
      // The stale snapshot falls out; the refreshed one and the client survive.
      await expect.poll(liveSessionIds, { timeout: 5_000 }).toEqual(['s-live']);
      const snap = (await (await fetch(`http://127.0.0.1:${handle.port}/api/snapshot`)).json()) as {
        clients: { clientId: string; connected: boolean }[];
        fleets: { runId: string }[];
        mcpServers: { projectId: string }[];
      };
      expect(snap.clients.some((c) => c.clientId === 'c1' && c.connected)).toBe(true);
      expect(snap.fleets.some((fleet) => fleet.runId === 'run-dead')).toBe(false);
      expect(snap.mcpServers).toEqual([]);
    } finally {
      clearInterval(refresher);
      client.close();
    }
  });

  it('serves a remote terminal full transcript from the stream ring via /api/sessions/:id/events', async () => {
    const prevEnv = process.env['WRONGSTACK_HQ_DATA_DIR'];
    process.env['WRONGSTACK_HQ_DATA_DIR'] = dataDir; // keep registry lookup hermetic (empty tmp)
    try {
      const port = getPort();
      handle = await startOpenHqServer({ port });

      const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
      await waitForOpen(client);
      client.send(helloFrame('c1', 'mach-A', 'projX'));
      await new Promise((r) => setTimeout(r, 20));
      client.send(sessionSnapshotFrame('c1', 'mach-A', 'projX', 's-remote'));
      client.send(
        JSON.stringify({
          type: 'client.event',
          event: {
            id: 'tr-1',
            type: 'session.transcript',
            schemaVersion: HQ_PROTOCOL_VERSION,
            timestamp: new Date().toISOString(),
            clientId: 'c1',
            projectId: 'projX',
            sessionId: 's-remote',
            seq: 2,
            payload: {
              sessionId: 's-remote',
              fromSeq: 0,
              entries: [
                { ts: new Date().toISOString(), role: 'user', text: 'hello there' },
                { ts: new Date().toISOString(), role: 'assistant', text: 'hi! working on it' },
                { ts: new Date().toISOString(), role: 'tool', text: 'ls -la', tool: 'bash' },
              ],
            },
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 30));

      const res = await fetch(
        `http://127.0.0.1:${handle.port}/api/sessions/s-remote/events?full=1`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        source: string;
        total: number;
        entries: { role: string; text: string; tool?: string }[];
      };
      expect(body.source).toBe('stream');
      expect(body.total).toBe(3);
      expect(body.entries[0]).toMatchObject({ role: 'user', text: 'hello there' });
      expect(body.entries[2]).toMatchObject({ role: 'tool', tool: 'bash' });

      client.close();
    } finally {
      if (prevEnv === undefined) delete process.env['WRONGSTACK_HQ_DATA_DIR'];
      else process.env['WRONGSTACK_HQ_DATA_DIR'] = prevEnv;
    }
  });

  it('buffers agent.message per subagentId and serves it via /api/agents/:id/messages', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);
    client.send(helloFrame('c1', 'mach-A', 'projX'));
    await new Promise((r) => setTimeout(r, 20));

    function agentMsg(seq: number, content: string, kind: string): string {
      return JSON.stringify({
        type: 'client.event',
        event: {
          id: 'am-' + seq,
          type: 'agent.message',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'c1',
          projectId: 'projX',
          seq,
          payload: {
            subagentId: 'sub-9',
            agentName: 'bug-hunter',
            content,
            kind,
            iteration: seq,
            ts: new Date().toISOString(),
          },
        },
      });
    }
    client.send(agentMsg(1, 'starting investigation', 'text'));
    client.send(agentMsg(2, 'grep', 'tool_use'));
    client.send(agentMsg(3, 'found the bug', 'text'));
    await new Promise((r) => setTimeout(r, 30));

    const res = await fetch(`http://127.0.0.1:${handle.port}/api/agents/sub-9/messages?full=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subagentId: string;
      total: number;
      entries: { role: string; text: string }[];
    };
    expect(body.subagentId).toBe('sub-9');
    expect(body.total).toBe(3);
    expect(body.entries[0]).toMatchObject({ role: 'assistant', text: 'starting investigation' });
    expect(body.entries[1]!.role).toBe('tool');
    expect(body.entries[2]).toMatchObject({ role: 'assistant', text: 'found the bug' });

    client.close();
  });

  it('keeps same-named agents in different sessions separate (session-scoped rings)', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);
    client.send(helloFrame('c1', 'mach-A', 'projX'));
    await new Promise((r) => setTimeout(r, 20));

    // Two sessions, each with a leader whose id is the default 'leader'.
    function leaderMsg(sessionId: string, seq: number, content: string): string {
      return JSON.stringify({
        type: 'client.event',
        event: {
          id: `lm-${sessionId}-${seq}`,
          type: 'agent.message',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'c1',
          projectId: 'projX',
          seq,
          sessionId,
          payload: {
            subagentId: 'leader',
            agentName: 'leader',
            content,
            kind: 'text',
            iteration: seq,
            ts: new Date().toISOString(),
          },
        },
      });
    }
    client.send(leaderMsg('sess-A', 1, 'A: hello from session A'));
    client.send(leaderMsg('sess-B', 2, 'B: hello from session B'));
    client.send(leaderMsg('sess-A', 3, 'A: second line'));
    await new Promise((r) => setTimeout(r, 30));

    const resA = await fetch(
      `http://127.0.0.1:${handle.port}/api/sessions/sess-A/agents/leader/messages?full=1`,
    );
    const bodyA = (await resA.json()) as { total: number; entries: { text: string }[] };
    expect(bodyA.total).toBe(2);
    expect(bodyA.entries.map((e) => e.text)).toEqual(['A: hello from session A', 'A: second line']);

    const resB = await fetch(
      `http://127.0.0.1:${handle.port}/api/sessions/sess-B/agents/leader/messages?full=1`,
    );
    const bodyB = (await resB.json()) as { total: number; entries: { text: string }[] };
    expect(bodyB.total).toBe(1);
    expect(bodyB.entries[0]!.text).toBe('B: hello from session B');

    client.close();
  });

  it('aggregates fleet.snapshot into the fleets[] rollup and derives sessions[] from liveSessions', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);
    client.send(helloFrame('c1', 'mach-A', 'projX'));
    await new Promise((r) => setTimeout(r, 20));
    // Send a session snapshot so sessions[] can be derived, and a fleet snapshot
    // so fleets[] is populated — both Phase 1 telemetry feeds.
    client.send(sessionSnapshotFrame('c1', 'mach-A', 'projX', 's-fleet'));
    client.send(
      JSON.stringify({
        type: 'client.event',
        event: {
          id: 'fs-1',
          type: 'fleet.snapshot',
          schemaVersion: HQ_PROTOCOL_VERSION,
          timestamp: new Date().toISOString(),
          clientId: 'c1',
          projectId: 'projX',
          runId: 's-fleet',
          seq: 3,
          payload: {
            runId: 's-fleet',
            activeSubagents: 2,
            queuedTasks: 1,
            completedTasks: 4,
            failedTasks: 0,
            maxSpawns: 256,
            usedSpawns: 103,
            remainingSpawns: 153,
            ceilingMismatch: true,
            checkpointMaxSpawns: 96,
            subagents: [
              { subagentId: 'sub-1', status: 'running' },
              { subagentId: 'sub-2', status: 'idle' },
            ],
          },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 40));

    const fleet = (await (await fetch(`http://127.0.0.1:${handle.port}/api/fleet`)).json()) as {
      sessions: { sessionId: string; projectId: string; status: string }[];
      fleets: {
        runId: string;
        projectId: string;
        activeSubagents: number;
        queuedTasks: number;
        completedTasks: number;
        maxSpawns?: number;
        usedSpawns?: number;
        remainingSpawns?: number;
        ceilingMismatch?: boolean;
        checkpointMaxSpawns?: number;
      }[];
    };

    // fleets[] rollup reflects the coordinator snapshot
    expect(fleet.fleets).toHaveLength(1);
    const f = fleet.fleets[0]!;
    expect(f.runId).toBe('s-fleet');
    expect(f.projectId).toBe('projX');
    expect(f.activeSubagents).toBe(2);
    expect(f.queuedTasks).toBe(1);
    expect(f.completedTasks).toBe(4);
    expect(f.maxSpawns).toBe(256);
    expect(f.usedSpawns).toBe(103);
    expect(f.remainingSpawns).toBe(153);
    expect(f.ceilingMismatch).toBe(true);
    expect(f.checkpointMaxSpawns).toBe(96);

    // sessions[] is now derived from liveSessions (was empty before Phase 1)
    expect(fleet.sessions).toHaveLength(1);
    expect(fleet.sessions[0]!.sessionId).toBe('s-fleet');
    expect(fleet.sessions[0]!.projectId).toBe('projX');

    client.close();
  });
});

describe('HQ control plane (Phase 3)', () => {
  function helloFrameControl(clientId: string, machineId: string, projectId: string): string {
    return JSON.stringify({
      type: 'client.hello',
      payload: {
        protocolVersion: HQ_PROTOCOL_VERSION,
        client: {
          clientId,
          kind: 'tui',
          machineId,
          hostname: machineId + '.local',
          pid: 1,
          startedAt: new Date().toISOString(),
        },
        project: {
          projectId,
          projectRoot: '/r/' + projectId,
          projectName: projectId,
          machineId,
          workspaceKind: 'git',
        },
        capabilities: ['telemetry.publish', 'control.receive'],
      },
    });
  }

  /** A client that does NOT advertise control.receive (for the 409 test). */
  function helloFrameNoControl(clientId: string, machineId: string, projectId: string): string {
    return JSON.stringify({
      type: 'client.hello',
      payload: {
        protocolVersion: HQ_PROTOCOL_VERSION,
        client: {
          clientId,
          kind: 'tui',
          machineId,
          hostname: machineId + '.local',
          pid: 1,
          startedAt: new Date().toISOString(),
        },
        project: {
          projectId,
          projectRoot: '/r/' + projectId,
          projectName: projectId,
          machineId,
          workspaceKind: 'git',
        },
        capabilities: ['telemetry.publish'],
      },
    });
  }

  function nextMessage(
    ws: WebSocket,
    predicate: (m: { type: string }) => boolean,
    timeout = 3000,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeout);
      const handler = (raw: { toString: () => string }): void => {
        try {
          const msg = JSON.parse(raw.toString());
          if (predicate(msg)) {
            clearTimeout(timer);
            ws.off('message', handler);
            resolve(msg);
          }
        } catch {
          /* ignore */
        }
      };
      ws.on('message', handler);
    });
  }

  it('enqueues a command via POST /api/command, delivers it on poll, and records the ack', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);
    client.send(helloFrameControl('ctrl-1', 'mach-C', 'projC'));
    await new Promise((r) => setTimeout(r, 30));

    const browser = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/browser`);
    await waitForOpen(browser);
    const queuedStatusPromise = nextMessage(
      browser,
      (message) =>
        message.type === 'hq.command_status' &&
        (message as { command?: { status?: string } }).command?.status === 'queued',
    );

    // Enqueue a steer command from the browser (open mode — no token required).
    const postRes = await fetch(`http://127.0.0.1:${handle.port}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'ctrl-1',
        type: 'steer',
        payload: { to: 'leader', subject: 'pivot', body: 'switch to plan B' },
      }),
    });
    expect(postRes.status).toBe(202);
    const postBody = (await postRes.json()) as { commandId: string; queued: boolean };
    expect(postBody.queued).toBe(true);
    expect(postBody.commandId).toBeTruthy();
    const queuedStatus = (await queuedStatusPromise) as {
      type: 'hq.command_status';
      command: { commandId: string; status: string };
    };
    expect(queuedStatus.command).toMatchObject({
      commandId: postBody.commandId,
      status: 'queued',
    });

    // Client polls — server should respond with a command_batch.
    const deliveredStatusPromise = nextMessage(
      browser,
      (message) =>
        message.type === 'hq.command_status' &&
        (message as { command?: { status?: string } }).command?.status === 'delivered',
    );
    client.send(
      JSON.stringify({ type: 'client.command_poll', clientId: 'ctrl-1', projectId: 'projC' }),
    );
    const batch = (await nextMessage(client, (m) => m.type === 'hq.command_batch')) as {
      type: 'hq.command_batch';
      commands: { commandId: string; type: string; payload: { to: string; subject: string } }[];
    };
    expect(batch.commands).toHaveLength(1);
    expect(batch.commands[0]!.type).toBe('steer');
    expect(batch.commands[0]!.payload.to).toBe('leader');
    expect(batch.commands[0]!.payload.subject).toBe('pivot');
    await expect(deliveredStatusPromise).resolves.toMatchObject({
      type: 'hq.command_status',
      command: { commandId: postBody.commandId, status: 'delivered' },
    });

    // Client acks.
    const ackedStatusPromise = nextMessage(
      browser,
      (message) =>
        message.type === 'hq.command_status' &&
        (message as { command?: { status?: string } }).command?.status === 'acked',
    );
    client.send(
      JSON.stringify({
        type: 'client.command_ack',
        clientId: 'ctrl-1',
        projectId: 'projC',
        commandId: batch.commands[0]!.commandId,
        status: 'completed',
        message: 'steered',
      }),
    );
    await expect(ackedStatusPromise).resolves.toMatchObject({
      type: 'hq.command_status',
      command: {
        commandId: postBody.commandId,
        status: 'acked',
        ackStatus: 'completed',
        ackMessage: 'steered',
      },
    });

    // The audit log reflects the ack.
    const auditRes = await fetch(`http://127.0.0.1:${handle.port}/api/commands`);
    const auditBody = (await auditRes.json()) as {
      commands: { commandId: string; status: string; ackStatus?: string; ackMessage?: string }[];
    };
    const entry = auditBody.commands.find((c) => c.commandId === batch.commands[0]!.commandId);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('acked');
    expect(entry!.ackStatus).toBe('completed');
    expect(entry!.ackMessage).toBe('steered');

    client.close();
    browser.close();
  });

  it('fails an undelivered command when the target disconnects before polling', async () => {
    // The command queue lives on the per-socket ConnectedClient, so it dies
    // with the socket and nothing re-queues it on the replacement connection.
    // Its audit row used to stay `queued` forever — the Control rail showing a
    // pending command that will never run.
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);
    client.send(helloFrameControl('ctrl-lost', 'mach-L', 'projL'));
    await new Promise((r) => setTimeout(r, 30));

    const browser = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/browser`);
    await waitForOpen(browser);
    const failedStatusPromise = nextMessage(
      browser,
      (message) =>
        message.type === 'hq.command_status' &&
        (message as { command?: { ackStatus?: string } }).command?.ackStatus === 'failed',
    );

    const postRes = await fetch(`http://127.0.0.1:${handle.port}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'ctrl-lost',
        type: 'steer',
        payload: { to: 'leader', subject: 'lost', body: 'never arrives' },
      }),
    });
    expect(postRes.status).toBe(202);
    const { commandId } = (await postRes.json()) as { commandId: string };

    // The client never polls — it drops.
    client.close();

    await expect(failedStatusPromise).resolves.toMatchObject({
      type: 'hq.command_status',
      command: { commandId, status: 'acked', ackStatus: 'failed' },
    });

    const auditRes = await fetch(`http://127.0.0.1:${handle.port}/api/commands`);
    const auditBody = (await auditRes.json()) as {
      commands: { commandId: string; status: string; ackStatus?: string; ackMessage?: string }[];
    };
    const entry = auditBody.commands.find((c) => c.commandId === commandId);
    expect(entry).toMatchObject({ status: 'acked', ackStatus: 'failed' });
    expect(entry?.ackMessage).toContain('disconnected');

    browser.close();
  });

  it('rejects a command to a client without control.receive capability', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);
    // This client does NOT advertise control.receive.
    client.send(helloFrameNoControl('ctrl-2', 'mach-D', 'projD'));
    await new Promise((r) => setTimeout(r, 30));

    const postRes = await fetch(`http://127.0.0.1:${handle.port}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'ctrl-2', type: 'abort', payload: { target: 'leader' } }),
    });
    expect(postRes.status).toBe(409);
    const body = (await postRes.json()) as { error: string };
    expect(body.error).toContain('control');

    client.close();
  });

  it('routes valid control commands through the shared TrustBoundary', async () => {
    const evaluate = vi.fn(async () => ({ kind: 'deny' as const, reason: 'maintenance window' }));
    handle = await startOpenHqServer({ port: getPort(), trustBoundary: { evaluate } });
    const client = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/client`);
    await waitForOpen(client);
    client.send(helloFrameControl('ctrl-policy', 'mach-policy', 'proj-policy'));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const response = await fetch(`http://127.0.0.1:${handle.port}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'ctrl-policy',
        type: 'abort',
        payload: { target: 'leader' },
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain('maintenance window');
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'hq',
        capability: 'hq.control.enqueue',
        subject: expect.objectContaining({ kind: 'custom', id: 'abort' }),
        risk: 'high',
        scope: { projectId: 'proj-policy' },
      }),
    );
    client.close();
  });

  it('returns 404 for a command to an unknown client', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });
    const postRes = await fetch(`http://127.0.0.1:${handle.port}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: 'ghost',
        type: 'steer',
        payload: { to: 'leader', subject: 'x', body: 'y' },
      }),
    });
    expect(postRes.status).toBe(404);
  });
});

describe('HQ direct mailbox write (POST /api/mailbox-send)', () => {
  // Test-only browser token. Kept in a const so the auth header is assembled
  // by concatenation (never a literal "Bearer <token>" string, which the
  // repo secret-scanner flags).
  const BROWSER_TOKEN = 'browser-mb-token';
  const bearer = (): string => 'Bearer ' + BROWSER_TOKEN;

  // The server derives its global root from path.dirname(dataDir); the
  // SessionRegistry and per-project mailbox both live under that root.
  function globalRootForData(dir: string): string {
    return path.dirname(dir);
  }

  /**
   * Seed a live session in the registry so the route can resolve a projectRoot
   * from a sessionId. Registers a fresh entry (live pid + heartbeat) and
   * returns a cleanup that stops the heartbeat timer and removes the entry.
   */
  async function seedSession(
    globalRoot: string,
    sessionId: string,
    projectSlug: string,
    projectRoot: string,
  ): Promise<() => Promise<void>> {
    const { SessionRegistry } = await import('@wrongstack/core/storage');
    const registry = new SessionRegistry(globalRoot);
    await registry.register({
      sessionId,
      projectSlug,
      projectRoot,
      projectName: projectSlug,
      workingDir: projectRoot,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    return async () => {
      await registry.dispose().catch(() => {});
      const { SessionCatalogProjectClient } = await import('@wrongstack/core/session-catalog');
      const projectDir = path.join(globalRoot, 'projects', projectSlug);
      await new SessionCatalogProjectClient({ projectDir, projectRoot })
        .shutdown('test cleanup')
        .catch(() => undefined);
    };
  }

  async function startTokenHqServer(
    port: number,
    capabilities?: string[],
  ): Promise<HqServerHandle> {
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [
        {
          id: 'bt-mb',
          token: BROWSER_TOKEN,
          createdAt: new Date().toISOString(),
          ...(capabilities ? { capabilities } : {}),
        },
      ],
      clientTokens: [],
    });
    return startHqServer({ port, dataDir });
  }

  it('rejects an unauthenticated request in token mode with 401', async () => {
    const port = getPort();
    // Browser token configured but NOT supplied on the request.
    handle = await startTokenHqServer(port);
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/mailbox-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', type: 'steer', body: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a token lacking control.enqueue with 403', async () => {
    const port = getPort();
    // Token present but scoped to a capability that is NOT control.enqueue.
    handle = await startTokenHqServer(port, ['telemetry.publish']);
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/mailbox-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: bearer() },
      body: JSON.stringify({ sessionId: 's1', type: 'steer', body: 'hi' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 400 when neither sessionId nor projectId is provided', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/mailbox-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'steer', body: 'hi' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown mailbox audience instead of widening it to all agents', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/mailbox-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'any-session',
        type: 'steer',
        body: 'private context',
        audience: 'workers',
      }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'audience must be all or leaders' });
  });

  it('returns 404 when the target project mailbox cannot be resolved', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });
    // No session seeded — resolution fails.
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/mailbox-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'missing-session', type: 'steer', body: 'hi' }),
    });
    expect(res.status).toBe(404);
  });

  it('resolves projectRoot from sessionId and writes the message to that project mailbox', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const globalRoot = globalRootForData(dataDir);
    const projectRoot = path.join(dataDir, 'mb-project');
    await fs.mkdir(projectRoot, { recursive: true });
    const cleanup = await seedSession(globalRoot, 'sess-mb-1', 'mb-project', projectRoot);
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/mailbox-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-mb-1',
          type: 'steer',
          to: 'leader',
          subject: 'HQ prompt',
          body: 'continue please',
          priority: 'high',
        }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as {
        delivered: boolean;
        messageId?: string;
        to: string;
        type: string;
        audience: string;
      };
      expect(body.delivered).toBe(true);
      expect(body.messageId).toBeTruthy();
      expect(body.to).toBe('leader');
      expect(body.type).toBe('steer');
      expect(body.audience).toBe('all');

      // The message must be readable from the SAME project mailbox the server
      // resolved — proving the write landed with zero connected clients.
      const { createProjectMailbox, resolveProjectDir } = await import(
        '@wrongstack/core/coordination'
      );
      const projectDir = resolveProjectDir(projectRoot, globalRoot);
      const mailbox = createProjectMailbox({ projectDir, isolatedConnection: true });
      const msgs = await mailbox.query({ to: 'leader' });
      const found = msgs.find((m) => m.body === 'continue please');
      expect(found).toBeTruthy();
      expect(found?.type).toBe('steer');
      expect(found?.subject).toBe('HQ prompt');
      expect(found?.from).toMatch(/^hq@/);
    } finally {
      await cleanup();
    }
  });

  it('scopes a leader-addressed send to the named session', async () => {
    // The bare `leader` alias is answered by EVERY leader in the project and
    // unread state is per reader, so without the affinity stamp a steer aimed
    // at one session is also consumed by every other terminal on that project.
    // The route already knew which session the operator picked — it just threw
    // the id away after resolving the project root.
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const globalRoot = globalRootForData(dataDir);
    const projectRoot = path.join(dataDir, 'mb-project-scope');
    await fs.mkdir(projectRoot, { recursive: true });
    const cleanup = await seedSession(globalRoot, 'sess-scope-1', 'mb-project-scope', projectRoot);
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/mailbox-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-scope-1',
          type: 'steer',
          to: 'leader',
          body: 'scoped steer',
        }),
      });
      expect(res.status).toBe(202);

      const { createProjectMailbox, resolveProjectDir } = await import(
        '@wrongstack/core/coordination'
      );
      const mailbox = createProjectMailbox({
        projectDir: resolveProjectDir(projectRoot, globalRoot),
        isolatedConnection: true,
      });
      const stamped = (await mailbox.query({ to: 'leader' })).find(
        (m) => m.body === 'scoped steer',
      );
      expect(stamped?.sessionAffinity).toEqual({ sessionId: 'sess-scope-1' });

      // The receive-side filter every leader's inbox runs: another session's
      // leader must not see it.
      const forOther = await mailbox.query({ to: 'leader', currentSessionId: 'sess-scope-2' });
      expect(forOther.some((m) => m.body === 'scoped steer')).toBe(false);
      const forOwner = await mailbox.query({ to: 'leader', currentSessionId: 'sess-scope-1' });
      expect(forOwner.some((m) => m.body === 'scoped steer')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('leaves an explicitly addressed recipient unscoped', async () => {
    // A subagent delegated from another tab carries THAT tab's owning session;
    // stamping the leader's session would drop the message at the receiver.
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const globalRoot = globalRootForData(dataDir);
    const projectRoot = path.join(dataDir, 'mb-project-unscoped');
    await fs.mkdir(projectRoot, { recursive: true });
    const cleanup = await seedSession(
      globalRoot,
      'sess-scope-3',
      'mb-project-unscoped',
      projectRoot,
    );
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/mailbox-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-scope-3',
          type: 'steer',
          to: 'reviewer-3',
          body: 'unscoped steer',
        }),
      });
      expect(res.status).toBe(202);

      const { createProjectMailbox, resolveProjectDir } = await import(
        '@wrongstack/core/coordination'
      );
      const mailbox = createProjectMailbox({
        projectDir: resolveProjectDir(projectRoot, globalRoot),
        isolatedConnection: true,
      });
      const sent = (await mailbox.query({ to: 'reviewer-3' })).find(
        (m) => m.body === 'unscoped steer',
      );
      expect(sent?.sessionAffinity).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('maps a queue send to a note mailbox message', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const globalRoot = globalRootForData(dataDir);
    const projectRoot = path.join(dataDir, 'mb-project-q');
    await fs.mkdir(projectRoot, { recursive: true });
    const cleanup = await seedSession(globalRoot, 'sess-mb-q', 'mb-project-q', projectRoot);
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/mailbox-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-mb-q',
          type: 'queue',
          to: 'leader',
          body: 'later task',
        }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { type: string };
      // queue is delivered as a plain `note` mailbox message.
      expect(body.type).toBe('note');

      const { createProjectMailbox, resolveProjectDir } = await import(
        '@wrongstack/core/coordination'
      );
      const mailbox = createProjectMailbox({
        projectDir: resolveProjectDir(projectRoot, globalRoot),
        isolatedConnection: true,
      });
      const msgs = await mailbox.query({ to: 'leader' });
      const found = msgs.find((m) => m.body === 'later task');
      expect(found?.type).toBe('note');
    } finally {
      await cleanup();
    }
  });

  it('delivers result mail with a leaders-only audience', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const globalRoot = globalRootForData(dataDir);
    const projectRoot = path.join(dataDir, 'mb-project-result');
    await fs.mkdir(projectRoot, { recursive: true });
    const cleanup = await seedSession(
      globalRoot,
      'sess-mb-result',
      'mb-project-result',
      projectRoot,
    );
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/mailbox-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-mb-result',
          type: 'result',
          to: 'leader',
          audience: 'leaders',
          body: 'review complete',
        }),
      });
      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toMatchObject({
        delivered: true,
        to: 'leader',
        type: 'result',
        audience: 'leaders',
      });

      const { createProjectMailbox, resolveProjectDir } = await import(
        '@wrongstack/core/coordination'
      );
      const mailbox = createProjectMailbox({
        projectDir: resolveProjectDir(projectRoot, globalRoot),
        isolatedConnection: true,
      });
      const messages = await mailbox.query({ to: 'leader' });
      expect(messages.find((message) => message.body === 'review complete')).toMatchObject({
        type: 'result',
        audience: 'leaders',
      });
    } finally {
      await cleanup();
    }
  });

  it('mounts the shared mailbox router under a project-scoped HQ path', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const globalRoot = globalRootForData(dataDir);
    const projectRoot = path.join(dataDir, 'mb-gateway-project');
    await fs.mkdir(projectRoot, { recursive: true });
    const cleanup = await seedSession(
      globalRoot,
      'sess-mb-gateway',
      'mb-gateway-project',
      projectRoot,
    );
    const base = `http://127.0.0.1:${handle.port}/api/projects/mb-gateway-project/mailbox`;
    try {
      const sent = await fetch(`${base}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'external-hq-test',
          to: 'gateway-reader',
          type: 'note',
          subject: 'shared-router',
          body: 'delivered through HQ',
        }),
      });
      expect(sent.status).toBe(201);
      const sentMessage = (await sent.json()) as { id: string };

      const queried = await fetch(`${base}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'gateway-reader' }),
      });
      expect(queried.status).toBe(200);
      const queryBody = (await queried.json()) as {
        data: Array<{ id: string; subject: string }>;
        count: number;
      };
      expect(queryBody.count).toBe(1);
      expect(queryBody.data[0]).toMatchObject({
        id: sentMessage.id,
        subject: 'shared-router',
      });

      const acknowledged = await fetch(`${base}/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: sentMessage.id,
          readerId: 'gateway-reader',
          completed: true,
          outcome: 'handled',
        }),
      });
      expect(acknowledged.status).toBe(200);
      expect(
        ((await acknowledged.json()) as { updated: { completed: boolean; outcome?: string } })
          .updated,
      ).toMatchObject({ completed: true, outcome: 'handled' });

      const registered = await fetch(`${base}/agents/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: 'external-hq-agent',
          sessionId: 'external',
          name: 'HQ external agent',
          pid: 12345,
        }),
      });
      expect(registered.status).toBe(200);

      const agents = await fetch(`${base}/agents`);
      expect(agents.status).toBe(200);
      const agentBody = (await agents.json()) as {
        data: Array<{ agentId: string; source?: string }>;
      };
      expect(agentBody.data).toContainEqual(
        expect.objectContaining({ agentId: 'external-hq-agent', source: 'http' }),
      );
    } finally {
      await cleanup();
    }
  });

  it('streams legacy HQ mailbox writes through the shared router SSE mount', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const globalRoot = globalRootForData(dataDir);
    const projectRoot = path.join(dataDir, 'mb-gateway-sse');
    await fs.mkdir(projectRoot, { recursive: true });
    const cleanup = await seedSession(
      globalRoot,
      'sess-mb-gateway-sse',
      'mb-gateway-sse',
      projectRoot,
    );
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const stream = await fetch(
        `http://127.0.0.1:${handle.port}/api/projects/mb-gateway-sse/mailbox/events`,
        { signal: controller.signal },
      );
      expect(stream.status).toBe(200);
      expect(stream.headers.get('content-type')).toContain('text/event-stream');
      reader = stream.body?.getReader();
      if (!reader) throw new Error('HQ mailbox SSE response has no body');

      const decoder = new TextDecoder();
      const connected = await reader.read();
      expect(decoder.decode(connected.value)).toContain(': connected');

      const eventPromise = (async () => {
        let raw = '';
        while (!raw.includes('message.sent')) {
          const chunk = await reader!.read();
          if (chunk.done) break;
          raw += decoder.decode(chunk.value);
        }
        return raw;
      })();

      const sent = await fetch(`http://127.0.0.1:${handle.port}/api/mailbox-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'mb-gateway-sse',
          type: 'steer',
          to: 'gateway-reader',
          body: 'legacy route over shared emitter',
        }),
      });
      expect(sent.status).toBe(202);

      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('HQ mailbox SSE event timeout')), 3_000).unref?.();
      });
      expect(await Promise.race([eventPromise, timeout])).toContain('message.sent');
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => undefined);
      await cleanup();
    }
  });

  it('uses the shared router validation and error shape through HQ', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const globalRoot = globalRootForData(dataDir);
    const projectRoot = path.join(dataDir, 'mb-gateway-validation');
    await fs.mkdir(projectRoot, { recursive: true });
    const cleanup = await seedSession(
      globalRoot,
      'sess-mb-gateway-validation',
      'mb-gateway-validation',
      projectRoot,
    );
    try {
      const res = await fetch(
        `http://127.0.0.1:${handle.port}/api/projects/mb-gateway-validation/mailbox/send`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'leader', to: 'x', type: 'note', subject: 's', body: 'b' }),
        },
      );
      expect(res.status).toBe(400);
      expect((await res.json()) as unknown).toMatchObject({
        error: { code: 'VALIDATION_ERROR' },
      });
    } finally {
      await cleanup();
    }
  });

  it('rejects the HQ mailbox router for a token lacking control.enqueue', async () => {
    const port = getPort();
    handle = await startTokenHqServer(port, ['telemetry.publish']);

    const globalRoot = globalRootForData(dataDir);
    const projectRoot = path.join(dataDir, 'mb-gateway-forbidden');
    await fs.mkdir(projectRoot, { recursive: true });
    const cleanup = await seedSession(
      globalRoot,
      'sess-mb-gateway-forbidden',
      'mb-gateway-forbidden',
      projectRoot,
    );
    try {
      const res = await fetch(
        `http://127.0.0.1:${handle.port}/api/projects/mb-gateway-forbidden/mailbox/agents`,
        { headers: { Authorization: bearer() } },
      );
      expect(res.status).toBe(403);
      expect((await res.json()) as unknown).toMatchObject({
        error: { code: 'FORBIDDEN' },
      });
    } finally {
      await cleanup();
    }
  });

  it('returns 404 before the shared router for an unknown HQ project', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/api/projects/missing-project/mailbox/agents`,
    );
    expect(res.status).toBe(404);
    expect((await res.json()) as unknown).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });

  it('returns 400 for an unrecognized mailbox message type', async () => {
    const port = getPort();
    handle = await startOpenHqServer({ port });

    const globalRoot = globalRootForData(dataDir);
    const projectRoot = path.join(dataDir, 'mb-project-bad');
    await fs.mkdir(projectRoot, { recursive: true });
    const cleanup = await seedSession(globalRoot, 'sess-mb-bad', 'mb-project-bad', projectRoot);
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/mailbox-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 'abort' is a real HQ command but not a mailbox-writing type.
        body: JSON.stringify({ sessionId: 'sess-mb-bad', type: 'abort', body: 'x' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await cleanup();
    }
  });
});
