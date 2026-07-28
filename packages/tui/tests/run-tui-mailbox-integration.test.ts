import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MailboxProjectServerConnection,
  RemoteMailbox,
  resolveProjectDir,
} from '@wrongstack/core/coordination';
import { EventBus } from '@wrongstack/core/kernel';
import { wstackGlobalRoot } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TuiMailboxSnapshot } from '../src/mailbox-view-model-types.js';
import { createRunTuiClientRegistration } from '../src/run-tui-client-registration.js';

let root: string;
let projectRoot: string;
let previousHome: string | undefined;
let previousForceServer: string | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tui-mailbox-ipc-'));
  projectRoot = path.join(root, 'project');
  await fs.mkdir(projectRoot, { recursive: true });
  previousHome = process.env['WRONGSTACK_HOME'];
  previousForceServer = process.env['WRONGSTACK_MAILBOX_FORCE_SERVER'];
  process.env['WRONGSTACK_HOME'] = path.join(root, 'global');
  process.env['WRONGSTACK_MAILBOX_FORCE_SERVER'] = '1';
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env['WRONGSTACK_HOME'];
  else process.env['WRONGSTACK_HOME'] = previousHome;
  if (previousForceServer === undefined) delete process.env['WRONGSTACK_MAILBOX_FORCE_SERVER'];
  else process.env['WRONGSTACK_MAILBOX_FORCE_SERVER'] = previousForceServer;
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

function nextSnapshot(
  events: EventBus,
  predicate: (snapshot: TuiMailboxSnapshot) => boolean,
): Promise<TuiMailboxSnapshot> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('timed out waiting for mailbox.snapshot'));
    }, 8_000);
    const unsubscribe = events.onPattern('mailbox.snapshot', (_event, payload) => {
      const snapshot = payload as TuiMailboxSnapshot;
      if (!predicate(snapshot)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(snapshot);
    });
  });
}

describe('TUI mailbox SQLite/IPC integration', () => {
  it('renders authoritative messages, presence, unread, and owner health from snapshots', async () => {
    const events = new EventBus();
    const registration = createRunTuiClientRegistration({
      projectRoot,
      events,
      hqTelemetryOwnedExternally: true,
      getSessionId: () => 'tui-session',
      getAgentId: () => 'leader@tui-session',
      isCleaned: () => false,
    });
    const projectDir = resolveProjectDir(projectRoot, wstackGlobalRoot());
    const producer = new RemoteMailbox({ projectDir, isolatedConnection: true });
    try {
      const initialSnapshotPromise = nextSnapshot(
        events,
        (snapshot) => snapshot.service.state === 'online',
      );
      expect(await registration.register()).toMatch(/^tui@/u);
      const initial = await initialSnapshotPromise;
      expect(initial.service).toMatchObject({ state: 'online', storageKind: 'sqlite' });
      expect(initial.clients.tui).toBe(1);

      const messageSnapshotPromise = nextSnapshot(
        events,
        (snapshot) =>
          snapshot.service.state === 'online' &&
          snapshot.messages.some((message) => message.subject === 'authoritative snapshot'),
      );
      await producer.send({
        from: 'worker@other',
        to: 'leader@tui-session',
        type: 'note',
        subject: 'authoritative snapshot',
        body: 'real body from SQLite',
      });
      const updated = await messageSnapshotPromise;
      expect(updated.messages[0]).toMatchObject({
        subject: 'authoritative snapshot',
        body: 'real body from SQLite',
      });
      expect(updated.unread).toBe(1);
    } finally {
      registration.unregister();
      await producer.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const control = new MailboxProjectServerConnection(projectDir);
      await control.shutdown('tui-integration-test-complete').catch(() => undefined);
      control.close();
    }
  });
});
