# `wstack acp` — Agent Client Protocol

WrongStack as an ACP-compatible agent (server) and as a driver of external
ACP agents (client). See [ACP Ensemble Architecture](../acp-ensemble.md) for
the top-level design; this page is the CLI surface reference. To connect a
real editor (Zed, JetBrains, …) and verify each capability, see the
[ACP editor integration guide](../acp-editor-integration.md).

## Usage

| Command | Effect |
|---|---|
| `wstack acp` | Start WrongStack as an ACP server (real agent); blocks on stdin/stdout |
| `wstack acp --echo` | Start the ACP server in no-op echo mode (connectivity test, no provider needed) |
| `wstack acp server` | Same as `wstack acp` |
| `wstack acp serve` | Same as `wstack acp` |
| `wstack acp auth` | Interactive provider setup; also accepts `wstack acp server auth` for appended ACP terminal-login arguments |
| `wstack acp list` | List ACP-supporting agents detected from the cached/synced registry and local probes |
| `wstack acp sync` | Refresh the official `agentclientprotocol/registry` cache |
| `wstack acp spawn <agent-id> <task>` | Run a task on a single ACP agent and stream the result |
| `wstack acp parallel <agent-ids-csv> <task>` | Fan a task out to multiple ACP agents concurrently |
| `wstack acp probe [agent-ids-csv]` | Handshake-test selected installed agents (all installed agents by default) |
| `wstack acp bench [agent-ids-csv] [--fs]` | Run an end-to-end prompt/marker benchmark, optionally checking filesystem behavior |
| `wstack acp help` | Show help |

ACP clients such as Zed, JetBrains, and VS Code ACP integrations spawn
`wstack acp server` as a subprocess and communicate via stdio JSON-RPC 2.0.
The server speaks the v1 spec — see [the v1 protocol reference](https://agentclientprotocol.com/get-started/introduction).

`wstack acp list` probes the synced registry, with
`packages/acp/src/registry/agents.catalog.ts` as its offline fallback. Each entry is checked via
`spawn()` with the platform-appropriate shell flag, and the result is
cached for 5 seconds. Run `wstack acp sync` to pull the latest
[agentclientprotocol/registry](https://github.com/agentclientprotocol/registry)
(the available agents change over time). Example output (your host will differ):

```
Detected ACP agents:

  ✓ claude-code      Claude Code  (adapter)
  ✓ gemini-cli       Gemini CLI  (native)
  ✓ codex-cli        Codex CLI  (adapter)
  ✓ opencode         OpenCode  (native)
  ✗ goose            Goose  (binary not found)
  ✗ cursor           Cursor  (binary not found)
  …
```

## `wstack acp spawn`

Runs a single task on a single ACP agent and waits for the result.

```
wstack acp spawn <agent-id> <task description>
```

The agent is looked up in the 13-entry catalog first, then the synced
registry, with the legacy `ACP_AGENT_COMMANDS` map only as a last resort.
The task is sent as a single
`session/prompt` turn; `session/update` notifications are streamed to stderr
(if you want them) and the final `stopReason` and result text are printed to
stdout.

If the agent is not installed, the command exits non-zero with a clear
"not detected" error pointing to the catalog.

## `wstack acp parallel`

Fans a task out to multiple agents concurrently via `Promise.allSettled` and
renders each agent's outcome plus a roll-up summary. Same engine as the
[`/ensemble`](../slash/ensemble.md) slash command.

```
wstack acp parallel claude-code,gemini-cli,codex-cli "review this diff"
```

```
=== claude-code ===
[success] …
[claude-code] succeeded  8.4s

=== gemini-cli ===
[success] …
[gemini-cli] succeeded  7.2s

=== codex-cli ===
[success] …
[codex-cli] succeeded  9.1s

Ensemble summary: 3 succeeded, 0 failed, 0 cancelled, 0 skipped. (9.4s total)
```

Each agent's section is `=== <id> ===`, followed by either the result text
(success), a `[error_kind] message` line (failed), a `(skipped — reason)` line
(not installed), or a `(cancelled)` line. The summary footer rolls up counts
and total wall time.

Agents not installed on the host are **skipped with a warning** rather than
failing the whole command. If all requested agents are missing, the command
prints a single error and exits non-zero.

## `wstack acp server`

Starts the v1 server. By default it wires each ACP session to a real
`@wrongstack/core` `Agent` built from your configured provider/model, so any
ACP-capable client (Zed, JetBrains, VS Code ACP extension, etc.) gets genuine
WrongStack responses over stdio JSON-RPC 2.0.

```
wstack acp            # serves a real agent (log in with `wstack auth`)
wstack acp --echo     # no-op turn; connectivity smoke test, no provider needed
```

Without a configured provider the server still starts and handshakes, then
answers `auth_required` to every session request (never silently echoing), so
the editor offers its login: `wstack acp auth` in the editor terminal, or
`wstack auth` anywhere. The configuration is re-read on each request, so no
restart is needed. See [the editor guide](../acp-editor-integration.md).

The per-session `Agent` is built by `buildAcpServerAgentFactory`
(`packages/cli/src/acp-server-agent.ts`) and driven by
`makeACPServerAgentTurn` (`@wrongstack/acp/agent`). Each session gets its own
`EventBus` and `Context` for isolation; the provider registry and container are
shared across sessions. The server runs headless under an
`AutoApprovePermissionPolicy` (same posture as subagents) since there is no
interactive permission channel over ACP.

For programmatic control — e.g. a custom agent factory, MCP wiring, or richer
session behaviour — instantiate `WrongStackACPServer` directly with a
`runTurn` of your own:

```ts
import { WrongStackACPServer, makeACPServerAgentTurn } from '@wrongstack/acp';
import { Agent } from '@wrongstack/core';

const server = new WrongStackACPServer({
  runTurn: makeACPServerAgentTurn({
    agentFor: async (sessionId, cwd) => new Agent({ /* … */ }),
  }),
  defaultCwd: process.cwd(),
});
await server.start();
```

See `scripts/acp-smoke-test.mts` for a complete Node harness that walks a
full v1 session and asserts on every response.

## Code reference

- `packages/cli/src/subcommands/handlers/acp.ts` — the CLI handler
- `packages/cli/src/acp-server-agent.ts` — builds a real per-session `Agent` for the server
- `packages/acp/src/integration/acp-subagent-runner.ts` — single-agent runner
- `packages/acp/src/integration/ensemble-runner.ts` — multi-agent orchestrator
- `packages/acp/src/registry/{agents.catalog,ensemble-registry}.ts` — discovery
- `packages/acp/src/client/acp-session.ts` — the v1 client
- `packages/acp/src/agent/{protocol-handler,wrongstack-acp-agent,server-agent-turn}.ts` — the v1 server
- [ACP Ensemble Architecture](../acp-ensemble.md) — top-level design
- [`/ensemble` slash command](../slash/ensemble.md) — the in-REPL counterpart
