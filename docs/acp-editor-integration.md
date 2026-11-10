# Connecting WrongStack to a real ACP editor

This guide covers driving WrongStack **as an ACP agent** from a real editor
(Zed, JetBrains, a VS Code ACP extension, or any ACP-v1 client), plus a
manual verification checklist for each functional capability. For the reverse
direction — WrongStack **as a client** driving other agents — see
[`docs/subcommands/acp.md`](./subcommands/acp.md).

> Scope: this is the field-verification companion to
> [`packages/acp/COMPLIANCE.md`](../packages/acp/COMPLIANCE.md). The protocol
> work has package tests, independent official-SDK peers in both directions,
> a real stdio subprocess cancellation test, and WebSocket runtime tests.
> What it has **not** had is a round-trip
> against a shipping third-party editor — that's what this checklist is for.

---

## 1. Prerequisites

```bash
wstack auth            # configure a model provider (or log in from the editor, below)
wstack acp --echo      # optional: no-provider connectivity smoke (echo agent)
```

`wstack acp` starts even when no provider is configured. It answers
`initialize` and advertises its login methods; until a provider exists every
`session/new`, `load`, `resume` and `fork` answers `auth_required` (-32000),
which editors turn into a login prompt:

| Method id | Type | What the editor does |
|---|---|---|
| `wrongstack-auth` | `terminal` | Offered when the client announces `auth.terminal` (or the legacy `_meta["terminal-auth"]`). The editor relaunches the agent with `auth` appended (`wstack acp auth`) in a terminal, then reconnects. |
| `wrongstack-config` | `agent` (default) | Always offered. `authenticate` re-reads the saved configuration and succeeds once `wstack auth` has configured a provider anywhere. |

The configuration is re-read on each of those requests, so a login finished in
another terminal takes effect without restarting the agent.

`wstack acp --echo` answers the protocol but runs a no-op turn — use it to
confirm an editor can *connect and handshake* before involving a model.

---

## 2. Transports

| Mode | Command | When to use |
|------|---------|-------------|
| **stdio** (default) | `wstack acp` | The normal path — the editor spawns it as a subprocess and talks JSON-RPC over stdin/stdout. |
| **HTTP** | (programmatic: `new WrongStackACPServer({ transport: 7788 })`) | Custom buffered POST transport, not standard Streamable HTTP. No live callbacks or mid-turn streaming. |
| **WebSocket** | `wstack acp --ws[=port]` (default `127.0.0.1:8889`) | Remote / manual testing. Full-duplex: `session/update` and permission prompts stream live during a turn. Origin-guarded for loopback safety. |

---

## 3. Editor configuration

### Zed

