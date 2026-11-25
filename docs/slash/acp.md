# `/acp` — drive installed ACP coding agents

Discover and assign tasks to the ACP-supporting coding CLIs already installed
on your machine (Claude Code, Codex CLI, Gemini CLI, OpenCode, …) — from inside
the WrongStack interface, without leaving it.

These external agents run as **subprocesses using their own login**, so you use
them without spending API credits in WrongStack. WrongStack sandboxes their
filesystem/terminal access to the project root and routes their permission
requests through the active permission policy.

## Usage

```
/acp                          Discover current registry and local agents
/acp commands                 List the active ACP leader's commands
/acp command <name> [args]    Run one of those commands in the same conversation
/acp config                   Show the active ACP leader's live settings
/acp config <agent-id> <option-id> <value>
/acp mode [selector] [value]   Show or switch the active ACP leader's mode
/acp plan                     Show the active ACP leader's latest plans
/acp children [session-id]    Inspect the active agent's child sessions
/acp <agent-id> <task>        Run a task on ONE agent, inline + streamed
/acp <agent-id> --bg <task>   Run it as a background fleet subagent (see /agents)
/acp sessions <agent-id> [cursor]
/acp continue <agent-id> <session-id> <task>
/acp fork <agent-id> <session-id> <task>
/acp companion <agent-id> <task>
/acp companion [forget <agent-id>]
/acp parallel <csv> <task>    Fan one task out to several agents at once
/acp probe [csv]              Handshake-test agents — shows what actually works
/acp bench [csv] [--fs]       End-to-end verify each agent + graded report
/acp sync                     Pull the official agentclientprotocol/registry
/acp help
```

## Continue external agent sessions

Use `wstack acp sessions <agent-id>` to list sessions for the current project.
Pass the displayed cursor to fetch the next page. Add `--json` for scripting.
The same listing is available through `/acp sessions` in a live WrongStack session.

