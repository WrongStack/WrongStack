# ACP leader mode — Claude Code (or another ACP agent) as the session's leader

Status: phases 1 and 2 built (2026-10-13) — `packages/cli/src/acp-leader/`.
Phase 3 built (2026-10-14): WebUI parity, the TUI/WebUI confirmations, per-tab
fleet calls and resume (see below and Resume).
Moved 2026-11-08 to `@wrongstack/runtime/acp-leader` (`packages/runtime/src/acp-leader/`;
the CLI files re-export it) so the standalone engine behind WebUI/desktop leads the
same way: `packages/webui-server/src/server/standalone-acp-leader.ts` registers the
factory, binds the host per tab and closes the agent sessions on shutdown. The
process-wide binding alone is the light `@wrongstack/runtime/acp-leader-host` entry.

WebUI, as built: the CLI host lists `acp` with the installed agents beside the
saved providers (`hostProviders` → `providers.saved`, `provider.models`) and
builds it from its own provider registry on a switch (`buildProvider` in the
embedded host). On the TUI and WebUI the agent's permission questions go out as
`tool.confirm_needed` with the session id and the ACP tool call id
(`confirmAcpLeaderThroughEvents`, `acp-leader-confirm.ts`): the tab's ordinary
prompt, refused after 120 s, "always"/"deny" remembered like the leader's own.
A tool call ends a text block, and the WebUI does not print a response that is
exactly the text the turn already showed. Verified live over the WebUI's
WebSocket: picker, switch, tool cards with output, live `ctx.pct`, an edit
approved through the prompt.

Context, as built: the provider declares `capabilities.keepsOwnContext`. A
turn's usage is the sum of every model call the agent made (ten tool calls ≈
ten times the context), so the agent's own reading travels beside it as
`Response.agentContext` (`usage_update` `used`/`size`; a compaction's
`postTokens`). The loop shows that reading as `ctx.pct` and in the token
counter's per-request snapshot, never anchors or calibrates on the turn's
usage, skips auto-compaction and the pre-flight overflow guard on this route,
and the strategy compactor hands `/compact` (CLI, TUI, WebUI) to
`provider.compactOwnContext`, which sends the agent `/compact`. The provider
also publishes each reading as `ctx.pct` while the turn runs and adopts the
agent's `size` as `capabilities.maxContext`. A fresh agent session (a switch
to the agent mid-conversation, a resume) gets the earlier turns as text on its
first turn (`earlierConversation`, newest 60k chars).

Phase 2 notes, as built (`acp-leader-fleet.ts`): the endpoint offers the
coordination tools the leader's registry has — a profile that disables
`delegate` leaves the spawn/assign/await path; each call runs through the
leader's executor and context (`AcpLeaderHost.runTool`); the provider sends
the agent everything since its last reply, so an auto-wake and the
`[DELEGATION RESULT]` folded after it arrive together. Verified live: Claude as
leader spawned a WrongStack worker (zai glm-5.3 via routing), assigned it a
task, awaited it and checked its answer.

Phase 1 notes, as built:

- the provider is registered in `wiring/provider.ts`; the host services are
  bound in `wiring/lifecycle-plugins.ts` (`bindAcpLeaderHost`);
