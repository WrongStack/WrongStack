/**
 * Parametrized in-process lifecycle harness for the six project-server
 * daemons: codebase-index (tools), sage, kanban, chronicle, mailbox, and the
 * governance project server (a class rather than a module script).
 *
 * Every daemon follows the same shape — deterministic per-project IPC
 * endpoint, owner-only metadata file holding the per-process auth token,
 * newline-delimited JSON frames, a `hello` greeting gated on the metadata
 * being readable, an authenticated health `ping`, a gated `shutdown`, and an
 * idle timer armed at listen(). The daemons are module-level scripts that
 * bind when their module body evaluates, so a test worker can run them
 * IN-PROCESS — the only way vitest's v8 coverage measures the daemon source
 * (a spawned child's execution is invisible to the worker's collector).
 *
 * Mechanisms (see helpers/project-server-harness.ts for details):
 *  - `process.argv` is set around a synchronous dynamic import; the root
 *    config's forks pool runs one test FILE per worker, so this is file-safe.
 *  - Query-suffixed import URLs give each test a fresh module instance.
 *
 * The kanban daemon routes every stop path through `stopAndExit()` →
 * `process.exit(0)`, which would kill the worker; its case covers
 * bind/metadata/hello/ping/auth and leaves the temp root in place (its
 * liveness timer exits if the root vanishes). Kanban exit paths remain
 * covered by the existing child-process tests in packages/kanban/tests.
 *
 * Governance is a class with a different wire protocol (a strict envelope
 * with a capability-grant credential and requestId-correlated responses) —
 * it gets its own describe block below.
 */
import * as fs from 'node:fs/promises';
import type * as net from 'node:net';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { governanceProjectServerEndpoint } from '../../governance/src/ipc-endpoint.js';
import { GovernanceProjectServer } from '../../governance/src/project-server.js';
import { GOVERNANCE_SERVICE_PROTOCOL_VERSION } from '../../governance/src/service-protocol.js';
import { kanbanProjectServerEndpoint } from '../../kanban/src/server/endpoint.js';
import {
  sageProjectServerEndpoint,
  sageProjectServerMetadataPath,
} from '../../sage/src/project-server-endpoint.js';
import {
  projectIndexServerEndpoint,
  projectIndexServerMetadataPath,
} from '../../tools/src/codebase-index/project-server-endpoint.js';
import {
  chronicleProjectServerEndpoint,
  chronicleProjectServerMetadataPath,
} from '../src/chronicle/project-server-endpoint.js';
import {
  mailboxProjectServerEndpoint,
  mailboxProjectServerMetadataPath,
} from '../src/coordination/mailbox-project-server-endpoint.js';
import {
  connectFrame,
  importDaemonInstance,
  makeTempRoot,
  sleep,
  waitForEndpointClosed,
  waitForMetadataFile,
  waitForMetadataRemoval,
} from './helpers/project-server-harness.js';

type JsonRecord = Record<string, unknown>;

interface FrameClient {
  socket: net.Socket;
  nextFrame: (timeout?: number) => Promise<JsonRecord>;
}

function sendFrame(client: FrameClient, frame: JsonRecord): void {
  client.socket.write(`${JSON.stringify(frame)}\n`);
}

interface HarnessCase {
  name: string;
  /** Module-script daemons: import URL. `null` for the governance class. */
  moduleUrl: string | null;
  args: (root: string) => string[];
  endpoint: (root: string) => string;
  metadataPath: (root: string) => string;
  /** Env var that shortens the idle timer; `null` when the daemon has none. */
  idleEnv: string | null;
  expectedProtocolVersion: number;
  /** The daemon greets connecting sockets with a `hello` frame. */
  hasHello: boolean;
  /** Idle-exit is safe to exercise in-process. */
  supportsIdle: boolean;
  /** The daemon exits cleanly on a `shutdown` request in-process. */
  supportsShutdown: boolean;
  /** Temp root must stay after the test (kanban liveness timer exits on rm). */
  keepRoot: boolean;
  watch: 'configure' | 'health' | 'none';
  /** Start the daemon; returns an optional teardown (governance close). */
  start: (
    root: string,
    nonce: number,
    shortIdle: boolean,
  ) => Promise<{ teardown?: () => Promise<void> }>;
  /** Build the authenticated health ping frame. */
  pingFrame: (id: number, authToken: string) => JsonRecord;
  /** Build the authenticated shutdown frame. */
  shutdownFrame: (id: number, authToken: string, reason: string) => JsonRecord;
  /** Build the unauthenticated ping frame. */
  unauthPingFrame: (id: number) => JsonRecord;
  /** Assert the auth-rejection frame shape. */
  expectAuthReject: (frame: JsonRecord) => void;
  /** Optional watch assertion (tools configure / chronicle health). */
  expectWatch?: (client: FrameClient, authToken: string) => Promise<void>;
}

