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
import type { SubcommandHandler } from '../contracts.js';
import {
  benchACPAgents,
  listACPAgents,
  parallelACPAgents,
  probeACPAgents,
  readACPAgentConfig,
  spawnACPAgent,
  syncACPRegistry,
} from './acp-agents.js';
import { runACPServer } from './acp-server.js';

export const acpCmd: SubcommandHandler = async (args, deps) => {
  const sub = args[0];
  // ACP terminal auth appends args to the configured launch command.
  // Support both `wstack acp auth` and `wstack acp server auth`.
  const loginIndex =
    sub === 'auth' ? 0 : (sub === 'server' || sub === 'serve') && args[1] === 'auth' ? 1 : -1;
  if (loginIndex >= 0) {
    const { authCmd } = await import('./auth.js');
    return authCmd(args.slice(loginIndex + 1), deps);
  }

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
  wstack acp config <id>  Read an agent's model/effort options (--json supported)
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
  if (sub === 'config') return readACPAgentConfig(args.slice(1), deps);

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
