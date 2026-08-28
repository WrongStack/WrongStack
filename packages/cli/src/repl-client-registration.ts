import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { getSharedProjectMailbox, resolveProjectDir } from '@wrongstack/core/coordination';
import { wstackGlobalRoot } from '@wrongstack/core/utils';
import { startCliHqConnection } from './hq-publisher.js';
import type { ReplOptions } from './repl-options.js';

interface ReplClientRegistration {
  clientId: string;
  close(): void;
}

export function registerReplClient(opts: ReplOptions): ReplClientRegistration {
  // Register REPL as a client in the shared mailbox so other REPL/TUI/WebUI
  // instances on the same project know this REPL is running, even when no
  // agents are active.
  const replProjectRoot = opts.projectRoot ?? process.cwd();
  const projectDir = resolveProjectDir(replProjectRoot, wstackGlobalRoot());
  const clientId = `repl@${crypto.randomUUID().slice(0, 8)}`;
  // The REPL never runs a session telemetry bridge, so it must not advertise
  // `session.summary` — HQ would render it as a permanent "waiting for
  // session telemetry" terminal and orphan-evict the socket every 30s.
  const hqConnection = startCliHqConnection({
    clientKind: 'repl',
    projectRoot: replProjectRoot,
    projectName: path.basename(replProjectRoot),
    appConfig: opts.appConfig,
    capabilities: ['telemetry.publish', 'mailbox.summary'],
  });
  const clientMailbox = getSharedProjectMailbox(projectDir, undefined, () =>
    hqConnection.getPublisher(),
  );
  let closed = false;
  let clientHeartbeat: ReturnType<typeof setInterval> | undefined;
  clientMailbox
    .registerClient({
      clientId,
      sessionId: opts.getSessionId?.() ?? replProjectRoot,
      name: `REPL [${path.basename(replProjectRoot)}]`,
      source: 'repl',
      pid: process.pid,
    })
    .then(() => {
      if (closed) return;
      clientHeartbeat = setInterval(() => {
        clientMailbox
          .clientHeartbeat({ clientId, sessionId: opts.getSessionId?.() ?? replProjectRoot })
          .catch(() => {
            // best-effort — if the registry is gone, don't spam errors
          });
      }, 15_000);
    })
    .catch(() => {
      // best-effort — if another instance has the lock, skip registration
    });

  return {
    clientId,
    close() {
      closed = true;
      if (clientHeartbeat) clearInterval(clientHeartbeat);
      clientMailbox.deregisterClient(clientId).catch(() => undefined);
      hqConnection.stop();
    },
  };
}