function errorName(frame: JsonRecord): string | undefined {
  return typeof frame.errorName === 'string' ? frame.errorName : undefined;
}

const CHRONICLE_ARGS = (root: string): string[] => [
  '--project-root',
  root,
  '--global-root',
  root,
  '--project-id',
  'harness-chronicle',
  '--project-dir',
  root,
  '--workspace-id',
  'harness-workspace',
];

const CASES: HarnessCase[] = [
  {
    name: 'codebase-index',
    moduleUrl: '../../../tools/src/codebase-index/project-server.ts',
    args: (root) => ['--project-root', root, '--index-dir', path.join(root, '.index')],
    endpoint: (root) => projectIndexServerEndpoint(root, path.join(root, '.index')),
    metadataPath: (root) => projectIndexServerMetadataPath(root, path.join(root, '.index')),
    idleEnv: 'WRONGSTACK_INDEX_SERVER_IDLE_MS',
    expectedProtocolVersion: 1,
    hasHello: true,
    supportsIdle: true,
    supportsShutdown: true,
    keepRoot: false,
    watch: 'configure',
    start: (root, nonce, shortIdle) =>
      importDaemonInstance(
        '../../../tools/src/codebase-index/project-server.ts',
        ['--project-root', root, '--index-dir', path.join(root, '.index')],
        nonce,
        shortIdle ? 'WRONGSTACK_INDEX_SERVER_IDLE_MS' : null,
      ),
    pingFrame: (id, authToken) => ({ type: 'ping', id, authToken }),
    shutdownFrame: (id, authToken, reason) => ({ type: 'shutdown', id, reason, authToken }),
    unauthPingFrame: (id) => ({ type: 'ping', id }),
    expectAuthReject: (frame) => {
      expect(frame.type).toBe('response');
      expect(frame.ok).toBe(false);
      expect(errorName(frame)).toBe('UnauthorizedIndexRequest');
    },
    expectWatch: async (client, authToken) => {
      sendFrame(client, {
        type: 'configure',
        id: 901,
        watchExternal: true,
        debounceMs: 50,
        authToken,
      });
      const response = await client.nextFrame();
      expect(response.type).toBe('response');
      expect(response.id).toBe(901);
      expect(response.ok).toBe(true);
      expect((response.result as JsonRecord).watching).toBe(true);
      expect((response.result as JsonRecord).health).toBeTruthy();
    },
  },
  {
    name: 'sage',
    moduleUrl: '../../../sage/src/project-server.ts',
    args: (root) => ['--project-root', root],
    endpoint: (root) => sageProjectServerEndpoint(root),
    metadataPath: (root) => sageProjectServerMetadataPath(root),
    idleEnv: 'WRONGSTACK_SAGE_SERVER_IDLE_MS',
    expectedProtocolVersion: 1,
    hasHello: true,
    supportsIdle: true,
    supportsShutdown: true,
    keepRoot: false,
    watch: 'none',
    start: (root, nonce, shortIdle) =>
      importDaemonInstance(
        '../../../sage/src/project-server.ts',
        ['--project-root', root],
        nonce,
        shortIdle ? 'WRONGSTACK_SAGE_SERVER_IDLE_MS' : null,
      ),
    pingFrame: (id, authToken) => ({
      type: 'request',
      id,
      op: 'ping',
      args: {},
      meta: { authToken },
    }),
    shutdownFrame: (id, authToken, reason) => ({ type: 'shutdown', id, reason, authToken }),
    unauthPingFrame: (id) => ({ type: 'request', id, op: 'ping', args: {}, meta: {} }),
    expectAuthReject: (frame) => {
      expect(frame.type).toBe('response');
      expect(frame.ok).toBe(false);
      expect(errorName(frame)).toBe('UnauthorizedSageRequest');
    },
  },
  {
    name: 'kanban',
    moduleUrl: null, // started via its exported main()
    args: (root) => ['--project-root', root],
    endpoint: (root) => kanbanProjectServerEndpoint(root),
    metadataPath: (root) => path.join(root, '.wrongstack', 'kanban-server.json'),
    idleEnv: 'WRONGSTACK_KANBAN_SERVER_IDLE_MS',
    expectedProtocolVersion: 6,
    hasHello: true,
    supportsIdle: false, // every stop path calls process.exit(0)
    supportsShutdown: false,
    keepRoot: true, // liveness timer exits if the root is removed
    watch: 'none',
    start: async (root, nonce, shortIdle) => {
      const mod = await importDaemonInstance(
        '../../../kanban/src/server/project-server.ts',
        [],
        nonce,
        shortIdle ? 'WRONGSTACK_KANBAN_SERVER_IDLE_MS' : null,
      );
      await (mod as { main: (argv: string[]) => Promise<void> }).main(['--project-root', root]);
      return {};
    },
    pingFrame: (id, authToken) => ({ id, method: 'ping', params: {}, authToken }),
    shutdownFrame: (id, authToken, reason) => ({
      id,
      method: 'shutdown',
      params: { reason },
      authToken,
    }),
    unauthPingFrame: (id) => ({ id, method: 'ping', params: {} }),
    expectAuthReject: (frame) => {
      expect((frame as { error?: { code?: string } }).error?.code).toBe('UNAUTHORIZED');
    },
  },
  {
    name: 'chronicle',
    moduleUrl: '../../src/chronicle/project-server.ts',
    args: CHRONICLE_ARGS,
    endpoint: (root) => chronicleProjectServerEndpoint(root),
    metadataPath: (root) => chronicleProjectServerMetadataPath(root),
    idleEnv: 'WRONGSTACK_CHRONICLE_SERVER_IDLE_MS',
    expectedProtocolVersion: 2,
    hasHello: true,
    supportsIdle: true,
    supportsShutdown: true,
    keepRoot: false,
    watch: 'health', // file observer started at listen; exposed via health
    start: (root, nonce, shortIdle) =>
      importDaemonInstance(
        '../../src/chronicle/project-server.ts',
        CHRONICLE_ARGS(root),
        nonce,
        shortIdle ? 'WRONGSTACK_CHRONICLE_SERVER_IDLE_MS' : null,
      ),
    pingFrame: (id, authToken) => ({ type: 'request', id, op: 'ping', args: {}, authToken }),
    shutdownFrame: (id, authToken, reason) => ({ type: 'shutdown', id, reason, authToken }),
    unauthPingFrame: (id) => ({ type: 'request', id, op: 'ping', args: {} }),
    expectAuthReject: (frame) => {
      expect(frame.type).toBe('response');
      expect(frame.ok).toBe(false);
      expect(errorName(frame)).toBe('UnauthorizedChronicleRequest');
    },
    expectWatch: async (client, authToken) => {
      // The file observer starts asynchronously after listen(); poll health
      // until it reports the watcher active (or fail loudly after 5s).
      const deadline = Date.now() + 5_000;
      for (;;) {
        sendFrame(client, { type: 'request', id: 902, op: 'ping', args: {}, authToken });
        const response = await client.nextFrame();
        if (response.id === 902 && response.ok === true) {
          const watcher = (response.result as JsonRecord).watcher as JsonRecord;
          if (watcher?.active === true) {
            expect(typeof watcher.watchedFiles).toBe('number');
            return;
          }
        }
        if (Date.now() >= deadline) {
          throw new Error('chronicle health never reported an active file watcher');
        }
        await sleep(100);
      }
    },
  },
  {
    name: 'mailbox',
    moduleUrl: '../../src/coordination/mailbox-project-server.ts',
    args: (root) => ['--project-dir', root],
    endpoint: (root) => mailboxProjectServerEndpoint(root),
    metadataPath: (root) => mailboxProjectServerMetadataPath(root),
    idleEnv: 'WRONGSTACK_MAILBOX_SERVER_IDLE_MS',
    expectedProtocolVersion: 4,
    hasHello: true,
    supportsIdle: true,
    supportsShutdown: true,
    keepRoot: false,
    watch: 'none',
    start: (root, nonce, shortIdle) =>
      importDaemonInstance(
        '../../src/coordination/mailbox-project-server.ts',
        ['--project-dir', root],
        nonce,
        shortIdle ? 'WRONGSTACK_MAILBOX_SERVER_IDLE_MS' : null,
      ),
    pingFrame: (id, authToken) => ({ type: 'request', id, op: 'ping', args: {}, authToken }),
    shutdownFrame: (id, authToken, reason) => ({ type: 'shutdown', id, reason, authToken }),
    unauthPingFrame: (id) => ({ type: 'request', id, op: 'ping', args: {} }),
    expectAuthReject: (frame) => {
      expect(frame.type).toBe('response');
      expect(frame.ok).toBe(false);
      expect(errorName(frame)).toBe('UnauthorizedMailboxRequest');
    },
  },
];

