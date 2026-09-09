# Connecting WrongStack to a real ACP editor

This guide covers driving WrongStack **as an ACP agent** from a real editor
(Zed, JetBrains, a VS Code ACP extension, or any ACP-v1 client), plus a
manual verification checklist for each functional capability. For the reverse
direction — WrongStack **as a client** driving other agents — see
[`docs/subcommands/acp.md`](./subcommands/acp.md).

> Scope: this is the field-verification companion to
> [`packages/acp/COMPLIANCE.md`](../packages/acp/COMPLIANCE.md). The protocol
> work is fully unit-tested, interop-tested (in-process loopback), and
> runtime-tested (real WebSocket). What it has **not** had is a round-trip
> against a shipping third-party editor — that's what this checklist is for.

---

## 1. Prerequisites

```bash
wstack auth            # configure a model provider (required for a real agent)
wstack acp --echo      # optional: no-provider connectivity smoke (echo agent)
```

`wstack acp --echo` answers the protocol but runs a no-op turn — use it to
confirm an editor can *connect and handshake* before involving a model.

---

## 2. Transports

| Mode | Command | When to use |
|------|---------|-------------|
| **stdio** (default) | `wstack acp` | The normal path — the editor spawns it as a subprocess and talks JSON-RPC over stdin/stdout. |
| **HTTP** | (programmatic: `new WrongStackACPServer({ transport: 7788 })`) | One JSON-RPC request/response per POST; notifications buffered into the response. No live mid-turn streaming. |
| **WebSocket** | `wstack acp --ws[=port]` (default `127.0.0.1:8889`) | Remote / manual testing. Full-duplex: `session/update` and permission prompts stream live during a turn. Origin-guarded for loopback safety. |

---

## 3. Editor configuration

### Zed

Zed discovers ACP agents via `agent_servers` in `~/.config/zed/settings.json`:

```jsonc
{
  "agent_servers": {
    "WrongStack": {
      "command": "wstack",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Then pick **WrongStack** as the agent in Zed's agent panel. Zed spawns the
subprocess and speaks ACP v1 over stdio.

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
    "sessionCapabilities": { "close": {}, "list": {}, "delete": {}, "resume": {} },
    "auth": { "logout": {} }
  },
  "agentInfo": { "name": "wrongstack", "title": "WrongStack", "version": "…" }
}
```

A client that advertises `clientCapabilities.fs.{readTextFile,writeTextFile}`
and/or `terminal: true` lets WrongStack operate on the **editor's** filesystem
and terminal (see §5).

---

## 4. Manual smoke without an editor

### stdio (no provider needed)

Pipe JSON-RPC lines into the echo agent and watch the responses:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":true}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"'"$PWD"'"}}' \
  '{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"REPLACE_FROM_id2","prompt":[{"type":"text","text":"hi"}]}}' \
  | wstack acp --echo
```

Expect: an `initialize` result, a `session/new` result with a `sessionId`,
then a `session/prompt` result with `stopReason: "end_turn"`.

### WebSocket

```bash
wstack acp --ws=8889            # terminal 1 (real agent; needs `wstack auth` first)
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
- [ ] **session/new** — a fresh session id is returned; a `current_mode_update` arrives.
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

### Multimodal (B5)
- [ ] If the editor + your model support vision, attaching an image to a prompt reaches the model (the agent advertises `promptCapabilities.image: true`).

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Editor can't connect | `wstack` not on PATH / wrong bin | Use the absolute path to your built CLI in the editor config. |
| "No model provider configured" | no `wstack auth` | Run `wstack auth`, or test wiring with `wstack acp --echo`. |
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