Until WrongStack is listed in the [ACP registry](https://agentclientprotocol.com/get-started/registry)
(where Zed's **Install from Registry** finds it), add it as a custom agent in
`~/.config/zed/settings.json`:

```jsonc
{
  "agent_servers": {
    "WrongStack": {
      "type": "custom",
      "command": "wstack",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Then pick **WrongStack** as the agent in Zed's agent panel. Zed spawns the
subprocess and speaks ACP v1 over stdio. `dev::OpenAcpLogs` shows the wire.

### JetBrains IDEs

AI Assistant reads custom agents from `~/.jetbrains/acp.json`:

```jsonc
{
  "agent_servers": {
    "WrongStack": { "command": "wstack", "args": ["acp"], "env": {} }
  }
}
```

Pick it from the AI Chat mode selector. JetBrains does not run ACP agents
inside WSL.

### Generic ACP client

Any ACP-v1 client that spawns a subprocess works with the same shape:

- **command**: `wstack` (or the absolute path to your build's bin)
- **args**: `["acp"]`
- **transport**: stdio, newline-delimited JSON-RPC 2.0

The agent advertises this in its `initialize` response:

```jsonc
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
    "mcpCapabilities": { "http": true, "sse": true },
    "sessionCapabilities": { "close": {}, "list": {}, "delete": {}, "resume": {}, "fork": {} }
  },
  "agentInfo": { "name": "wrongstack", "title": "WrongStack", "version": "…" },
  "authMethods": [
    // only when the client announced terminal login
    { "id": "wrongstack-auth", "name": "Run wstack auth", "type": "terminal", "args": ["auth"] },
    { "id": "wrongstack-config", "name": "Use WrongStack provider settings" }
  ]
}
```

Modes and config options come back in the `session/new` (and `load`, `resume`,
`fork`) responses, not in `initialize`.

### Model picker

Every session carries a `model` config option with `category: "model"`, which
editors show as their model selector. It lists the same models as `/model`: the
providers with a usable credential, their models from the catalog, grouped by
provider, without the providers and models switched off in settings. A value is
`<provider>/<model>` (split at the first slash, so `openrouter/anthropic/claude-x`
works). `session/set_config_option` stores the choice; the next prompt runs on
it, built the way `/model` builds a provider. If that provider cannot be built
the prompt fails with the reason rather than quietly using the old model. The
choice is saved with the session and restored on `session/load` while the model
is still offered. It does not change the default model in your config.

### Slash commands

Once a session opens, WrongStack sends the editor its slash commands
(`available_commands_update`): the commands of the WrongStack terminal that run
without a terminal, such as `/git`, `/init`, `/security`, `/tuneup`,
`/permissions`, `/plugin`, `/acp`, the skill and prompt commands and the hunt
commands. Editors show them in their `/` menu. Typing `/git status` runs the
command and shows its output instead of sending the text to the model; a
command that prepares a task (`/bughunt`, `/prompt …`) then runs that task as
the next model turn. Commands that start background workers (`/spawn`,
`/delegate`, `/director`, `/supervisor`, `/ensemble`) are not offered over
ACP. Commands that only read (`/git`, `/gitcheck`, `/tuneup`'s report,
`/permissions rules`, `/plugin list`, the hunt and prompt commands, …) run at
once; every other command asks first through the editor's permission prompt
and does nothing when you cancel. That includes `/permissions allow`,
`/plugin install` and `/tuneup fix`: a prompt can be written by a model as well
as by you, so nothing that writes your settings or files runs unasked. A
command's exchange stays in the conversation: it is replayed on load and the
model sees it on the next turn.

A client that advertises `clientCapabilities.fs.{readTextFile,writeTextFile}`
and/or `terminal: true` lets WrongStack operate on the **editor's** filesystem
and terminal (see §5).

---

## 4. Manual smoke without an editor

### stdio (no provider needed)

From a WrongStack checkout, run the built-server smoke test:

```bash
bun run --filter @wrongstack/acp smoke
```

Expect: an `initialize` result, a `session/new` result with a `sessionId`,
then a `session/prompt` result with `stopReason: "end_turn"`.
The harness reads the returned session ID before sending the prompt. For a
manual connection to `wstack acp --echo`, do the same; a hardcoded placeholder
session ID will be rejected. Normal editor use should launch `wstack acp` after
`wstack auth`, without `--echo`.

### WebSocket

```bash
wstack acp --ws=8889            # terminal 1 (real agent; sessions need a provider from `wstack auth`)
wstack acp --ws=8889 --echo     # no-provider connectivity test over WS
```

Connect a WebSocket client to `ws://127.0.0.1:8889` and send the same
JSON-RPC frames (one JSON object per WS message). Because WS is full-duplex,
you'll see `session/update` notifications arrive *while* the turn runs.

---

## 5. Verification checklist

Run each against a real editor (or the WS manual path) once a provider is
configured. ✅ = expected behavior.