/** Open sockets across the file, closed in afterEach. */
const openSockets: net.Socket[] = [];
const teardowns: Array<() => Promise<void>> = [];
const releases: Array<() => Promise<void>> = [];
/** Daemons still running, stopped before their temp roots are removed. */
const runningDaemons: Array<{ c: HarnessCase; root: string }> = [];

/**
 * Stop a running in-process daemon via its shutdown protocol. On Windows an
 * `fs.rm` of a temp root hangs while the daemon's SQLite files are still open
 * in this worker (observed: WAL handle keeps the directory busy), so every
 * daemon must be stopped before its root is released. Idle-stopped daemons
 * (metadata already gone) are a no-op here.
 */
async function stopDaemon(c: HarnessCase, root: string): Promise<void> {
  if (!c.supportsShutdown) return;
  try {
    const metadata = await waitForMetadataFile<JsonRecord>(c.metadataPath(root), 5_000);
    const client = await connectFrame(c.endpoint(root), 5_000);
    openSockets.push(client.socket);
    if (c.hasHello) await client.nextFrame(2_000).catch(() => {});
    const authToken = metadata.authToken as string;
    sendFrame(client, c.shutdownFrame(999, authToken, 'harness-teardown'));
    await client.nextFrame(5_000).catch(() => {});
  } catch {
    // Already stopped (idle exit) or the endpoint is gone — nothing to do.
  }
  await waitForMetadataRemoval(c.metadataPath(root), 5_000).catch(() => {});
  await waitForEndpointClosed(c.endpoint(root), 5_000).catch(() => {});
}