- a leader turn is told apart from a subagent's by `cache.threadId !==
  cache.sessionId`; `complete()` is always a side request;
- the confirmation prompt is used only where the surface has one (the REPL);
  the TUI and WebUI take it away (`disableInteractiveConfirmation` →
  `dropAcpLeaderConfirm`) and answer confirmations their own way, so under
  them a question is refused for now;
- the agent's thoughts are not put into the response (an unsigned thinking
  block would break a later switch to a real Anthropic model);
- on exit the sessions are closed (bounded); the child's tree kill can outlast
  the 500 ms exit grace on Windows, which prints `exit.forced` but leaves no
  process behind.

## Goal

Let the user pick an installed ACP agent — first `claude-code` — as the
**leader** of a WrongStack session, the way they pick a model today, and keep
WrongStack's surfaces (TUI, WebUI, sessions, fleet, SAGE, index, kanban,
mailbox, quota) working around it. Today an ACP agent can only be a delegated
**worker** (`delegate({ provider: "acp" })`, `/acp`).

## The seam: a provider, not a new Agent

The leader is `Agent` (`packages/core/src/core/agent.ts`), a large concrete
class that the TUI, WebUI, slash commands and plugins reach into far beyond
`run()`. Replacing it would touch every surface.

One level down is the seam that already fits: the loop calls
`Provider.stream(req)` (`packages/core/src/types/provider.ts`) once per
iteration and ends the turn when a response carries no `tool_use`. An
**`AcpLeaderProvider`** can therefore:

1. take only the newest user message from `req.messages` (the agent keeps its
   own conversation — WrongStack's history is not replayed);
2. send it as one `session/prompt` on a **persistent** ACP session keyed by
   `req.cache.sessionId` (one Claude session per WrongStack session);
3. stream the agent's updates back as `StreamEvent`s:

| ACP update | StreamEvent |
|---|---|
| `agent_message_chunk` | `text_delta` |
| `agent_thought_chunk` | `thinking_start` / `thinking_delta` |
| `tool_call` / `tool_call_update` | none — rendered through the host sink below |
| `PromptResponse.usage` | `message_stop.usage` (input/output/cache tokens) |
| `PromptResponse.stopReason` | `message_stop.stopReason` |

4. never emit `tool_use`: the agent runs its own tools, so every turn is a
   single text-only iteration and the loop ends it normally.

Everything that keys off the loop keeps working unchanged: history entries,
session JSONL + resume list, cost and token accounting, the status line,
interrupts (abort signal → `session/cancel`, already implemented).

### What the provider needs from the host

`makeProviderFromConfig(id, cfg)` builds providers without host services. The
ACP leader provider is built in CLI wiring instead and registered on the
`ProviderRegistry`, with:

- **a tool sink** — the agent's tool calls are emitted on the host EventBus as
  `tool.started` / `tool.executed` with `external: true`, so TUI/WebUI tool
  cards, F3 and the transcript show what Claude ran (the ACP client already
  produces clean `tool_call` events: title, kind, input, status, diffs);
- **the leader's permission path** — see below;
- **the bridge setup** — the same MCP servers and system-prompt note a worker
  gets (`acp-wrongstack-bridge.ts`), with a leader variant of the note;
- **live progress** — `usage_update` (context used/size → the context meter),
  `_claude/rateLimit` → `recordAcpRateLimit` (quota page/chip).

`@wrongstack/acp` must stay off the boot graph (`boot-graph-boundary.test.ts`
lists it in `MUST_BE_LAZY`), so the provider module is loaded with a dynamic
import only when the configured leader is an ACP agent.

## Permissions: the user is present

A worker cannot ask, so its requests are decided by `AutoApprovePermissionPolicy`
(refuse anything that would need a question). A leader runs in front of the
user, so its requests should go through the **leader's** policy and prompt:

- reuse the request translation in `acp-permission-bridge.ts` (fail-closed
  mapping to `bash` / `write` / `edit` / `fetch` / `read` / `mcp__…`);
- decide with the leader's `PermissionPolicy` (trust rules, YOLO, YOLO+);
- on `confirm`, ask through the leader's `ConfirmAwaiter`
  (`packages/core/src/types/tool-executor.ts`) — the same prompt the TUI and
  WebUI show for WrongStack's own tools; `always*` answers record trust rules
  exactly as they do there;
- start the session in Claude's `default` mode (`initialModeId` +
  `requireInitialMode`, already implemented) so Claude asks at all.

## Delegation from the leader

The bridge gives the agent SAGE, index, mailbox and kanban. A leader also needs
WrongStack's **fleet**: `delegate`, fleet status, `session_note` (steer a
worker), and awaiting results. These live in the host process (the Director),
so they cannot be stdio servers the agent spawns. Claude's adapter accepts
HTTP MCP servers (`mcpCapabilities.http: true`), so:

- the host serves a loopback HTTP MCP endpoint (`@wrongstack/mcp` `serveHttp`,
  per-session bearer token, 127.0.0.1 only) exposing a curated set of the
  host's own coordination tools;
- it is passed in `session/new` `mcpServers` as `{ type: "http", url, headers }`;
- calls run as the leader would run them, so delegated WrongStack subagents
  show in F2/F3 and report back exactly as today.

This is what makes the mode worth having: Claude plans and reviews, WrongStack's
cheaper models do the parallel work.

## Choosing it

ACP agents are not in the models.dev catalog, like the OAuth/subscription
providers (`oauth-providers-not-in-catalog`). They go in the same place: a
saved-config provider entry (proposed id `acp`, models = installed bridged
agents, e.g. `claude-code`), so the existing pickers list it as
`acp / claude-code` with no catalog change.

Guards it needs, because it is a leader-only provider:

- lanes, `/setmodel` routes, tiers, fallback suggestions and subagent model
  resolution must never pick it (`isExternalAgentSpawn` already keeps
  `delegate({ provider: "acp" })` out of lanes; the same exclusion applies to
  the provider id);
- the WebUI provider/key screens must not offer a key field for it.

## What changes for the user (trade-offs)

Kept: TUI/WebUI, sessions and resume, F2/F3, cost/quota, SAGE/index/kanban/
mailbox (through MCP), delegation to WrongStack subagents, interrupts.

Not applied, because the agent runs its own loop:

- WrongStack's system prompt, SAGE injection into the prompt, compaction and
  context budgeting (the agent manages its own context; the context bar shows
  the agent's reading and `/compact` asks the agent);
- WrongStack's built-in tools and their per-tool rendering (the agent's own
  tools render through the external tool sink instead);
- the next-steps final-turn gate (`nextsteps-final-turn-gate`) — must be
  disabled for this provider, or every turn fails the gate;
- `/setmodel` model routing, council/brain features that call the leader
  model for side questions (they need a real model; they keep using the
  session's default WrongStack model).

## Resume

As built: the provider records, per project (`<projectDir>/acp-leader-sessions.json`,
newest 200), which agent session led each WrongStack session. Starting an
agent for a session it led before passes `resumeSessionId`; the ACP client
sends `session/resume` (no history replay, unlike `session/load`) with the
session's MCP servers, `_meta` and mode, and falls back to `session/new` when
the agent refuses it. `ACPSession.openSession()` runs this before the first
turn and says whether it resumed; only a fresh session gets the
`earlierConversation` recap. Verified live: a new process resumed Claude's
session and recalled a word from the old one.

## Phases

1. **Leader turn** — `AcpLeaderProvider` (stream mapping, persistent session,
   usage, abort), saved-config provider entry, picker guard, next-steps gate
   off, external tool sink. Leader-policy permissions with the confirm prompt.
   *Done when:* a TUI session with `acp / claude-code` chats, edits with
   approval prompts, shows tools, cost and context, and survives Esc.
2. **Fleet over HTTP MCP** — loopback MCP endpoint with `delegate`, fleet
   status, `session_note`; leader note explains them. *Done when:* Claude as
   leader delegates to two WrongStack subagents in parallel and uses their
   results.
3. **Resume and WebUI** — `session/load` resume, recap fallback, WebUI parity
   (provider picker, tool cards, confirm prompts).

## Risks / open questions

- One Claude subscription runs the whole session: a spent quota stops the
  leader, not just a worker. Proposal: offer switching the session to a
  WrongStack model when the quota error arrives (the history is already in
  WrongStack's format).
- Concurrency: one ACP session takes one prompt at a time; WrongStack's queued
  input and steer map onto `_session/steering` (already implemented for
  workers).
- Provider id `acp` vs. one provider per agent (`acp-claude-code`) — the first
  keeps the picker short, the second makes per-agent config simpler.
