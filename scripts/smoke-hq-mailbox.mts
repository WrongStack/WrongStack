/* Smoke test for HQ mailbox event payload shape.
 * Spawns a GlobalMailbox wired to an HqPublisher, sends a few messages,
 * and prints the resulting mailbox.event / mailbox.snapshot envelopes
 * so we can confirm what the browser would receive over the WS. */
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { GlobalMailbox } from '../packages/core/dist/coordination/index.js';
import { HqPublisher, type HqSocketLike } from '../packages/core/dist/hq/index.js';

function makeMockSocket(): { socket: HqSocketLike; sent: string[] } {
  const sent: string[] = [];
  const listeners: Record<string, Array<(ev: unknown) => void>> = {
    open: [],
    close: [],
    error: [],
    message: [],
  };
  const socket: HqSocketLike = {
    readyState: 0,
    send(data: string): void {
      sent.push(data);
    },
    close(): void {},
    addEventListener(type, listener): void {
      listeners[type]?.push(listener);
    },
  };
  // Simulate WebSocket OPEN immediately.
  setImmediate(() => {
    socket.readyState = 1;
    for (const l of listeners.open) l({});
  });
  return { socket, sent };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'hq-mailbox-smoke-'));
  const { socket, sent } = makeMockSocket();
  const publisher = new HqPublisher({
    url: 'http://127.0.0.1:1',
    client: {
      clientId: 'smoke',
      kind: 'cli',
      machineId: 'm1',
      startedAt: new Date().toISOString(),
    },
    project: {
      projectId: 'demo',
      projectRoot: dir,
      projectName: 'demo',
      machineId: 'm1',
      workspaceKind: 'directory',
    },
    socketFactory: () => socket,
    reconnect: false,
    redactionPolicy: { rawContent: true, toolArgs: 'summary', paths: 'project-relative' },
  });
  publisher.connect();

  // Wait for the open + hello handshake to flush.
  await new Promise((r) => setTimeout(r, 50));

  const m = new GlobalMailbox(dir, undefined, () => publisher);
  await m.send({
    from: 'leader',
    to: '*',
    type: 'status',
    subject: 'Hello HQ',
    body: 'Smoke test message body with details',
    priority: 'high',
  });
  await m.send({
    from: 'leader',
    to: 'worker',
    type: 'assign',
    subject: 'Build feature',
    body: 'Implement the new endpoint',
    priority: 'normal',
  });
  await m.send({
    from: 'worker',
    to: 'leader',
    type: 'result',
    subject: 'Re: Build feature',
    body: 'Done',
    priority: 'normal',
  });

  // Allow async snapshot publishes to flush.
  await new Promise((r) => setTimeout(r, 50));

  const frames = sent
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(
      (f): f is { type: string; event?: { type: string; payload: unknown } } =>
        f !== null && typeof f === 'object',
    )
    .filter(
      (f) =>
        f.event !== undefined &&
        (f.event.type === 'mailbox.event' || f.event.type === 'mailbox.snapshot'),
    )
    .map((f) => ({
      type: f.event.type,
      action: f.event.payload.action,
      mailboxId: f.event.payload.mailboxId,
      message: f.event.payload.message
        ? {
            from: f.event.payload.message.from,
            to: f.event.payload.message.to,
            subject: f.event.payload.message.subject,
            type: f.event.payload.message.type,
            priority: f.event.payload.message.priority,
            bodyPreview: f.event.payload.message.bodyPreview,
            hasBody: f.event.payload.message.hasBody,
          }
        : undefined,
    }));
  console.log(JSON.stringify({ count: frames.length, frames }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
