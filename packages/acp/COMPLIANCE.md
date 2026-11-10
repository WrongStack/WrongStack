# ACP v1 interoperability — @wrongstack/acp

Reviewed 2026-09-18 against the official ACP documentation and TypeScript SDK 1.4.0.
Auth, initialize and session-setup ordering re-checked 2026-11-09 against spec
v1.16.0 (schema v1.30.0), the ACP registry's `verify_agents.py --auth-check` and
SDK 2.4.0.
The runtime is WrongStack's own JSON-RPC implementation; the SDK is also exported
through `@wrongstack/acp/sdk`. Independent SDK peers now test both directions.

## Roles and supported protocol

- **Client:** WrongStack launches external ACP agents and provides permission,
  filesystem and terminal callbacks. Use `wstack acp sync`, `list`, `probe`, then
  `spawn <agent-id> <task>`; login to the external agent first when required.
- **Agent:** an editor launches `wstack acp` over stdio. Configure a model with
  `wstack auth` first. `--echo` is an explicit connectivity test only.
- **Protocol:** stable v1. Unsupported negotiated versions are rejected by the
  client; our agent answers a newer initialize request with version 1.
  [v2 remains draft](https://agentclientprotocol.com/protocol/v2/migration) and
  changes prompt completion, capabilities and callbacks. It is not enabled here.

## Functional fidelity

| Surface | Implemented behavior and evidence |
|---|---|
| Initialization | v1 negotiation; an `agent`-type login (`wrongstack-config`) always advertised, as the ACP registry requires; terminal login (`wrongstack-auth`) only for `clientCapabilities.auth.terminal` or the legacy `_meta["terminal-auth"]`; `agentInfo.version` is the host's release version; no root `modes`/`configOptions`; no false logout capability |
| Authentication | `authenticate` and session-opening requests consult the host's credential gate and answer `auth_required` (-32000) until it passes; no unconditional success |
| Errors | Codes follow the v1 error reference: `-32000` only for `auth_required`; unknown session `-32002` with `data.sessionId` (prompt, set_mode, set_config_option, load, resume, fork); request before `initialize` `-32600`; unadvertised unstable methods `-32601`; `session/close` of an unknown session succeeds. WrongStack-only conditions use codes outside the reserved ranges: session limit `-31001`, busy session `-31002` |
| Session setup | `modes: {currentModeId, availableModes}` in new/load/resume/fork responses, accepted by the official SDK |
| Load/resume | Warm and persisted sessions; load replays conversation, resume seeds model context without replaying UI history |
| List/delete | Includes persisted sessions when the store supplies `list`; filters by cwd; durable deletion when the store supplies `delete`; unknown deletes succeed |
| Prompt/cancel | Stdio continues reading while a prompt runs; concurrent prompts in one session rejected; session cancellation and request-ID cancellation abort active prompts and their client callbacks |
| Configuration | Select values (flat or grouped) isolated per session, copied on fork and persisted; hosts may add per-session options when a session opens, rebuilt on cold load keeping the saved value while it is offered; current mode and config supplied to custom `runTurn` implementations |
| Model picker | The CLI agent offers a `category: "model"` select (`model`) grouped by provider, from the same list as `/model`; the selection is applied to the session's agent before each turn, and a model that cannot be built fails the turn instead of running on the previous one |
| Content | Text, resource links, images and embedded text; unsaved embedded text survives text-only prompts and replay; client gates optional prompt content on negotiated capabilities |
| Progress | Text, official `agent_thought_chunk` (legacy alias tolerated), plans, tool calls, diffs and usage collected; raw updates available to hosts |
| Permissions | Requests routed to host policy; cancellation returns `{outcome:{outcome:"cancelled"}}`; CLI agent routes side effects through the editor |
| Filesystem | Project containment by default; hosts pass `allowOutsideProjectRoot` to match their own file-tool policy (`features.allowOutsideProjectRoot`); a read leaving the root (path or symlink) is put to the permission policy as kind `read`, and writes always are, each on the canonical (symlink-resolved) target, and the read or write then happens on exactly that target: a read opens a handle and is refused unless the path still resolves to itself and names the same file (device, inode) afterwards; a write re-checks its directory before the rename and the target after it; read/write and 1-based `line`/`limit` reads, preserving line endings |
| Terminals | Create/output/wait/kill/release and bounded output; host permission policy gates execution |
| MCP | Client-provided stdio/HTTP/SSE MCP servers passed to the CLI agent factory; changing the server list on load/resume resets the agent with replay context |
| Unsupported client requests | Explicit method-not-found errors, including elicitation; no empty success that falsely claims support |
| Cleanup | Session close/delete releases cached agents and CLI MCP registries |

The CLI has one built-in `code` mode and a model picker (see above). Embedders can
supply modes/config options, but their `runTurn` (or `applyConfigOptions` on
`makeACPServerAgentTurn`) must apply the selected values.
No-op provider-management methods are legacy compatibility surfaces, not standard
ACP provider configuration. Configure providers through `wstack auth`.

## Transports

| Transport | Scope |
|---|---|
| stdio | Standard v1 path; real child-process test with the official SDK, including mid-turn cancellation |
| WebSocket | WrongStack custom full-duplex transport; CLI `wstack acp --ws`; existing runtime tests cover the bridge |
| HTTP POST | Programmatic buffered request/response transport; not standard ACP Streamable HTTP and not suitable for live bidirectional permission/terminal callbacks |

MCP HTTP/SSE capabilities describe connections to MCP servers, not the ACP
connection itself. The [ACP transport reference](https://agentclientprotocol.com/protocol/v1/transports)
still describes Streamable HTTP as draft.

## Regression evidence

The pre-change package suite passed 731 tests with one existing skip. Independent
regressions then failed for mode response shape, auth advertisement, persisted
session discovery, file ranges, embedded text and thought updates. A separate
stdio cancellation regression also failed before the fix.

- `tests/v1-interop-regressions.test.ts`: official SDK client to WrongStack agent,
  official SDK agent to WrongStack client, persistence, configuration, callbacks,
  content and unsupported capability behavior.
- `tests/sdk-stdio.test.ts`: official SDK client to an actual WrongStack server
  subprocess, NDJSON framing and cancellation during an unfinished prompt.
- Existing package suites: transports, registry, permissions, terminal, session
  store, agent adapter, loopback and ensemble behavior.
- CLI ACP suites: dispatch, login routing, missing-provider failure, agent factory,
  MCP integration, WebSocket and host wiring.

Run `pnpm --filter @wrongstack/acp test`, the focused CLI ACP suites,
`pnpm --filter @wrongstack/acp typecheck`, and `pnpm --filter @wrongstack/acp smoke`.
The SDK tests exercise real protocol implementations without paid model calls.
They do not establish compatibility with every released editor or external agent.

Audit validation: **748 ACP tests passed, one pre-existing skip; 98 focused CLI
ACP tests passed**. ACP and CLI typechecks, ACP build, the built stdio smoke and
scoped Biome checks passed. The repository test-typecheck baseline gate reported
zero new diagnostics and zero unparsed failures. Full repository tests,
coverage and `release:check` were not run.

## Known limitations

- No shipping Zed/JetBrains/VS Code UI round-trip was performed in this audit.
  Use the [editor verification guide](../../docs/acp-editor-integration.md).
- No paid external-agent prompt or provider login was performed. Installed
  versions, credentials and model quality remain host-specific; `probe` checks
  handshake and `bench` checks a real prompt.
- WrongStack is not yet in the ACP registry (45 agents, checked 2026-11-09).
  Releases up to 1.5.3 cannot pass the registry's auth check: they exited
  before `initialize` without a provider and offered no auth method to a client
  that does not announce `auth.terminal`. The fix below has to ship in a release
  before an entry is submitted.
- Draft v2, structured elicitation, boolean config options and additional workspace
  roots are not advertised or implemented. The model picker lists the providers
  configured when the agent was built; a provider added later needs an agent
  restart to appear.
- Terminal authentication is exposed by the agent to capable clients. WrongStack's
  client gives manual login guidance; it does not advertise interactive terminal
  authentication support or launch a login UI automatically.
- Without a configured provider the CLI agent still starts and handshakes, but
  every session request answers `auth_required` (it never falls back to echo
  mode). The saved configuration is re-read on `authenticate` and on each
  session request, so a login from the client's terminal flow or any terminal
  takes effect without a restart.
- `session/fork` is a compatibility extension. The basic fork source must be live;
  cold session discovery/load/resume use the persistent store.
- Custom stores with only `save`/`load` cannot provide durable listing/deletion;
  implement the optional `list`/`delete` hooks for those semantics.
- This is scoped interoperability evidence, not a full release, coverage or
  third-party certification result.

## Official references

[Initialization](https://agentclientprotocol.com/protocol/v1/initialization),
[authentication](https://agentclientprotocol.com/protocol/v1/authentication),
[session setup](https://agentclientprotocol.com/protocol/v1/session-setup),
[session modes](https://agentclientprotocol.com/protocol/v1/session-modes),
[session list](https://agentclientprotocol.com/protocol/v1/session-list),
[session delete](https://agentclientprotocol.com/protocol/v1/session-delete),
[prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn),
[content](https://agentclientprotocol.com/protocol/v1/content),
[tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls),
[filesystem](https://agentclientprotocol.com/protocol/v1/file-system),
[terminals](https://agentclientprotocol.com/protocol/v1/terminals),
[cancellation](https://agentclientprotocol.com/protocol/v1/cancellation),
[config options](https://agentclientprotocol.com/protocol/v1/session-config-options),
[registry](https://agentclientprotocol.com/get-started/registry),
[agents](https://agentclientprotocol.com/get-started/agents),
[clients](https://agentclientprotocol.com/get-started/clients).
