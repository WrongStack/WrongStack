/**
 * WrongStackACPServer — ACP v1 server-side entry point.
 *
 * Exposes WrongStack as an ACP-compatible agent. ACP clients (Zed, JetBrains
 * Junie, VS Code ACP extension) spawn this as a subprocess, send JSON-RPC
 * messages over stdio, and receive v1-protocol responses.
 *
 * Usage:
 *   node dist/agent/wrongstack-acp-agent.js
 *
 * Or via the CLI:
 *   wstack acp-server
 *
 * Wiring a real agent: this class is the surface; the bootstrap
 * binary uses a no-op echo by default so the binary is a useful
 * connectivity smoke test. For a real server, instantiate
 * `WrongStackACPServer` programmatically and pass a `runTurn`
 * produced by `makeACPServerAgentTurn({ agentFor: ... })` from
 * `./server-agent-turn.js`. The factory is responsible for building
 * a real core `Agent` (with the right provider, model, system prompt,
 * etc.) per session.
 *
 * Startup: ACP v1 is newline-delimited JSON-RPC on stdout. The server
 * therefore writes no non-JSON stdout by default. A legacy startup marker
 * remains available for older internal harnesses via `legacyStartupMarker`.
 */
import { fileURLToPath } from 'node:url';
import { writeErr } from '@wrongstack/core';
import {
  ACPProtocolHandler,
  type RunTurn,
  type RunTurnResult,
} from './protocol-handler.js';
import { StdioTransport } from './stdio-transport.js';

export interface WrongStackACPServerOptions {
  /**
   * Per-turn implementation. If omitted, the server runs a no-op turn
   * that just resolves with `end_turn`. The real production usage
   * passes the result of `makeACPServerAgentTurn({ agentFor: ... })`
   * from `./server-agent-turn.js` so each session gets a real
   * `Agent` instance.
   */
  runTurn?: RunTurn | undefined;
  /** Default cwd for new sessions. Defaults to the current process cwd. */
  defaultCwd?: string | undefined;
  /** Agent name advertised in initialize. */
  agentName?: string | undefined;
  /** Emit the old non-standard startup marker. Defaults to false. */
  legacyStartupMarker?: boolean | undefined;
}

export class WrongStackACPServer {
  private readonly transport: StdioTransport;
  private readonly handler: ACPProtocolHandler;
  private readonly legacyStartupMarker: boolean;
  private running = false;

  constructor(opts: WrongStackACPServerOptions = {}) {
    this.transport = new StdioTransport();
    const runTurn: RunTurn = opts.runTurn ?? defaultEchoRunTurn;
    this.handler = new ACPProtocolHandler({
      transport: this.transport,
      defaultCwd: opts.defaultCwd ?? process.cwd(),
      runTurn,
      agentName: opts.agentName,
    });
    this.legacyStartupMarker = opts.legacyStartupMarker === true;
  }

  /**
   * Start the server. Blocks until the client disconnects.
   *
   * Loop: read JSON-RPC messages, dispatch to the handler, until EOF / error.
   */
  async start(): Promise<void> {
    if (this.legacyStartupMarker) {
      this.transport.sendStartupMarker();
    }
    this.running = true;
    while (this.running) {
      const msg = await this.transport.read();
      if (!msg) break; // EOF
      const terminal = await this.handler.handleMessage(msg);
      if (terminal) break;
    }
    this.transport.close();
  }

  /** Stop the server. */
  stop(): void {
    this.running = false;
    this.transport.close();
  }
}

/**
 * Default per-turn implementation: a no-op that echoes nothing useful
 * and returns `end_turn`. Lets the server boot end-to-end without
 * needing the core Agent factory (which would couple this entrypoint
 * to a long-lived model provider). The real implementation is
 * `ACPServerAgentTurn` (follow-up PR) that wires a core `Agent`.
 */
const defaultEchoRunTurn: RunTurn = async (_input, _emit): Promise<RunTurnResult> => {
  return { stopReason: 'end_turn' };
};

/**
 * Bootstrap function for `node dist/agent/wrongstack-acp-agent.js`.
 * Instantiates the server with the default (no-op) runTurn so the
 * binary is useful as a connectivity smoke test.
 *
 * In practice the CLI will instantiate and run `WrongStackACPServer`
 * directly, passing a real `runTurn` wired to a core `Agent`.
 */
/* v8 ignore start -- process entrypoint: bootstrap + auto-start only run when launched as `node wrongstack-acp-agent.js`, never on import (which the CLI does to reuse the class). */
async function main(): Promise<void> {
  const server = new WrongStackACPServer();
  await server.start();
}

const isEntrypoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  main().catch((err) => {
    writeErr(`[wstack-acp fatal] ${err}\n`);
    process.exit(1);
  });
}
/* v8 ignore stop */