afterEach(async () => {
  for (const daemon of runningDaemons.splice(0)) {
    await stopDaemon(daemon.c, daemon.root).catch(() => {});
  }
  for (const socket of openSockets.splice(0)) {
    socket.destroy();
  }
  for (const teardown of teardowns.splice(0)) {
    await teardown().catch(() => {});
  }
  for (const release of releases.splice(0)) {
    await release().catch(() => {});
  }
});

/**
 * Read frames until the response for `id` arrives, skipping unsolicited
 * server pushes (the codebase-index daemon greets with `hello` + `index-state`,
 * and a response sent after the greeting still sits behind the queued
 * `index-state` frame). Kanban responses are typeless `{ id, ok }` /
 * `{ id, error }` frames, matched by id alone.
 */
async function nextResponse(client: FrameClient, id: number): Promise<JsonRecord> {
  for (;;) {
    const frame = await client.nextFrame();
    if (frame.type === 'response' && frame.id === id) return frame;
    if (frame.id === id && ('ok' in frame || 'error' in frame)) return frame;
  }
}

async function connectAndGreet(c: HarnessCase, endpoint: string) {
  const client = await connectFrame(endpoint);
  openSockets.push(client.socket);
  if (c.hasHello) {
    const hello = await client.nextFrame();
    expect(hello.type).toBe('hello');
    expect(hello.protocolVersion).toBe(c.expectedProtocolVersion);
    expect(hello.pid).toBe(process.pid);
    expect(hello.endpoint).toBe(endpoint);
  }
  return client;
}

