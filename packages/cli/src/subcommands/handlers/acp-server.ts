/**
 * `wstack acp` server mode: WrongStack as an ACP agent over stdio JSON-RPC or,
 * with `--ws[=port]`, over a loopback WebSocket.
 */

import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import {
  ACPProtocolHandler,
  ACPSessionStore,
  makeACPServerAgentTurn,
  type RunTurn,
  WrongStackACPServer,
  WsBridgeTransport,
} from '@wrongstack/acp/agent';
import { leaderDeliveryHub } from '@wrongstack/core/coordination';
import { type AcpHqTelemetry, startAcpHqTelemetry } from '../../acp-hq-telemetry.js';
import {
  type AcpServerAgentFactory,
  AcpServerConfigError,
  buildAcpServerAgentFactory,
} from '../../acp-server-agent.js';
import { createGracefulShutdown } from '../../shutdown-cleanup.js';
import { WebSocketServer } from '../../ws-runtime.js';
import type { SubcommandDeps } from '../contracts.js';
import { createAcpConnectionGate } from './acp-connection-gate.js';

/**
 * Live count of background `delegate` results queued for an ACP session's
 * leader. The turn adapter announces a finished delegation to an idle client
 * only while its result is still undelivered.
 */
function pendingLeaderDeliveries(sessionId: string): number {
  return leaderDeliveryHub.pending(sessionId);
}

/** Parse the `--ws[=port]` flag into a port number, or null if not set. */
function parseWsPort(flag: unknown): number | null {
  if (flag === undefined || flag === false) return null;
  if (flag === true || flag === 'true') return 8889;
  const n = Number(flag);
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : 8889;
}

/**
 * Chain the turn adapter's per-session teardown with the agent factory's.
 *
 * `turn.dispose` drops the session's Agent; `factory.disposeSession` stops the
 * MCP servers the ACP client supplied for it. Both must run on
 * `session/close`, and neither may throw into the protocol handler.
 */
function composeDispose(
  disposeTurn: (sessionId: string) => void,
  factory: AcpServerAgentFactory | undefined,
): (sessionId: string) => void {
  return (sessionId: string): void => {
    try {
      disposeTurn(sessionId);
    } finally {
      factory?.disposeSession(sessionId);
    }
  };
}

/**
 * Serve WrongStack as an ACP agent over WebSocket. Unlike the HTTP transport
 * (one POST per message, notifications buffered), a WebSocket is full-duplex:
 * the agent streams `session/update` and makes `session/request_permission`
 * callbacks live during a turn. One handler + transport per connection.
 */
