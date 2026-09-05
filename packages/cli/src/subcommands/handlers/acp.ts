/**
 * ACP CLI integration.
 *
 * `wstack acp`                  — start WrongStack as an ACP server (blocks)
 * `wstack acp list`             — list ACP agents installed on $PATH
 * `wstack acp spawn <id> <task>`      — run a task on one named ACP agent
 * `wstack acp parallel <csv> <task>`  — fan a task out to multiple agents
 *
 * DIR-2: `wstack acp` runs WrongStack as a standard-compliant ACP agent.
 * ACP clients (Zed, JetBrains, VS Code ACP extension) spawn it as a subprocess.
 * This is the correct CLI entry point to test DIR-2 against a real ACP client.
 */

import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import {
  type ACPProgressEvent,
  type AcpAgentCommandOverrides,
  defaultPermissionPolicy,
  EnsembleRegistry,
  probeAcpAgents,
  renderAcpBenchText,
  resolveAcpAgentCommand,
  runAcpBench,
  runEnsemble,
  runOneAcpTask,
} from '@wrongstack/acp';
import {
  ACPProtocolHandler,
  ACPSessionStore,
  makeACPServerAgentTurn,
  type RunTurn,
  WrongStackACPServer,
  WsBridgeTransport,
} from '@wrongstack/acp/agent';
import { WebSocketServer } from 'ws';
import { type AcpHqTelemetry, startAcpHqTelemetry } from '../../acp-hq-telemetry.js';
import {
  type LoadedAcpRegistry,
  loadCachedAcpRegistry,
  refreshAcpRegistry,
} from '../../acp-registry-cache.js';
import { AcpServerConfigError, buildAcpServerAgentFactory } from '../../acp-server-agent.js';
import { createGracefulShutdown } from '../../shutdown-cleanup.js';
import type { SubcommandDeps, SubcommandHandler } from '../contracts.js';
import { createAcpConnectionGate } from './acp-connection-gate.js';

/** User-config ACP command overrides (never sourced from in-project config). */
function acpOverrides(deps: SubcommandDeps): AcpAgentCommandOverrides | undefined {
  return deps.config.acp?.agents;
}

/** Load the synced registry cache, or null if never synced / unavailable. */
async function loadLive(deps: SubcommandDeps): Promise<LoadedAcpRegistry | null> {
  return deps.paths ? loadCachedAcpRegistry(deps.paths) : null;
}

export const acpCmd: SubcommandHandler = async (args, deps) => {
  const sub = args[0];

  if (!sub || sub === 'server' || sub === 'serve') {
    return runACPServer(deps);
  }

  if (sub === 'help') {
    deps.renderer.write(`\
wstack acp — ACP (Agent Client Protocol) integration

Usage:
  wstack acp              Start WrongStack as an ACP server (blocks)
  wstack acp server       Same as above
  wstack acp list         List available ACP agents
  wstack acp sync         Pull the official agentclientprotocol/registry into cache
  wstack acp spawn <id> <task>
                        Spawn an ACP agent as a subagent and wait for result
  wstack acp parallel <agent-id-csv> <task>
                        Fan a task out to multiple ACP agents in parallel
                        and aggregate the results
  wstack acp probe [agent-id-csv]
                        Handshake-test agents (bounded concurrency). Defaults
                        to all installed agents.
  wstack acp bench [agent-id-csv] [--fs]
                        End-to-end verify each agent (handshake → prompt →
                        marker, optional fs check) and print a graded report.
                        Defaults to all installed agents.
  wstack acp help         Show this help

ACP Mode:
  When run as \`wstack acp\`. WrongStack acts as an ACP-compatible agent driven
  by your configured model provider. ACP clients (Zed, JetBrains, VS Code)
  spawn it as a subprocess and communicate over stdio JSON-RPC. Run
  \`wstack auth\` first to configure a provider, or pass \`--echo\` for a no-op
  connectivity test that needs no provider. Press Ctrl+C to stop.

  Transports:
    (default)        stdio JSON-RPC (the usual editor-spawned-subprocess mode)
    --ws[=port]      serve over WebSocket on 127.0.0.1:<port> (default 8889) —
                     full-duplex, so updates/permission prompts stream live.

spawn:
  Spawns a named ACP agent (claude-code, gemini-cli, codex-cli, copilot,
  cline, goose, openhands, qwen-code, kiro-cli, opencode, mistral-vibe,
  cursor) with the given task and waits for its result.
  Example: wstack acp spawn cline "fix the login bug"

parallel:
  Runs the same task on a comma-separated list of ACP agents concurrently.
  Example: wstack acp parallel claude-code,gemini-cli,codex-cli "review this diff"
  Each agent's result is rendered under a clearly-marked header. Returns 0
  if at least one agent succeeds, 1 if all fail. Agents that aren't
  installed are skipped with a warning.
`);
    return 0;
  }

  if (sub === 'list') {
    return listACPAgents(deps);
  }

  if (sub === 'sync') {
    return syncACPRegistry(deps);
  }

  if (sub === 'spawn') {
    return spawnACPAgent(args.slice(1), deps);
  }

  if (sub === 'parallel') {
    return parallelACPAgents(args.slice(1), deps);
  }

  if (sub === 'probe') {
    return probeACPAgents(args.slice(1), deps);
  }

  if (sub === 'bench') {
    return benchACPAgents(args.slice(1), deps);
  }

  deps.renderer.writeError(`Unknown acp subcommand: ${sub}\n`);
  deps.renderer.write('Run `wstack acp help` for usage.\n');
  return 1;
};