async function authenticatedPing(c: HarnessCase, client: FrameClient, authToken: string) {
  sendFrame(client, c.pingFrame(41, authToken));
  const response = await nextResponse(client, 41);
  expect(response.id).toBe(41);
  expect(response.ok).toBe(true);
  const result = response.result as JsonRecord;
  expect(result).toBeTruthy();
  return result;
}

describe.each(CASES)('project-server harness: $name', (c) => {
  const caseNonce = Math.floor(Math.random() * 1_000_000);
  const rootLabel = () => c.name.replace(/[^a-z0-9]/gi, '-');

  it('binds the deterministic endpoint and writes owner-only metadata', async () => {
    const { root, release } = await makeTempRoot(rootLabel(), c.keepRoot);
    releases.push(release);
    const started = await c.start(root, caseNonce, false);
    if (started.teardown) teardowns.push(started.teardown);
    runningDaemons.push({ c, root });

    const metadata = await waitForMetadataFile<JsonRecord>(c.metadataPath(root));
    expect(metadata.pid).toBe(process.pid);
    expect(metadata.endpoint).toBe(c.endpoint(root));
    expect(metadata.protocolVersion).toBe(c.expectedProtocolVersion);
    if (typeof metadata.authToken === 'string') {
      expect(metadata.authToken.length).toBeGreaterThanOrEqual(16);
    }
    if (process.platform !== 'win32') {
      const mode = (await fs.stat(c.metadataPath(root))).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('greets a connecting client with hello and answers an authenticated ping', async () => {
    const { root, release } = await makeTempRoot(rootLabel(), c.keepRoot);
    releases.push(release);
    const started = await c.start(root, caseNonce + 1, false);
    if (started.teardown) teardowns.push(started.teardown);
    runningDaemons.push({ c, root });

    const metadata = await waitForMetadataFile<JsonRecord>(c.metadataPath(root));
    const authToken = metadata.authToken as string;

    const client = await connectAndGreet(c, c.endpoint(root));
    const health = await authenticatedPing(c, client, authToken);
    // `hello` already proved pid identity; the ping payloads differ per
    // protocol (codebase-index's health has no `pid` field at all).
    if (health.pid !== undefined) expect(health.pid).toBe(process.pid);
    expect(typeof health.clients).toBe('number');
    if (c.expectWatch) {
      await c.expectWatch(client, authToken);
    }
  });

  it('rejects unauthenticated requests', async () => {
    const { root, release } = await makeTempRoot(rootLabel(), c.keepRoot);
    releases.push(release);
    const started = await c.start(root, caseNonce + 2, false);
    if (started.teardown) teardowns.push(started.teardown);
    runningDaemons.push({ c, root });

    const metadata = await waitForMetadataFile<JsonRecord>(c.metadataPath(root));
    void metadata; // token deliberately NOT read: the request must fail without it

    const client = await connectFrame(c.endpoint(root));
    openSockets.push(client.socket);
    if (c.hasHello) await client.nextFrame();

    sendFrame(client, c.unauthPingFrame(42));
    const response = await nextResponse(client, 42);
    c.expectAuthReject(response);
  });

  it('shutdown stops the daemon and removes its metadata', async () => {
    if (!c.supportsShutdown) return;
    const { root, release } = await makeTempRoot(rootLabel(), c.keepRoot);
    releases.push(release);
    const started = await c.start(root, caseNonce + 3, false);
    if (started.teardown) teardowns.push(started.teardown);

    const metadata = await waitForMetadataFile<JsonRecord>(c.metadataPath(root));
    const authToken = metadata.authToken as string;
    const client = await connectFrame(c.endpoint(root));
    openSockets.push(client.socket);
    if (c.hasHello) await client.nextFrame();

    sendFrame(client, c.shutdownFrame(43, authToken, 'harness-shutdown'));
    const response = await nextResponse(client, 43);
    expect(response.id).toBe(43);
    expect(response.ok).toBe(true);

    await waitForMetadataRemoval(c.metadataPath(root));
    await waitForEndpointClosed(c.endpoint(root));
  });

  it('exits on idle when no client ever connects', async () => {
    if (!c.supportsIdle) return;
    const { root, release } = await makeTempRoot(`${rootLabel()}-idle`, c.keepRoot);
    releases.push(release);
    const started = await c.start(root, caseNonce + 4, true);
    if (started.teardown) teardowns.push(started.teardown);

    const metadata = await waitForMetadataFile<JsonRecord>(c.metadataPath(root));
    expect(metadata.pid).toBe(process.pid);
    await waitForMetadataRemoval(c.metadataPath(root), 20_000);
    await waitForEndpointClosed(c.endpoint(root), 20_000);
  });
});

// ─── Governance (class-based server, strict envelope protocol) ──────────────

describe('project-server harness: governance', () => {
  async function startGovernance(root: string) {
    const server = new GovernanceProjectServer({
      projectRoot: root,
      projectId: 'harness-governance-project',
      daemonControl: {
        status: () => ({
          projectId: 'harness-governance-project',
          pid: process.pid,
          instanceId: 'harness-governance-instance',
          startedAt: new Date().toISOString(),
        }),
      },
    });
    await server.start();
    const grant = server.issueGrant({
      clientId: 'harness-client',
      capabilities: ['daemon_status_read', 'daemon_control'],
      ttlMs: 60_000,
    });
    return {
      server,
      credential: {
        token: grant.token,
        projectId: 'harness-governance-project',
        clientId: 'harness-client',
      },
    };
  }

  function envelope(credential: JsonRecord, request: JsonRecord): JsonRecord {
    return {
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      credential,
      request: { protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION, ...request },
    };
  }

  it('serves an authenticated daemon-status request over the IPC endpoint', async () => {
    const { root, release } = await makeTempRoot('governance-status', false);
    releases.push(release);
    const { server, credential } = await startGovernance(root);
    teardowns.push(() => server.close());

    const client = await connectFrame(governanceProjectServerEndpoint(root));
    openSockets.push(client.socket);
    sendFrame(
      client,
      envelope(credential, { requestId: 'harness-status-1', type: 'read_daemon_status' }),
    );
    const response = await client.nextFrame();
    expect(response.ok).toBe(true);
    expect((response.result as JsonRecord).type).toBe('daemon_status');
    expect((response.result as JsonRecord).projectId).toBe('harness-governance-project');
  });

  it('rejects a request with an invalid credential', async () => {
    const { root, release } = await makeTempRoot('governance-auth', false);
    releases.push(release);
    const { server } = await startGovernance(root);
    teardowns.push(() => server.close());

    const client = await connectFrame(governanceProjectServerEndpoint(root));
    openSockets.push(client.socket);
    sendFrame(
      client,
      envelope(
        {
          token: 'not-a-real-token',
          projectId: 'harness-governance-project',
          clientId: 'harness-client',
        },
        { requestId: 'harness-auth-1', type: 'read_daemon_status' },
      ),
    );
    const response = await client.nextFrame();
    expect(response.ok).toBe(false);
    expect((response.error as JsonRecord).code).toBe('authentication_failed');
  });

  it('accepts a shutdown request and closes cleanly', async () => {
    const { root, release } = await makeTempRoot('governance-shutdown', false);
    releases.push(release);
    const { server, credential } = await startGovernance(root);
    teardowns.push(() => server.close());

    const client = await connectFrame(governanceProjectServerEndpoint(root));
    openSockets.push(client.socket);
    sendFrame(
      client,
      envelope(credential, {
        requestId: 'harness-shutdown-1',
        type: 'request_daemon_shutdown',
        expectedInstanceId: 'harness-governance-instance',
        reason: 'harness-shutdown',
      }),
    );
    const response = await client.nextFrame();
    expect(response.ok).toBe(true);
    expect((response.result as JsonRecord).type).toBe('daemon_shutdown_accepted');

    await server.close();
    await waitForEndpointClosed(governanceProjectServerEndpoint(root));
  });
});