Successful inline tasks print their ACP session ID. Pass it to
`wstack acp continue <agent-id> <session-id> "<task>"` to use that history.
`wstack acp fork <agent-id> <session-id> "<task>"` sends the task to a new copy
when the agent advertises fork support. The `/acp continue` and `/acp fork`
forms use the same protocol operations. A rejected session ID ends the command
with an error. [ACP session discovery](https://agentclientprotocol.com/protocol/v1/session-list)

## Attachments with an ACP leader

For an image prompt, WrongStack reads the active ACP session's advertised image
capability before routing the request. Supported image uploads reach the agent
as image data. Other agents use the configured image-understanding fallback.
URL-only images that reach the ACP leader travel as resource links.

When a fresh ACP leader joins an existing WrongStack conversation, the handoff
carries extracted text from prior PDFs and recent images that fit the attachment
budget. An agent that resumes its own persisted session uses that session's
existing history. [ACP content types](https://agentclientprotocol.com/protocol/v1/content)

## Run an agent's own slash commands

Select an ACP leader and run `/acp commands` to see the commands that the agent
advertises for the active session, including any argument hints. Send one with
`/acp command <name> [args]`. WrongStack sends the command text through the
normal conversation turn so that streaming and permission requests stay in the
current session. [ACP slash commands](https://agentclientprotocol.com/protocol/v1/slash-commands)

## Change an active agent's model settings

Run `/acp config` with an ACP leader selected to see the current model, effort
and other supported model settings from that conversation. Use the option ID and
a value from the list with `/acp config <agent-id> <option-id> <value>`.
The change takes effect in the current ACP session and is saved in the
WrongStack conversation. If switching models changes the available effort levels,
the command shows the updated choices. Use `/acp config <agent-id> reset` to clear
the conversation's overrides. If the original value is unavailable in the live
session, WrongStack clears the override and reports the agent's current value.
[ACP configuration options](https://agentclientprotocol.com/protocol/v1/session-config-options)

Use `--lane=N` or `--role=name` with the same command to configure fleet workers.

## Inspect or switch a session mode

Run `/acp mode` with an ACP leader selected to see the current mode and the
values the agent advertises. Use `/acp mode plan` when Plan is selectable.
When the agent has separate selectors, name the selector explicitly. For
example, Codex exposes `/acp mode collaboration_mode plan` for planning and
`/acp mode mode read-only` for sandbox permissions.

The command applies the change to the current agent session. WrongStack lists
the values its ACP integrations can select and keeps permission-bypass values
view-only. [ACP config options](https://agentclientprotocol.com/protocol/v1/session-config-options) · [ACP legacy modes](https://agentclientprotocol.com/protocol/v1/session-modes)

## Follow an ACP agent's plan

Run `/acp plan` to read the active agent's checklists and Markdown plans.
Checklist steps also update the conversation's Todos as the agent reports
progress. Plans can change during a turn or between turns. The command shows
the latest version of each plan, including completed checklists that the agent
still reports. [ACP agent plans](https://agentclientprotocol.com/protocol/v1/agent-plan)

## Inspect an ACP agent's subagents

Run `/acp children` to see the child sessions that the active agent announces.
The list shows parent-child relationships and the latest state the agent
reported. Run `/acp children <session-id>` to read one child's recent output,
messages from other sessions, and last tool activity. The view is read-only.
[ACP subagents](https://agentclientprotocol.com/protocol/v1/subagents)

## Run fleet workers and companions alongside an ACP leader

Use `/acp codex-cli --bg "Review the current diff"` to dispatch an external
fleet worker without switching the leader. Track the worker with `/agents`.

Use `/acp companion codex-cli "Review the current diff"` to start a separate
ACP conversation. Send another `/acp companion codex-cli "Explain the first
finding"` to continue with the agent's original history. Use `/acp companion`
to list the external sessions linked to the current WrongStack conversation
and `/acp companion forget codex-cli` to remove a link. Companion turns use
the same permission flow as inline `/acp` tasks. Follow-ups require the
agent to support ACP resume or load. WrongStack restores saved links when you
reopen the same conversation. New conversations and forks start with their
own links. Forgetting a link leaves the external agent's session available
through `/acp sessions` and `/acp continue`.

WrongStack's built-in Explore and Memory companions keep their own tools and
budgets. With an ACP leader, configure a native model for the companion role
or set `acp.leader.sideModel` to a native `provider/model`. The default route
also checks `fallbackBridge` and the first `fallbackModels` entry. Built-in
companions require a native model route.

## Answer an ACP agent's questions

An active ACP leader can ask for project input during a turn in the TUI or
WebUI. The form identifies the requesting agent and appears in its conversation.
Review and edit the answers before sending them. Use **Decline** to refuse the
request or **Cancel** to dismiss the form. In the TUI, press `x` or `Esc`
outside a text field for those actions.

This supports session-scoped forms with text, numbers, booleans and choices.
Use the agent's own sign-in flow for credentials. ACP URL elicitation is
currently unavailable. [ACP elicitation](https://agentclientprotocol.com/protocol/v1/elicitation)

## `probe` vs `bench`

- **`/acp probe`** is fast: it only runs the `initialize` handshake and reports
  ok/fail + latency. Use it to see which agents can speak ACP at all.
- **`/acp bench`** is the full verification: for each agent it runs handshake →
  `session/new` → a real `session/prompt` (echo a unique token) and grades the
  result **pass / partial / fail** with per-check detail and timings. Add
  `--fs` to also verify the `fs/read_text_file` callback channel (the agent is
  asked to read a sandboxed temp file). Defaults to all installed agents;
  pass a csv to bench specific ids. Each bench runs a real model turn, so it
  uses the agent's own login and takes longer than `probe`.

```
/acp bench                       # bench every installed agent
/acp bench gemini-cli,codex-cli  # bench specific agents
/acp bench --fs                  # also verify the fs callback channel
```

## Where the agent list comes from

`/acp` and `wstack acp list` refresh the official registry when the local
snapshot is missing or at least one hour old. WrongStack reads the latest
GitHub release and falls back to the ACP CDN, the last cached snapshot, or
the bundled catalog. `/acp sync` forces a refresh. [Official ACP registry](https://github.com/agentclientprotocol/registry)

The list puts detected local and configured agents first, followed by
package launchers and binaries that require setup. Package launchers use
the registry version when available. For binary releases, install the
vendor's CLI or configure the path of the extracted executable. Upstream
quarantined entries show the published reason and require a profile command
override to launch.

CLI and WebUI model pickers and fleet delegation read the same local cache.
WrongStack uses commands set in the active profile first, then a detected local
ACP command, then the registry launch command or bundled fallback.
The MCP bridge allowlist controls project-service access. Installed agents can
lead sessions and expose runtime settings with the bridge disabled.

### Examples

```
/acp
/acp gemini-cli "explain src/agent.ts"
/acp claude-code --bg "refactor auth/session.ts and run the tests"
/acp parallel claude-code,gemini-cli,codex-cli "review this diff"
/acp probe
```

## Agent ids

Use `antigravity-acp` for `agy acp`, `claude-code` and `codex-cli` for the
official adapters, `opencode` for the current OpenCode CLI, and `pi-acp` for
the Pi adapter. Existing `opencode-v2` commands still work. Command Code is
available as `command-code` and uses `cmdc acp` on Windows. [Antigravity ACP](https://antigravity.google/docs/cli/acp/) · [Command Code ACP](https://commandcode.ai/docs/acp)

## Detection vs. handshake

`/acp probe` runs the ACP `initialize` handshake and reports the session, prompt
and MCP capabilities the agent advertises. `wstack acp config <agent-id>`
opens a session and returns its available model and effort options, modes and
commands. `/acp config <agent-id>` applies the agent's available options to the
current session or a fleet lane or role.

## Fixing an agent that probes ✗

If an agent is detected but `probe` shows it failing, its catalog entry needs a
different ACP entry command. Override it in your **user** config
(the active profile config) — never in a repo-committed config, where it is
stripped as an arbitrary-command-exec risk:

```json
{
  "acp": {
    "agents": {
      "codex-cli": { "command": "npx", "args": ["-y", "@agentclientprotocol/codex-acp"] },
      "claude-code": { "command": "npx", "args": ["-y", "@agentclientprotocol/claude-agent-acp"] }
    }
  }
}
```

Precedence when resolving an agent's command: **user override → synced registry →
legacy map → bundled catalog**.

## Inline vs. `--bg`

ACP fleet workers (including `claude-code`) use a separate task budget from
WrongStack's internal workers. They do not inherit internal role/coordinator
iteration, tool-call, token, cost or wall-clock defaults. By default a task is
reaped after **10 minutes without activity**; streamed progress resets that
clock. Explicit task limits still apply, and Stop cancels the worker. A
`delegate` wait window does not automatically become an ACP task deadline;
an explicitly supplied `timeoutMs` does, without the internal worker buffer.

- **Inline** (default) runs the agent now, streams its tool calls / diffs into
  the chat, and returns the result. No director mode required.
- **`--bg`** dispatches the agent as a background fleet subagent (requires
  director mode — run `/director` first). Track it with `/agents`.

A worker's turn has no length limit: it runs until the agent finishes, you cancel it, or the agent
goes silent for 10 minutes (no update, permission request, file or terminal call). A silent turn
is cancelled with `session/cancel`, so the agent stops instead of editing on after WrongStack has
given up, and it is reported as a stalled worker, not a broken connection.

## The WrongStack bridge

A delegated worker keeps its own identity, tools and sign-in. WrongStack only tells it where it
works and gives it the project's coordination services:

- **MCP servers** in `session/new`, each launched as `wstack mcp serve <name> --project-root=<project>`:
  `wrongstack-index` (read-only code index with `--watch`, so files the worker edits stay
  searchable; `codebase_search`, `codebase_incoming_calls` and `codebase_read_symbol` load upfront
  instead of behind tool search), `wrongstack-sage` (memory: recall, propose with
  `memory_candidates`), `wrongstack-mailbox` (writable, actor = the worker's subagent id,
  `@session` = the session that delegated the task), `wrongstack-kanban` (writable, no destructive
  ops; `stats` gives whole-project totals), and optionally `wrongstack-intake`.
- **A short note appended to the agent's own system prompt** (`_meta.systemPrompt.append`, which
  the Claude ACP adapter forwards to the `claude_code` preset), saying it works inside WrongStack,
  how to report progress, and that its final reply returns to WrongStack.

It applies to inline runs, `--bg` dispatch and `wstack acp spawn`. Default: on for `claude-code`
with codebase-index, sage, mailbox and kanban. Configure it in the active profile config (never from in-project
config):

```json
{
  "acp": {
    "bridge": {
      "agents": ["claude-code"],
      "servers": ["sage", "mailbox", "kanban", "codebase-index"]
    }
  }
}
```

`"agents": []` or `"servers": []` turns it off. Agents that do not read the `_meta` extension still
get the MCP servers.

`"indexSurface": "cli"` (default `"mcp"`) gives the worker the codebase index through its shell
instead of an MCP server: no `wrongstack-index` server is attached, and the note teaches
`<wstack> tools run codebase-context -- --query "…"` (and the other `codebase-*` tools), with the
command built from the same install that launches the MCP servers. Nothing is loaded up front —
`wstack tools describe` fetches a schema when needed — and every call catches the index up with
the worker's own edits. Measured on this repository (≈ chars/4): MCP mode puts ≈ 1,700 tokens of
index note, always-loaded schemas and server instructions in front of the worker; CLI mode ≈ 920
(the note only). The other servers stay MCP either way.

That up-front saving does not make it cheaper overall. In a live comparison (2026-10-15, three
read-only code questions, one real Claude worker each) the CLI mode took more turns, and every turn
re-reads the cached context: $2.08 against $1.67 for MCP (about 25% more), with the worker
reaching for the index less often. Keep the default `mcp` for Claude workers; `cli` is there for
agents that do better with a shell surface, or to compare.

### Delegating from a session

When a bridged agent is installed (its CLI is on PATH, or `acp.agents` configures it), the
`delegate` tool names it to the session's model, which hands it work with
`delegate({ name: "claude-code", provider: "acp", … })`. Model lanes, `/setmodel` routes and tiers
never reroute such a task to a WrongStack model.

While the worker's turn runs, a `session_note` to it (by its subagent id or `claude-code`) is
injected into that turn through the agent's `_session/steering` extension, so the leader can
redirect it mid-task. Peers' `@session` broadcasts are not injected (a steer interrupts the
worker's generation); the leader's are. The worker reads such a message as a user message that
starts with `[WrongStack <kind> from <agent>]`.

The agent's own stderr stays off the screen (`WRONGSTACK_DEBUG=1` echoes it live); when the agent
crashes, its last lines are printed and its last line names the cause.

### Permissions for a delegated worker

A worker the session delegates to runs in the session's project and answers to the same rules as
WrongStack's own subagents, so delegation is never a way around them. It starts in its `default`
mode (Claude asks before edits, commands, fetches and MCP tools, whatever mode you use Claude in
yourself; a Claude adapter that cannot switch to it is not started), and each request is translated
into the matching WrongStack call (`bash`, `write`, `edit`, `fetch`, `read`, or the MCP tool under
its own `mcp__server__tool` name) and decided by the subagent policy:

- your deny rules (trust file, `/permissions deny`) refuse it;
- history-rewriting git commands, credential reads and writes to WrongStack's own state are
  refused, because a worker cannot stop to ask you;
- YOLO+ lifts those refusals, but never your deny rules.

The worker sees a refusal as a denied permission and is told not to retry or work around it, and
to name it in its final reply. A request the policy cannot check is refused, not waved through:
an unknown kind, a command or edit that names no target, or a tool this run does not have (under
`--restricted`, shell, network and MCP requests are all refused). Thinking, searching the project
and switching back to ask-first mode need no check. `wstack acp spawn` and inline `/acp` are runs
you start yourself and keep the agent's own permission mode.

## An ACP agent as the leader

An installed agent can also lead the session instead of a model:

```
wstack --provider acp --model claude-code
/model acp/claude-code
```

In the WebUI, pick **acp / claude-code** in the model switcher; `acp` is
listed with the ACP agents installed on the machine.

Each of your messages becomes one turn of a single agent session for the
WrongStack session (the agent keeps its own conversation). Its reply streams
into the chat, its tool calls show as tool cards, and its token usage and
quota are tracked like a model's. It runs its own loop, so WrongStack's system
prompt and model routing do not apply to it.

- **Context** — the agent keeps its own conversation, so the context bar,
  `/context` and the WebUI show the agent's own reading of its window (Claude:
  200k, or 1M on a `[1m]` model), live as a long turn grows and after Claude
  compacts on its own. A turn's token usage is still the sum of every model
  call in it; that is spend, not context. WrongStack never compacts or trims
  its copy of the conversation on this route, and `/compact` asks the agent to
  compact its own.
- **Resume** — resuming a WrongStack session the agent led continues the
  agent's own session (`session/resume`, remembered per project in
  `acp-leader-sessions.json`), with its full context and tool history.
- **Joining a conversation** — picking the agent mid-conversation (`/model
  acp/claude-code`), or a resume the agent cannot continue, starts a fresh
  agent; its first turn carries the earlier turns as text (the newest ~60k
  characters, without tool calls and their results).
- **Tabs** — on the WebUI each tab's agent runs its own fleet tools and is
  decided by that tab's permissions; a fleet call you approve on the agent's
  permission request runs without a second question.

- **Permissions** — the agent starts in its `default` mode and every request it
  makes is decided by your own rules; one that needs approval is asked through
  the same prompt as WrongStack's own tools: the REPL's, or the TUI and WebUI
  approval prompt in the session's tab, beside the call's tool card. Nobody
  answering within two minutes refuses it; with YOLO on, your rules allow it
  without a question.
- **Side requests** — session titles, summaries, next-step suggestions and any
  WrongStack subagent that inherits the leader's model never reach the agent;
  they go to `acp.leader.sideModel` (falling back to `fallbackBridge`, then the
  first `fallbackModels` entry):

  ```json
  { "acp": { "leader": { "sideModel": "zai/glm-5" } } }
  ```

- **A spent subscription** fails the turn as `quota_exhausted`, so a configured
  fallback chain moves the session to a WrongStack model.

- **WrongStack's workers** — the agent also gets a `wrongstack-fleet` MCP
  server, served by this process on a loopback port behind a per-process
  token. It offers the coordination tools your profile has enabled
  (`delegate`, `spawn_subagent`, `assign_task`, `await_tasks`, `roll_up`,
  `fleet_status`, `session_note`, `terminate_subagent`). Each call runs as the
  leader's own tool call, so the workers show in F2/F3 and use WrongStack's
  model routing; a background `delegate` result reaches the agent with its next
  turn. Its permission requests for these tools are decided as those tools.

Design and status:
[`docs/plans/acp-leader-mode.md`](../plans/acp-leader-mode.md).

## Related

- `/ensemble <csv> <task>` — the original parallel fan-out (same engine as
  `/acp parallel`).
- `wstack acp {list,spawn,parallel,server}` — the CLI surface.
- [`docs/acp-ensemble.md`](../acp-ensemble.md) — architecture reference.
