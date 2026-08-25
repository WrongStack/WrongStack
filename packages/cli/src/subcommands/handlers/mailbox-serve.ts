/**
 * `wstack mailbox serve` — run a loopback HTTP façade over the project's
 * shared project mailbox, so external coding agents (Claude Code, Aider,
 * custom scripts) can read and send messages on the same channel that
 * WrongStack-internal agents use.
 *
 * ## Design
 *
 * The server is intentionally tiny: one `node:http` server, a single
 * project mailbox client, and a bearer-token gate. Every route is a
 * thin JSON-in / JSON-out wrapper over a `Mailbox` method, so all
 * file locking, mtime-cached reads, agent heartbeats, and HQ telemetry
 * happen exactly as they do for WrongStack-internal callers. External
 * agents are NOT given raw file access — they go through the project owner
 * so they cannot race the file lock during acks.
 *
 * ## Single-instance lock
 *
 * Per-project isolation. The lock file lives at
 * `<projectDir>/.mailbox-bridge.lock` and records the owner process,
 * the OS-bound URL, and the bearer token. A second `wstack mailbox serve`
 * for the same project detects the live lock, prints the existing URL
 * and token to stdout, and exits 0 — so shell pipelines can capture
 * them with `$(wstack mailbox serve)`. Two different projects get
 * different lock files (different project slugs), so they never collide.
 *
 * When `--port N` is requested but another project on a different
 * project dir already owns that port, the second invocation fails
 * loud and prints the existing owner's URL on stderr — see
 * `--strict-port` for the deterministic variant.
 *
 * ## Authentication
 *
 * On first start we mint a 32-byte random bearer token and persist it
 * in BOTH the lock file AND `<projectDir>/.mailbox.token` (mode 0600).
 * Subsequent restarts of the SAME instance reuse the persisted token,
 * so external agents that read the token before a bridge restart
 * survive the restart without having to re-discover credentials. If
 * the lock file is missing or the recorded PID is dead, we treat this
 * as a fresh instance and mint a new token. Tokens are compared in
 * constant time. The token file is unlinked on clean shutdown when
 * we are still the recorded owner.
 *
 * ## Bind safety
 *
 * Default bind is `127.0.0.1` — loopback only. Pass `--host` to expose
 * to LAN (NOT recommended without a reverse proxy that re-authenticates
 * and rate-limits; the bearer token is the only auth).
 *
 * ## Routes
 *
 *   POST /mailbox/send              → send({from,to,type,subject,body,...})
 *   POST /mailbox/query             → query({to?,from?,unreadBy?,...})
 *   POST /mailbox/check             → check({agentId,baseId?,markRead?,completed?})
 *   POST /mailbox/ack               → ack({messageId,readerId,...})
 *   POST /mailbox/ack-many          → ackMany({acks:[...]})
 *   POST /mailbox/unread-count      → unreadCount({forAgentId})
 *   POST /mailbox/agents/register   → registerAgent({...})  source='http'
 *   POST /mailbox/agents/heartbeat  → heartbeat({...})
 *   POST /mailbox/register-client   → registerClient({...}) source='http'
 *   POST /mailbox/heartbeat         → clientHeartbeat({clientId,sessionId?})
 *   POST /mailbox/purge-clients     → purgeClients()
 *   GET  /mailbox/agents            → getAgentStatuses()
 *   GET  /mailbox/agents/online     → getOnlineAgents()
 *
 * @module subcommands/handlers/mailbox-serve
 */
import { createServer } from 'node:http';
import * as path from 'node:path';
import {
  acquireOrJoin,
  authorizeMailboxBearerToken,
  createMailboxHttpRouter,
  createProjectMailbox,
  finalize,
  MAILBOX_HTTP_DEFAULT_MAX_AGE_MS,
  type MailboxCredentialVerifier,
  MailboxEventEmitter,
  MailboxHttpRateLimiter,
  release,
  resolveProjectDir,
} from '@wrongstack/core/coordination';
import { startSharedHeapWatchdog, wstackGlobalRoot } from '@wrongstack/core/utils';
import { type CliHqConnection, startCliHqConnection } from '../../hq-publisher.js';
import type { SubcommandDeps, SubcommandHandler } from '../contracts.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7788;