/** Parse the `--ws[=port]` flag into a port number, or null if not set. */
function parseWsPort(flag: unknown): number | null {
  if (flag === undefined || flag === false) return null;
  if (flag === true || flag === 'true') return 8889;
  const n = Number(flag);
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : 8889;
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
    turnFactory = () => makeACPServerAgentTurn({ agentFor: tracked });
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

  const wss = new WebSocketServer({ host, port, maxPayload: 20 * 1024 * 1024 });
  wss.on('connection', (socket, req) => {
    const verdict = gate.check(req, liveConnections);
    if (!verdict.ok) {
      socket.close(verdict.code ?? 1008, verdict.reason ?? 'forbidden');
      return;
    }
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
            disposeFor: hqTelemetry?.wrapDispose(connectionTurn.dispose) ?? connectionTurn.dispose,
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

async function runACPServer(deps: SubcommandDeps): Promise<number> {
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
              return {};
            }
            throw err;
          }
          stdioHqTelemetry = startAcpHqTelemetry({
            projectRoot: deps.cwd ?? process.cwd(),
            projectName: path.basename(deps.cwd ?? process.cwd()),
            appConfig: deps.config,
          });
          const turn = makeACPServerAgentTurn({
            agentFor: stdioHqTelemetry.wrapAgentFactory(agentFor),
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
            disposeFor: stdioHqTelemetry!.wrapDispose(turn.dispose),
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
  // back-to-back, which cut off `server.stop()`'s async teardown (it
  // initiates cleanup of underlying agents and the session store, but
  // returns void rather than a promise — yet Node still has pending
  // microtasks scheduled that `process.exit` would abandon). Use the
  // same pattern as cli-main.ts: idempotent guard, await any cleanup,
  // set exitCode, give Node a 500ms grace to drain, then force exit.
  createGracefulShutdown({
    run: async () => {
      try {
        server.stop();
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

async function listACPAgents(deps: SubcommandDeps): Promise<number> {
  const registry = new EnsembleRegistry();
  const detected = await registry.list();
  deps.renderer.write('Detected ACP agents:\n\n');
  // Print installed first, then not-installed with a "not installed" note.
  const installed = detected.filter((a) => a.installed);
  const missing = detected.filter((a) => !a.installed);
  for (const a of installed) {
    const ver = a.version ? `  (${a.version.split('\n')[0]})` : '';
    deps.renderer.write(`  ✓ ${a.id.padEnd(16)} ${a.displayName}${ver}\n`);
  }
  for (const a of missing) {
    deps.renderer.write(
      `  ✗ ${a.id.padEnd(16)} ${a.displayName}  (${a.reason ?? 'not installed'})\n`,
    );
  }
  deps.renderer.write(`\n${installed.length} of ${detected.length} agents available.\n`);
  const live = await loadLive(deps);
  if (live && live.agents.length > 0) {
    deps.renderer.write(
      `Synced registry: ${live.agents.length} agents available (run \`wstack acp spawn <id> <task>\`).\n`,
    );
  } else {
    deps.renderer.write('Run `wstack acp sync` to pull the full official registry (37+ agents).\n');
  }
  deps.renderer.write('Use `wstack acp spawn <agent-id> <task>` to delegate a task.\n');
  return 0;
}

async function syncACPRegistry(deps: SubcommandDeps): Promise<number> {
  if (!deps.paths) {
    deps.renderer.writeError('Cannot sync: no cache directory available.\n');
    return 1;
  }
  deps.renderer.writeInfo('Fetching the official ACP registry…\n');
  try {
    const { count, location } = await refreshAcpRegistry(deps.paths);
    deps.renderer.write(`Synced ${count} agents from the official ACP registry.\n`);
    deps.renderer.writeInfo(`Cached at ${location}\n`);
    return 0;
  } catch (err) {
    deps.renderer.writeError(
      `ACP registry sync failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    deps.renderer.write('The bundled offline catalog is still available via `wstack acp list`.\n');
    return 1;
  }
}

async function spawnACPAgent(args: string[], deps: SubcommandDeps): Promise<number> {
  const [subagentId, ...taskParts] = args;
  if (!subagentId) {
    deps.renderer.writeError('Usage: wstack acp spawn <agent-id> <task>\n');
    deps.renderer.write('Run `wstack acp list` to see available agents.\n');
    return 1;
  }

  const task = taskParts.join(' ');
  if (!task) {
    deps.renderer.writeError('Usage: wstack acp spawn <agent-id> <task>\n');
    deps.renderer.write('Task description is required.\n');
    return 1;
  }

  const live = await loadLive(deps);
  const cmd = resolveAcpAgentCommand(subagentId, acpOverrides(deps), live?.byId);
  if (!cmd) {
    deps.renderer.writeError(`Unknown ACP agent: ${subagentId}\n`);
    deps.renderer.write('Run `wstack acp list` (or `wstack acp sync`) to see available agents.\n');
    return 1;
  }

  deps.renderer.writeInfo(`Spawning ACP agent '${subagentId}'…\n`);

  // Wire Ctrl+C to an AbortSignal so a long-running external agent is
  // cancelled (runOneAcpTask tears the child down on signal + in its finally).
  const ac = new AbortController();
  const cleanup = () => ac.abort();
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    deps.renderer.writeInfo('Running task…\n');
    const result = await runOneAcpTask({
      command: cmd.command,
      ...(cmd.args !== undefined ? { args: cmd.args } : {}),
      ...(cmd.env !== undefined ? { env: cmd.env } : {}),
      role: subagentId,
      task,
      signal: ac.signal,
      permissionPolicy: defaultPermissionPolicy,
      onProgress: (event) => {
        const line = formatProgress(event);
        if (line) deps.renderer.writeInfo(`  ${line}\n`);
      },
    });

    deps.renderer.write('\n--- Result ---\n');
    deps.renderer.write(result.result.length > 0 ? result.result : 'no result');
    deps.renderer.write('\n---------------\n');
    deps.renderer.writeInfo(
      `Done. iterations=${result.iterations} toolCalls=${result.toolCalls}\n`,
    );
    return 0;
  } catch (err) {
    // runOneAcpTask throws structured SubagentError shapes; surface the
    // `kind` for clarity (e.g. aborted_by_parent, bridge_failed).
    const e = err as { kind?: string; message?: string };
    const detail = e.kind ? `[${e.kind}] ` : '';
    const message = e.message ?? (err instanceof Error ? err.message : String(err));
    deps.renderer.writeError(`ACP agent error: ${detail}${message}\n`);
    return 1;
  } finally {
    process.off('SIGINT', cleanup);
    process.off('SIGTERM', cleanup);
  }
}

/**
 * Render one streamed ACP progress event as a compact one-line summary
 * for the CLI. Returns '' for events that shouldn't print a line (the
 * final assistant text is already shown in the result block, so we skip
 * `message`/`raw` to avoid double-printing).
 */
function formatProgress(event: ACPProgressEvent): string {
  switch (event.type) {
    case 'tool_call':
      return `▸ ${event.toolCall.title} (${event.toolCall.status})`;
    case 'tool_call_update':
      return event.toolCall.status === 'completed' || event.toolCall.status === 'failed'
        ? `  ↳ ${event.toolCall.title}: ${event.toolCall.status}`
        : '';
    case 'diff':
      return `✎ ${event.diff.path}${event.diff.oldText === null ? ' (new)' : ''}`;
    case 'plan':
      return `☰ plan: ${event.entries.length} step(s)`;
    default:
      return '';
  }
}

async function parallelACPAgents(args: string[], deps: SubcommandDeps): Promise<number> {
  const [csv, ...taskParts] = args;
  if (!csv) {
    deps.renderer.writeError('Usage: wstack acp parallel <agent-id-csv> <task>\n');
    deps.renderer.write('Example: wstack acp parallel claude-code,gemini-cli "review this diff"\n');
    return 1;
  }
  const task = taskParts.join(' ');
  if (!task) {
    deps.renderer.writeError('Usage: wstack acp parallel <agent-id-csv> <task>\n');
    deps.renderer.writeError('Task description is required.\n');
    return 1;
  }

  // Forward SIGINT to abort the run. Each child process tears down in
  // its own finally; the AbortController propagates into the agent.
  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const overrides = acpOverrides(deps);
    const live = await loadLive(deps);
    const result = await runEnsemble({
      agentIds: csv,
      task,
      resolveCmd: (id) => resolveAcpAgentCommand(id, overrides, live?.byId),
      signal: ac.signal,
      onProgress: (agentId, event) => {
        const line = formatProgress(event);
        if (line) deps.renderer.writeInfo(`  [${agentId}] ${line}\n`);
      },
    });

    // Surface skipped agents up-front, before the per-agent output.
    const skipped = result.results.filter((r) => r.status === 'skipped');
    if (skipped.length > 0) {
      deps.renderer.writeWarning(
        `Skipping ${skipped.length} agent(s) not installed: ${skipped.map((s) => `${s.agentId} (${s.reason ?? 'not installed'})`).join(', ')}\n`,
      );
    }
    if (result.summary.succeeded + result.summary.failed + result.summary.cancelled === 0) {
      deps.renderer.writeError('No installed agents to run.\n');
      deps.renderer.write('Run `wstack acp list` to see what is available.\n');
      return 1;
    }

    const fannedOut = result.results
      .filter((r) => r.status !== 'skipped')
      .map((r) => r.agentId)
      .join(', ');
    deps.renderer.writeInfo(
      `Fanning out to ${result.summary.succeeded + result.summary.failed + result.summary.cancelled} agent(s): ${fannedOut}\n`,
    );
    deps.renderer.writeInfo(`Task: ${result.task}\n\n`);

    // Render each result under a clear header, in input order.
    for (const r of result.results) {
      if (r.status === 'skipped') continue;
      deps.renderer.write(`\n=== ${r.agentId} ===\n`);
      if (r.status === 'success') {
        deps.renderer.write(r.result && r.result.length > 0 ? r.result : '(no result)');
        deps.renderer.write(
          `\n[${r.agentId}] success  ${r.durationMs}ms  iterations=${r.iterations} toolCalls=${r.toolCalls}\n`,
        );
      } else if (r.status === 'failed') {
        deps.renderer.writeError(
          `[${r.error?.kind ?? 'unknown'}] ${r.error?.message ?? 'failed'}\n`,
        );
        deps.renderer.write(`[${r.agentId}] failed  ${r.durationMs}ms\n`);
      } else {
        // cancelled
        deps.renderer.writeError(
          `[${r.error?.kind ?? 'aborted'}] ${r.error?.message ?? 'cancelled'}\n`,
        );
        deps.renderer.write(`[${r.agentId}] cancelled  ${r.durationMs}ms\n`);
      }
    }

    const { succeeded, failed, cancelled, skipped: skip } = result.summary;
    deps.renderer.write(
      `\nParallel summary: ${succeeded} succeeded, ${failed} failed, ${cancelled} cancelled, ${skip} skipped.\n`,
    );

    // 0 if at least one agent succeeded, 1 otherwise.
    return succeeded > 0 ? 0 : 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

async function probeACPAgents(args: string[], deps: SubcommandDeps): Promise<number> {
  const csv = args.join(' ');
  let ids: string[];
  if (csv) {
    ids = csv
      .split(',')
      .flatMap((s) => s.split(/\s+/))
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    const detected = await new EnsembleRegistry().list();
    ids = detected.filter((a) => a.installed).map((a) => a.id);
  }
  if (ids.length === 0) {
    deps.renderer.writeError('No installed agents to probe.\n');
    return 1;
  }
  const overrides = acpOverrides(deps);
  const live = await loadLive(deps);
  deps.renderer.writeInfo(
    `Probing ${ids.length} agent(s)… (npx-based agents may download on first run)\n`,
  );
  const results = await probeAcpAgents({
    agentIds: ids,
    resolveCmd: (id) => resolveAcpAgentCommand(id, overrides, live?.byId),
    projectRoot: deps.cwd ?? process.cwd(),
    onProgress: (id, r) => deps.renderer.writeInfo(`  ${r.ok ? '✓' : '✗'} ${id} (${r.ms}ms)\n`),
  });
  deps.renderer.write('\nACP handshake probe:\n\n');
  for (const r of results) {
    if (r.ok) {
      const info = r.agentInfo ? ` — ${r.agentInfo.name} ${r.agentInfo.version}` : '';
      deps.renderer.write(`  ✓ ${r.id.padEnd(16)} ok  ${r.ms}ms${info}\n`);
    } else {
      deps.renderer.write(`  ✗ ${r.id.padEnd(16)} ${r.error ?? 'failed'}  (${r.ms}ms)\n`);
    }
  }
  const ok = results.filter((r) => r.ok).length;
  deps.renderer.write(`\n${ok} of ${results.length} agents completed the ACP handshake.\n`);
  return ok > 0 ? 0 : 1;
}

async function benchACPAgents(args: string[], deps: SubcommandDeps): Promise<number> {
  // `--fs` is parsed into deps.flags by the subcommand arg parser (flags never
  // arrive in `args`); tolerate a literal token too for safety.
  const checkFs = deps.flags?.fs === true || deps.flags?.fs === 'true' || args.includes('--fs');
  const csv = args.filter((a) => a !== '--fs').join(' ');

  let ids: string[];
  if (csv) {
    ids = csv
      .split(',')
      .flatMap((s) => s.split(/\s+/))
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    const detected = await new EnsembleRegistry().list();
    ids = detected.filter((a) => a.installed).map((a) => a.id);
  }
  if (ids.length === 0) {
    deps.renderer.writeError('No installed agents to bench.\n');
    deps.renderer.write('Pass ids explicitly: `wstack acp bench gemini-cli,codex-cli`.\n');
    return 1;
  }

  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const overrides = acpOverrides(deps);
    const live = await loadLive(deps);
    deps.renderer.writeInfo(
      `Benching ${ids.length} agent(s)${checkFs ? ' (with fs check)' : ''}: ${ids.join(', ')}…\n`,
    );
    const result = await runAcpBench({
      agentIds: ids,
      resolveCmd: (id) => resolveAcpAgentCommand(id, overrides, live?.byId),
      projectRoot: deps.cwd ?? process.cwd(),
      checkFs,
      signal: ac.signal,
      onProgress: (agentId, phase, r) => {
        if (phase === 'start') deps.renderer.writeInfo(`  ▸ ${agentId}…\n`);
        else if (r) deps.renderer.writeInfo(`  ↳ ${agentId}: ${r.status}\n`);
      },
    });
    deps.renderer.write(`\n${renderAcpBenchText(result)}\n`);
    // Exit 0 if at least one agent passed; 1 otherwise.
    return result.summary.pass > 0 ? 0 : 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