### Handshake & sessions
- [ ] **initialize** — editor connects; agent returns `protocolVersion: 1` and the capabilities above.
- [ ] **session/new** — a fresh session id is returned with the current mode in `modes`. Without a provider it answers `auth_required` and the editor offers login.
- [ ] **session/prompt** — a simple "say hi" returns `agent_message_chunk`(s) then `stopReason: end_turn`.
- [ ] **session/cancel** — interrupting a long turn yields `stopReason: cancelled` promptly.
- [ ] **session/load after restart** — stop and restart `wstack acp`, then `session/load` a prior id: the conversation history is replayed back to the editor **and** the agent resumes the model context (a follow-up prompt remembers the earlier turns), restored from the durable session store.

### Tool streaming (B1)
- [ ] Ask for a change that uses tools (e.g. "read package.json and summarize"). The editor shows **tool-call cards** (`read`, `edit`, `bash`, …) with live `in_progress → completed` status — not just a final text blob.
- [ ] An edit surfaces a **diff** in the tool card.

### Permission (B2)
- [ ] A side-effecting tool (file write / shell command) triggers a **permission prompt in the editor** (`session/request_permission`) before it runs.
- [ ] Approving lets it proceed; rejecting stops it. Read-only tools (read/search/fetch) run without a prompt.

### Client filesystem / terminal (B3)
- [ ] With the editor advertising `fs` capabilities, file reads/writes go through the **editor's** buffers (unsaved edits are visible to the agent), not a stale on-disk copy.
- [ ] With `terminal: true`, `bash`-style tools run in the **editor's** terminal.

### Client-supplied MCP servers
- [ ] Pass `mcpServers` with `session/new` (stdio, `http`, or `sse` — the agent
      advertises `mcpCapabilities: {http: true, sse: true}`). The server's tools
      appear to the model as `mcp__<server>__<tool>` for that session only, and
      the child process is stopped on `session/close`.
- [ ] A malformed entry does not fail the session: the agent connects the rest
      and reports what it skipped as an `agent_message_chunk`.
- [ ] `session/fork` inherits the parent's servers; passing a new `mcpServers`
      array on `fork` / `load` / `resume` replaces the set.

### Model picker
- [ ] The editor's model selector lists your configured providers' models, the session's model selected.
- [ ] Picking another model and sending a prompt answers from that model (the reply names it, or the provider's usage view shows it).

### Multimodal (B5)
- [ ] If the editor + your model support vision, attaching an image to a prompt reaches the model (the agent advertises `promptCapabilities.image: true`).

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Editor can't connect | `wstack` not on PATH / wrong bin | Use the absolute path to your built CLI in the editor config. |
| Editor asks to log in / `session/new` returns `auth_required` (-32000) | no provider configured yet | Use the editor's login button (runs `wstack acp auth`), or run `wstack auth` in any terminal and retry; no agent restart needed. |
| No tool cards, only final text | client not rendering `tool_call` updates | Confirm the editor is an ACP-v1 client that renders tool calls; check it's not using a legacy/draft ACP build. |
| File edits ignore unsaved buffers | client didn't advertise `fs` caps | Enable the editor's ACP filesystem capability; otherwise the agent uses local disk (correct on the same machine, just buffer-unaware). |
| WS connection rejected (1008) | cross-origin | The WS server is loopback-only and rejects foreign `Origin` headers; connect from a non-browser client or same origin. |
| `session/load` returns "not found" after restart | persistence dir mismatch | History persists under the project's wstack data dir (`paths.projectDir/acp-sessions`, i.e. `~/.wrongstack/projects/<hash>/acp-sessions`); restart from the **same project root** so the hash matches. |

---

## 7. What's validated vs. what this checklist adds

Already covered by automated tests (see `COMPLIANCE.md`):
- every method answered with a spec-shaped response (wire compliance);
- our client ↔ our server interop over a JSON round-trip (in-process loopback);
- the WebSocket transport over a real socket (runtime smoke);
- no regressions across the full CLI suite.

This checklist adds the one thing automation here can't: a **third-party
editor's** interpretation of our wire. File any divergence you find against the
relevant capability above.