export const mailboxServeCmd: SubcommandHandler = async (args, deps) => {
  const sub = args[0];

  if (!sub || sub === 'serve') {
    return startServer(deps);
  }
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    printHelp(deps);
    return 0;
  }

  deps.renderer.writeError(`Unknown mailbox subcommand: ${sub}\n`);
  printHelp(deps);
  return 1;
};

async function startServer(deps: SubcommandDeps): Promise<number> {
  const flags = deps.flags ?? {};
  const host = typeof flags['host'] === 'string' ? flags['host'] : DEFAULT_HOST;
  const portRaw =
    typeof flags['port'] === 'string' ? Number.parseInt(flags['port'], 10) : DEFAULT_PORT;
  const strictPort = flags['strict-port'] === true;
  // `--port 0` is valid and means "let the OS assign a free port" — the
  // same thing the non-strict default does. Reject only NaN, negative,
  // or out-of-range ports.
  if (!Number.isInteger(portRaw) || portRaw < 0 || portRaw > 65535) {
    deps.renderer.writeError(`Invalid --port: ${String(flags['port'])}\n`);
    return 1;
  }

  const projectDir = resolveProjectDir(deps.projectRoot, wstackGlobalRoot());

  // Phase 1 — lock acquire. If another instance already owns this
  // project's mailbox-bridge slot, we either join them (URL/token
  // reuse) or fail loud on port-conflict. Both paths skip the listen
  // step entirely — no HTTP server is started in this process.
  //
  // The user's --port is always forwarded so the lock can detect
  // cross-project port collisions; --strict-port only controls the
  // listen-phase behavior (fail on EADDRINUSE vs. fall back to OS port).
  const portExplicitlySet = typeof flags['port'] === 'string';
  const acquireResult = await acquireOrJoin({
    projectDir,
    host,
    requestedPort: portExplicitlySet ? portRaw : null,
    strictPort,
  });

  if (acquireResult.kind === 'joined') {
    const lock = acquireResult.lock;
    // Another live instance owns this project. Print its URL + token
    // so a shell pipeline can capture them with
    // `$(wstack mailbox serve)`. Exit 0 because the system as a whole
    // is in a valid state — the user's request ("mailbox serve") is
    // effectively satisfied.
    deps.renderer.write(
      `Mailbox bridge already running (PID ${lock.pid}).\n` +
        `  URL:        ${lock.url}\n` +
        `  Token file: ${acquireResult.tokenPath}\n` +
        `  Lock:       ${projectDir}${process.platform === 'win32' ? '\\' : '/'}.mailbox-bridge.lock\n\n`,
    );
    return 0;
  }

  if (acquireResult.kind === 'port-conflict') {
    // Caller asked for an explicit port; another process on a
    // DIFFERENT project dir owns that port. We can't join them
    // (cross-project is forbidden — tokens and locks are per-project).
    // Loud-fail with the existing owner's URL so the caller can
    // either pick a different port or reuse that other bridge.
    const existing = acquireResult.existing;
    deps.renderer.writeError(
      `Port ${portRaw} already in use by another mailbox bridge on a different project.\n` +
        `  Owner project: ${projectDir} (us)\n` +
        `  Owner URL:     ${existing.url}\n` +
        `  Owner PID:     ${existing.pid}\n\n` +
        `Either pick a different --port, run without --strict-port (OS will assign a free one),\n` +
        `or stop the conflicting process and retry.\n`,
    );
    // No tentative lock was written in this branch — acquireOrJoin
    // returns port-conflict before the write step. Nothing to
    // release.
    return 1;
  }

  // acquireResult.kind === 'acquired' — we own the slot. Now bind
  // the HTTP server.
  const tentative = acquireResult.lock;
  const eventEmitter = new MailboxEventEmitter();
  let hqConnection: CliHqConnection | undefined;
  const mailbox = createProjectMailbox({
    projectDir,
    hqPublisher: () => hqConnection?.getPublisher(),
    eventEmitter,
  });

  // Authentication and protocol handling are shared with HQ; this host keeps
  // ownership of the standalone bridge token, rate-limiter lifecycle, and
  // single-instance lock.
  const rateLimiter = new MailboxHttpRateLimiter();
  const rateLimitCleanup = setInterval(() => rateLimiter.cleanup(), 120_000);
  rateLimitCleanup.unref?.();
  const projectId = path.basename(projectDir);
  const credentialStore: MailboxCredentialVerifier = {
    load: async () => mailbox.initialize(),
    verify: (credentialId, secret) => mailbox.credentialVerify(credentialId, secret),
    verifyPersisted: (credentialId, secret) => mailbox.credentialVerify(credentialId, secret),
  };
  // Identity credentials must be ready before the socket starts accepting
  // requests. `verify()` intentionally fails closed while the store is
  // unloaded, so a fire-and-forget load creates a startup race for every
  // external agent reconnecting as the bridge comes online.
  try {
    await credentialStore.load();
  } catch (error) {
    clearInterval(rateLimitCleanup);
    await mailbox.close().catch(() => undefined);
    await release(projectDir, tentative.generation);
    deps.renderer.writeError(
      `Failed to load mailbox credentials: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  const router = createMailboxHttpRouter({
    mailbox,
    eventEmitter,
    rateLimiter,
    credentialStore,
    projectId,
    authorize: (request) => {
      if (/^Credential\s+/i.test(request.headers.authorization ?? '')) {
        // The shared router performs the authoritative async verification
        // against the project owner and injects the credential actor.
        return { allowed: true };
      }
      return authorizeMailboxBearerToken(request, tentative.token);
    },
    // Wire the 1h look-back that the router's docs promise at
    // mailbox-http-router.ts:25-32 / :47-62. The router itself is
    // opt-in (L146-152): without this option, every retained
    // message would be returned.
    //
    // Per-request override contract (mailbox-http-router.ts:64-80):
    //   - `?sinceMs=0`         → no filter (full retained history)
    //   - `?sinceMs > 7d`      → silently clamped to
    //                            MAILBOX_HTTP_MAX_AGE_CEILING_MS (7d)
    //   - `?sinceMs=-1/NaN/∞`  → disable sentinel (same as `undefined`)
    defaultMaxAgeMs: MAILBOX_HTTP_DEFAULT_MAX_AGE_MS,
  });

  const server = createServer((request, response) => {
    void router.handle(request, response);
  });

  // Listen semantics:
  //  - An explicit --port is always honored. If the port is in use:
  //    - strictPort: reject with EADDRINUSE so the operator knows.
  //    - !strictPort: fall back to OS-assigned (pass 0).
  //  - No explicit --port: ask the OS for a free port (pass 0).
  let boundPort = -1;
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      const listenPort = portExplicitlySet ? portRaw : 0;
      server.listen(listenPort, host);
    });
    const addr = server.address();
    boundPort = typeof addr === 'object' && addr !== null ? addr.port : portRaw;
  } catch (err) {
    // Listen failed.
    const msg = (err as Error).message;

    // Non-strict mode with an explicit port: fall back to OS-assigned.
    if (portExplicitlySet && !strictPort) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (e: Error) => {
            server.off('listening', onListening);
            reject(e);
          };
          const onListening = () => {
            server.off('error', onError);
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(0, host);
        });
        const addr = server.address();
        boundPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
        deps.renderer.writeWarning(
          `Port ${portRaw} was in use; bound to OS-assigned port ${boundPort} instead.\n`,
        );
      } catch {
        // Both the explicit port and the fallback failed — give up.
        clearInterval(rateLimitCleanup);
        await release(projectDir, tentative.generation);
        deps.renderer.writeError(
          `Failed to bind ${host}: ${msg}\n` +
            `This usually means no port is available (extremely rare). Retry or pick an explicit --port.\n`,
        );
        return 1;
      }
    } else {
      // strictPort or no explicit port — the failure is fatal.
      clearInterval(rateLimitCleanup);
      await release(projectDir, tentative.generation);
      if (strictPort) {
        deps.renderer.writeError(
          `Failed to bind ${host}:${portRaw}: ${msg}\n` +
            `Either pick a different --port, drop --strict-port to allow OS fallback, or stop the process holding this port.\n`,
        );
      } else {
        deps.renderer.writeError(
          `Failed to bind ${host} on an OS-assigned port: ${msg}\n` +
            `This usually means no port is available (extremely rare). Retry or pick an explicit --port.\n`,
        );
      }
      return 1;
    }
  }

  // Phase 2 — finalize: write the lock + token with the actual
  // bound port and the same token, atomically.
  const finalized = await finalize(projectDir, tentative, boundPort);
  hqConnection = startCliHqConnection({
    clientKind: 'mailbox',
    // Mailbox telemetry is best-effort; keep a disconnected bridge from
    // retaining thousands of snapshots/events in the CLI process.
    maxQueuedMessages: 250,
    projectRoot: deps.projectRoot,
    projectName: path.basename(deps.projectRoot),
    appConfig: deps.config,
    capabilities: ['telemetry.publish', 'mailbox.summary', 'mailbox.serve'],
    onConnect: (publisher) => {
      // Announce the bridge immediately; subsequent HTTP mutations publish
      // mailbox events/snapshots through the mailbox getter above.
      void publisher
        .publishMailboxSnapshot(mailbox, { mailboxId: `${path.basename(projectDir)}:mailbox` })
        .catch(() => undefined);
    },
  });
  writeStartupInfo(deps, {
    host,
    port: boundPort,
    projectDir,
    projectId,
    tokenPath: acquireResult.tokenPath,
  });
  const stopMemoryWatchdog = startSharedHeapWatchdog({
    collectStats: () => {
      const hqQueue = hqConnection?.getPublisher()?.getQueueStats();
      const hqSnapshot = mailbox.getHqSnapshotStats();
      const kanbanSync = hqConnection?.getKanbanSyncStats();
      return {
        surface: 'mailbox-http-server',
        projectId,
        boundPort,
        ...(hqQueue
          ? {
              hqQueueEntries: hqQueue.entries,
              hqQueueBytes: hqQueue.bytes,
              hqQueueMaxBytes: hqQueue.maxBytes,
              hqQueueDroppedFrames: hqQueue.droppedFrames,
              hqQueueDroppedBytes: hqQueue.droppedBytes,
              hqQueueCoalescedFrames: hqQueue.coalescedFrames,
              hqQueueCoalescedBytes: hqQueue.coalescedBytes,
            }
          : {}),
        hqSnapshotInFlight: hqSnapshot.inFlight ? 1 : 0,
        hqSnapshotPending: hqSnapshot.pending ? 1 : 0,
        hqSnapshotTimerScheduled: hqSnapshot.timerScheduled ? 1 : 0,
        hqEventInFlight: hqSnapshot.eventInFlight ? 1 : 0,
        hqEventPending: hqSnapshot.pendingEvents,
        hqEventCoalesced: hqSnapshot.coalescedEvents,
        hqEventDropped: hqSnapshot.droppedEvents,
        kanbanSyncActive: kanbanSync?.localPublishActive ? 1 : 0,
        kanbanSyncPendingBoards: kanbanSync?.pendingBoardIds ?? 0,
        kanbanSyncFullRescanPending: kanbanSync?.fullRescanPending ? 1 : 0,
        kanbanSyncRemoteApplyQueued: kanbanSync?.remoteApplyQueued ? 1 : 0,
        kanbanSyncPendingRemoteBoards: kanbanSync?.pendingRemoteBoards ?? 0,
        kanbanSyncPublishRuns: kanbanSync?.localPublishRuns ?? 0,
        kanbanSyncCoalescedRefreshes: kanbanSync?.coalescedLocalRefreshes ?? 0,
      };
    },
  });

  // Keep the process alive until SIGINT/SIGTERM. We resolve once the
  // server has fully closed and the lock + token files are gone.
  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = async (sig: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(rateLimitCleanup);
      hqConnection?.stop();
      console.log(
        JSON.stringify({ event: 'mailbox_serve_stopping', signal: sig, host, port: boundPort }),
      );
      // Close long-lived SSE responses before waiting for server.close().
      router.close();
      // Stop accepting new connections; in-flight requests get to finish.
      await new Promise<void>((closeResolve) => server.close(() => closeResolve()));
      await mailbox.close().catch((err) => {
        deps.renderer.writeWarning(`mailbox close error: ${(err as Error).message}\n`);
      });
      // Best-effort release. If we lost the lock race to another
      // acquire, release() will detect the generation mismatch and
      // leave their lock alone.
      await release(projectDir, finalized.generation);
      await stopMemoryWatchdog();
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}

// ── Startup info / help ───────────────────────────────────────────────────

interface StartupInfo {
  host: string;
  port: number;
  projectDir: string;
  /**
   * The scope id credentials are checked against — `path.basename(projectDir)`,
   * NOT the directory itself. Surfaced because it is otherwise invisible: an
   * operator who copies the printed `projectDir` into a credential gets a 403
   * ("credential is scoped to a different project") at every request, since
   * mailbox-http-router compares this value byte-for-byte.
   */
  projectId: string;
  tokenPath: string;
}

function writeStartupInfo(deps: SubcommandDeps, info: StartupInfo): void {
  // One structured JSON line to stdout for log-shippers, followed by a
  // human-readable mirror.
  //
  // Both currently land on stdout: `renderer.write()` writes to `this.out`
  // (renderer.ts:45, `opts.out ?? process.stdout`). Only writeWarning/
  // writeError/writeInfo use `this.err` (renderer.ts:46) — and each of those
  // prefixes a glyph, so none is a drop-in unadorned stderr channel.
  //
  // Consequence: `wstack mailbox serve | jq` sees the banner interleaved with
  // the JSON line. Splitting them needs a plain stderr method on the renderer
  // (or a direct process.stderr.write, which would bypass the TUI-silence
  // handling in renderer.suppressStdout) — a renderer API change, not a local
  // edit here.
  console.log(
    JSON.stringify({
      event: 'mailbox_serve_started',
      host: info.host,
      port: info.port,
      projectDir: info.projectDir,
      projectId: info.projectId,
      tokenFile: info.tokenPath,
    }),
  );
  deps.renderer.write(`WrongStack mailbox bridge listening on http://${info.host}:${info.port}\n`);
  deps.renderer.write(`Project dir:  ${info.projectDir}\n`);
  deps.renderer.write(
    `Project id:   ${info.projectId}  (use this as projectId when issuing credentials)\n`,
  );
  deps.renderer.write(`Token file:   ${info.tokenPath} (mode 0600)\n`);
  deps.renderer.write('\n');
  deps.renderer.write('Routes:\n');
  deps.renderer.write('  POST /mailbox/send              send a message\n');
  deps.renderer.write('  POST /mailbox/query             query messages\n');
  deps.renderer.write(
    '  POST /mailbox/check             check inbox and optionally mark read/completed\n',
  );
  deps.renderer.write('  POST /mailbox/ack               acknowledge one message\n');
  deps.renderer.write('  POST /mailbox/ack-many          acknowledge many in one batch\n');
  deps.renderer.write('  POST /mailbox/unread-count      count unread messages for an agent\n');
  deps.renderer.write('  POST /mailbox/agents/register   register an external agent\n');
  deps.renderer.write('  POST /mailbox/agents/heartbeat  update agent heartbeat\n');
  deps.renderer.write('  POST /mailbox/register-client   register an external client\n');
  deps.renderer.write('  POST /mailbox/heartbeat         update client heartbeat\n');
  deps.renderer.write('  GET  /mailbox/agents            list all registered agents\n');
  deps.renderer.write('  GET  /mailbox/agents/online     list agents with a live heartbeat\n');
  deps.renderer.write('  GET  /mailbox/events            SSE stream — real-time mailbox push\n');
  deps.renderer.write('  GET  /healthz                   health probe (no auth)\n');
  deps.renderer.write('\n');
  deps.renderer.write('Send the bearer token in: Authorization: Bearer <token>\n');
  deps.renderer.write('Cat the token from another shell:\n');
  deps.renderer.write(`  cat ${info.tokenPath}\n`);
  deps.renderer.write('\nPress Ctrl+C to stop.\n');
}

function printHelp(deps: SubcommandDeps): void {
  deps.renderer.write(`Usage: wstack mailbox <serve>\n`);
  deps.renderer.write('\n');
  deps.renderer.write(`  wstack mailbox serve           Start the loopback HTTP bridge.\n`);
  deps.renderer.write('\n');
  deps.renderer.write('Flags:\n');
  deps.renderer.write(
    `  --host <ip>         Bind host (default ${DEFAULT_HOST}). Exposing beyond\n`,
  );
  deps.renderer.write('                     loopback requires network-layer protection.\n');
  deps.renderer.write(`  --port <n>          Bind port (default ${DEFAULT_PORT}).\n`);
  deps.renderer.write('  --strict-port       Fail if the requested port is already in use.\n');
}
