import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MailboxProjectServerConnection } from '../src/mailbox-project-server-client.js';
import {
  mailboxProjectServerEndpoint,
  mailboxProjectServerMetadataPath,
} from '../src/mailbox-project-server-endpoint.js';
import { MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION } from '../src/mailbox-project-server-protocol.js';

/**
 * Regression: a client spawned a contender daemon while a live owner was still
 * starting up. The daemon writes `.mailbox-server.json` before it greets (on
 * Windows it first restricts the file's ACL with an `icacls` spawn), so a
 * client whose first 750 ms handshake landed in that window treated the owner
 * as missing and spawned a second daemon. That contender could win the
 * endpoint after the owner shut down and keep the project's SQLite files open,
 * failing a Windows teardown with EBUSY (mailbox-mcp actor-scoped-read).
 *
 * The endpoint here never greets the first connection and greets every later
 * one; the daemon spawn is stubbed. Spawning is decided between the two
 * connections, so the test is event-ordered and needs no sleeps.
 */
let projectDir: string;
let server: net.Server;
let connections: number;
let sockets: net.Socket[];
/** Which connections (1-based) the fake owner greets. */
let greets: (connection: number) => boolean;

function hello(): string {
  return `${JSON.stringify({
    type: 'hello',
    protocolVersion: MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION,
    pid: process.pid,
    projectDir,
    endpoint: mailboxProjectServerEndpoint(projectDir),
    startedAt: new Date().toISOString(),
  })}\n`;
}

async function writeMetadata(fields: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    mailboxProjectServerMetadataPath(projectDir),
    JSON.stringify({
      protocolVersion: MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION,
      pid: process.pid,
      projectDir,
      endpoint: mailboxProjectServerEndpoint(projectDir),
      startedAt: new Date().toISOString(),
      authToken: 'a'.repeat(32),
      ...fields,
    }),
  );
}

function stubSpawn() {
  return vi
    .spyOn(
      MailboxProjectServerConnection.prototype as unknown as {
        spawnDetachedServer(): number | undefined;
      },
      'spawnDetachedServer',
    )
    .mockReturnValue(undefined);
}

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-live-owner-spawn-'));
  connections = 0;
  sockets = [];
  // The first connection models an owner that has written its metadata but
  // not greeted yet; every later one is greeted.
  greets = (connection) => connection > 1;
  server = net.createServer((socket) => {
    connections++;
    sockets.push(socket);
    socket.on('error', () => undefined);
    if (greets(connections)) socket.write(hello());
  });
  await new Promise<void>((resolve) =>
    server.listen(mailboxProjectServerEndpoint(projectDir), resolve),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(projectDir, { recursive: true, force: true });
});

it('does not spawn a contender while the metadata names a live owner on this endpoint', async () => {
  await writeMetadata({});
  const spawn = stubSpawn();
  const client = new MailboxProjectServerConnection(projectDir);
  try {
    await client.connect();
    expect(connections).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    client.close();
  }
});

it('stops holding off the spawn once the live-owner grace window has passed', async () => {
  // The metadata names a live pid on this endpoint that never greets: a
  // crashed daemon's leftover file whose pid the OS reused. The hold-off must
  // be bounded, or the client never spawns the daemon it needs. The clock
  // jumps past the 5 s grace on the first connection (still inside the 10 s
  // start deadline), so no real waiting is needed; greeting starts only once
  // a spawn was requested.
  await writeMetadata({});
  const realNow = Date.now.bind(Date);
  let offsetMs = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offsetMs);
  let spawned = false;
  greets = () => spawned;
  server.on('connection', () => {
    offsetMs = 6_000;
  });
  const spawn = vi
    .spyOn(
      MailboxProjectServerConnection.prototype as unknown as {
        spawnDetachedServer(): number | undefined;
      },
      'spawnDetachedServer',
    )
    .mockImplementation(() => {
      spawned = true;
      return undefined;
    });
  const client = new MailboxProjectServerConnection(projectDir);
  try {
    await client.connect();
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally {
    client.close();
  }
}, 15_000);

it('still spawns when the metadata owner is dead', async () => {
  // Not a live pid on any platform (above the Windows and Linux pid ranges).
  await writeMetadata({ pid: 2_147_483_000 });
  const spawn = stubSpawn();
  const client = new MailboxProjectServerConnection(projectDir);
  try {
    await client.connect();
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally {
    client.close();
  }
});

it('still spawns when the live owner serves a different endpoint (another protocol version)', async () => {
  await writeMetadata({ endpoint: `${mailboxProjectServerEndpoint(projectDir)}-other-protocol` });
  const spawn = stubSpawn();
  const client = new MailboxProjectServerConnection(projectDir);
  try {
    await client.connect();
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally {
    client.close();
  }
});

it('still spawns when no metadata exists', async () => {
  const spawn = stubSpawn();
  const client = new MailboxProjectServerConnection(projectDir);
  try {
    await client.connect();
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally {
    client.close();
  }
});