async function runACPWebSocketServer(deps: SubcommandDeps, port: number): Promise<number> {
  const host = '127.0.0.1';
  // `--echo` over WS: a no-provider connectivity test, mirroring stdio `--echo`.
  const echo = deps.flags?.echo === true || deps.flags?.echo === 'true';

  let turnFactory: (() => ReturnType<typeof makeACPServerAgentTurn>) | undefined;
  // Kept alongside the turn factory so `session/close` can stop the MCP
  // servers the client supplied — the turn adapter's `dispose` only drops the
  // Agent, and a dropped Agent leaves its stdio servers running.
  let wsAgentFactory: AcpServerAgentFactory | undefined;
  let echoTurn: RunTurn | undefined;
  let store: ACPSessionStore | undefined;
  let hqTelemetry: AcpHqTelemetry | undefined;
  if (echo) {
    echoTurn = async () => ({ stopReason: 'end_turn' });
  } else {
    let agentFor;
    try {
      agentFor = buildAcpServerAgentFactory(deps);
    } catch (err) {
      if (err instanceof AcpServerConfigError) {
        deps.renderer.writeError(`${err.message}\n`);
        return 1;
      }
      throw err;
    }
    // An editor driving WrongStack over ACP runs real turns; HQ never saw
    // any of them. One publisher for the process, one session node per ACP
    // session.
    hqTelemetry = startAcpHqTelemetry({
      projectRoot: deps.cwd ?? process.cwd(),
      projectName: path.basename(deps.cwd ?? process.cwd()),
      appConfig: deps.config,
    });
    const tracked = hqTelemetry.wrapAgentFactory(agentFor);
    wsAgentFactory = agentFor;
    turnFactory = () =>
      makeACPServerAgentTurn({ agentFor: tracked, pendingDeliveries: pendingLeaderDeliveries });
    store = deps.paths?.projectDir
      ? new ACPSessionStore({ dir: path.join(deps.paths.projectDir, 'acp-sessions') })
      : undefined;
  }

  // WS-006: the WS transport admitted anything — the Origin check was
  // `if (origin && …)`, so every non-browser client skipped it, and
  // `handleAuthenticate` returns success unconditionally. A token is minted per
  // run and required on connect; it is printed with the URL, and
  // `WRONGSTACK_ACP_TOKEN` lets a supervisor pin it. The admission logic lives
  // in acp-connection-gate.ts so it is directly testable.
  const acpToken = process.env['WRONGSTACK_ACP_TOKEN']?.trim() || randomBytes(32).toString('hex');
  const gate = createAcpConnectionGate({ host, port, token: acpToken });
  let liveConnections = 0;

  // The gate runs at `verifyClient`, not on `connection`.
  //
  // It used to run on `connection`, which is after `ws` has already answered
  // `101 Switching Protocols`, allocated a WebSocket with the 20 MiB
  // `maxPayload` budget below, and spent a file descriptor. A WebSocket
  // handshake is exempt from the same-origin policy, so any page the user
  // happens to have open could run `for(;;) new WebSocket('ws://127.0.0.1:<acpPort>')`
  // and make the agent host pay that allocation on every attempt before being
  // closed with 1008. The gate itself was never the problem — cross-origin,
  // bad-Host and bad-token connections were all correctly refused — it was
  // refusing them too late.
  //
  // `maxConnections` had the same shape: evaluated after allocation, it capped
  // concurrent ADMITTED sessions rather than concurrent allocations. Checking
  // here fixes both, because `gate.check` only ever needed `headers` and
  // `url`, which `verifyClient` provides.
  //
  // The CLI WebUI host made exactly this move under DOS-004
  // (`cli/src/webui-server.ts`); this is the same fix on the ACP surface.
  //
  // One honest trade: `liveConnections` is still incremented on `connection`,
  // so the cap is now read slightly before the socket it will admit is
  // counted, and concurrent handshakes can overshoot it by a small margin.
  // That race is inherent to checking before allocation — a counter
  // incremented at admission instead would leak whenever a verified socket
  // never reaches `connection`. The cap is a resource ceiling, not the
  // security boundary (the per-run token is), and overshooting it by a few is
  // strictly better than allocating for every rejected attempt.
  const verifyClient = (
    info: { origin: string; secure: boolean; req: import('node:http').IncomingMessage },
    cb: (ok: boolean, code?: number, message?: string) => void,
  ): void => {
    const verdict = gate.check(info.req, liveConnections);
    if (verdict.ok) {
      cb(true);
      return;
    }
    // Refusing during the handshake means an HTTP status, not a close frame.
    // 1008 (policy violation) is a WebSocket close code and has no meaning
    // here, so map to 403 and keep the gate's own reason as the status text.
    cb(false, 403, verdict.reason ?? 'forbidden');
  };

  const wss = new WebSocketServer({ host, port, maxPayload: 20 * 1024 * 1024, verifyClient });
  wss.on('connection', (socket) => {
    liveConnections++;
    socket.once('close', () => {
      liveConnections--;
    });
    const connectionTurn = turnFactory?.();
    const transport = new WsBridgeTransport((m) => {
      const data = JSON.stringify(m);
      if (socket.bufferedAmount + Buffer.byteLength(data, 'utf8') > 32 * 1024 * 1024) {
        socket.terminate();
        return;
      }
      socket.send(data);
    });
    const handler = new ACPProtocolHandler({
      transport,
      defaultCwd: deps.cwd ?? process.cwd(),
      runTurn: connectionTurn ?? echoTurn!,
      ...(connectionTurn
        ? {
            replayFor: connectionTurn.replay,
            seedFor: connectionTurn.seed,
            disposeFor: composeDispose(
              hqTelemetry?.wrapDispose(connectionTurn.dispose) ?? connectionTurn.dispose,
              wsAgentFactory,
            ),
          }
        : {}),
      ...(store ? { store } : {}),
    });
    socket.on('message', (data: { toString(): string }) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      transport.receive(msg as never);
      // One rejecting frame (unknown method, bad `cwd`, EACCES on a store
      // write) used to become an unhandled rejection and, under Node 22's
      // `--unhandled-rejections=throw`, take down the whole ACP server —
      // along with every OTHER editor session connected to it.
      void handler.handleMessage(msg).catch((err: unknown) => {
        deps.renderer.writeWarning(
          `ACP: failed to handle message: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
    });
    const teardown = (): void => {
      handler.close();
      transport.close();
    };
    socket.on('close', teardown);
    socket.on('error', teardown);
  });

  const acpUrl = `ws://${host}:${port}/?token=${acpToken}`;
  deps.renderer.writeInfo(
    echo
      ? `ACP server (echo, no provider) listening on ${acpUrl}. Press Ctrl+C to stop.\n`
      : `WrongStack ACP server listening on ${acpUrl} (${deps.config.provider}/${deps.config.model}). Press Ctrl+C to stop.\n`,
  );

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      deps.renderer.writeWarning('\nShutting down ACP WebSocket server...');
      // Destroy THEN close. `wss.close()` only stops accepting new
      // connections; an editor still attached keeps its socket — and the
      // event loop — alive, so Ctrl+C printed this message, returned 0, and
      // the process hung until SIGKILL.
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          // Already gone.
        }
      }
      wss.close();
      hqTelemetry?.stop();
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}

export async function runACPServer(deps: SubcommandDeps): Promise<number> {
  const wsPort = parseWsPort(deps.flags?.ws);
  if (wsPort !== null) {
    return runACPWebSocketServer(deps, wsPort);
  }
  // `--echo` keeps the no-op connectivity-smoke-test path that the default
  // runTurn provided before this server was wired to a real Agent. Useful for
  // `wstack acp --echo` when you just want to verify the wire format against a
  // client without needing a configured provider.
  const echo = deps.flags?.echo === true || deps.flags?.echo === 'true';

  // Declared outside the IIFE so the shutdown path below can stop it.
  if (!echo && (!deps.config.provider || !deps.config.model)) {
    deps.renderer.writeError(
      'No model provider configured. Run `wstack auth` before starting ACP, or use `--echo` for a connectivity test.\n',
    );
    return 1;
  }
  let stdioHqTelemetry: AcpHqTelemetry | undefined;
  const server = new WrongStackACPServer(
    echo
      ? {}
      : (() => {
          let agentFor;
          try {
            agentFor = buildAcpServerAgentFactory(deps);
          } catch (err) {
            if (err instanceof AcpServerConfigError) {
              deps.renderer.writeError(`${err.message}\n`);
            }
            throw err;
          }
          stdioHqTelemetry = startAcpHqTelemetry({
            projectRoot: deps.cwd ?? process.cwd(),
            projectName: path.basename(deps.cwd ?? process.cwd()),
            appConfig: deps.config,
          });
          const stdioAgentFactory = agentFor;
          const turn = makeACPServerAgentTurn({
            agentFor: stdioHqTelemetry.wrapAgentFactory(agentFor),
            pendingDeliveries: pendingLeaderDeliveries,
          });
          // Persist sessions under the project's wstack dir so `session/load`
          // survives a server restart (project-scoped, not in the repo).
          const store = deps.paths?.projectDir
            ? new ACPSessionStore({ dir: path.join(deps.paths.projectDir, 'acp-sessions') })
            : undefined;
          return {
            runTurn: turn,
            replayFor: turn.replay,
            seedFor: turn.seed,
            disposeFor: composeDispose(
              stdioHqTelemetry!.wrapDispose(turn.dispose),
              stdioAgentFactory,
            ),
            ...(store ? { store } : {}),
          };
        })(),
  );

  if (echo) {
    deps.renderer.writeInfo(
      'ACP server starting in --echo mode (no-op turn; no provider needed).\n',
    );
  } else {
    deps.renderer.writeInfo(
      `Starting WrongStack ACP server (${deps.config.provider}/${deps.config.model})…\n`,
    );
    deps.renderer.writeInfo(
      'Waiting for an ACP client connection on stdin/stdout. Press Ctrl+C to stop.\n',
    );
  }

  // Graceful shutdown. The old code did `server.stop(); process.exit(0)`
  // back-to-back, which cut off `server.stop()`'s async teardown. `stop()`
  // now resolves once the HTTP handle is closed, so awaiting it is the
  // whole guarantee. Same pattern as cli-main.ts: idempotent guard, await
  // cleanup, set exitCode, give Node a 500ms grace to drain, then force exit.
  createGracefulShutdown({
    run: async () => {
      try {
        await server.stop();
      } catch (err) {
        deps.renderer.writeError(
          `ACP stop failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      // Publishes `session.ended` for every live ACP session, so the fleet
      // map loses the nodes on shutdown instead of ageing them out.
      stdioHqTelemetry?.stop();
    },
  }).install();

  try {
    await server.start();
  } catch (err) {
    deps.renderer.writeError(
      `ACP server error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  return 0;
}
