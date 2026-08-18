# @wrongstack/cli

The terminal binary for WrongStack. Provides the `wstack` and `wrongstack` commands.

Most users don't depend on this package directly — they install [`wrongstack`](../../README.md) (the umbrella) and run `wrongstack` / `wstack` from any project directory.

## Install

```bash
npm install -g wrongstack
```

The `wrongstack` umbrella package transitively installs `@wrongstack/cli` along with `core`, `runtime`, `providers`, `tools`, `mcp`, `plug-lsp`, `telegram`, `tui`, `webui`, and optional desktop support.

## Commands

```bash
wstack                        # interactive launch menu (TTY only) — pick TUI/REPL, WebUI, SimpleUI, or HQ
wstack --no-menu              # same as plain `wstack` but skip the launch menu and use saved defaults
wstack --tui                  # Ink-based TUI
wstack desktop                # Electron desktop app (same as --desktop)
wstack webui                  # project WebUI (same as --webui)
wstack hq                     # project-independent HQ dashboard (same as --hq)
wstack --yolo                 # auto-approve tool calls unless explicitly denied
wstack "refactor src/auth.ts" # one-shot query (no interactive loop)

wstack --provider <id> --model <id>   # skip the picker
wstack --resume <session-id>          # resume a saved session
wstack resume <session-id>            # equivalent
```

### Launch menu

When `wstack` is invoked on an interactive TTY with no surface flag, the CLI
prints a five-option launch menu and waits for a numeric choice:

```
  ✱ WrongStack launch mode
  ? Choose how to run WrongStack:
    1) TUI / REPL  (interactive terminal; TUI is the default)
    2) WebUI       (browser-based project UI; port 3456)
    3) SimpleUI    (lightweight browser UI; port 3466)
    4) HQ          (project-independent HQ dashboard; port 3499)
    5) Desktop     (Electron desktop shell; alias: --desktop)
  [1-5, q to quit] (auto 1 in 8s)
```

If you previously picked a mode, the menu shows a one-line summary and a
single `Continue with these? [Y/n/q]` confirmation instead of re-asking
the same question. The chosen mode + port are persisted to the active
profile config (`launch.menuChoice`) so the next launch can
offer the summary gate.

The menu is automatically skipped when:

- stdin is not a TTY (CI, pipes, redirects) — exit code mirrors a flag-based launch
- any surface flag is present (`--webui`, `--simpleui`, `--hq`, `--desktop`)
- a positional subcommand is given (`auth`, `init`, `mcp`, `plugin`, `doctor`, …)
- `--no-menu`, `--no-interactive`, or `--skip` is set
- a positional query or `--prompt <text>` is supplied (one-shot mode)

Use `--no-menu` to bypass the menu in scripts or when you want to opt
into the historical behaviour where the first interactive prompt you see
is the existing TUI/REPL picker from `runLaunchPrompts`.

wstack init                   # interactive provider+model wizard
wstack doctor                 # config/key/MCP/Node health check
wstack export <session-id>    # render a session as markdown/JSON/plain text
wstack mcp add <preset>       # add an MCP server (see @wrongstack/mcp)
wstack mcp list               # show configured MCP servers
wstack plugin status          # show configured plugin enablement
wstack plugin official        # list bundled plugin aliases
wstack plugin install telegram # add the official bundled Telegram plugin
wstack plugin add @wrongstack/telegram      # enable a plugin
wstack plugin disable @wrongstack/telegram  # keep config but skip loading
wstack plugin remove @wrongstack/telegram   # remove from config.plugins
```

`--no-tui` forces REPL mode even when `--tui` is configured globally.

## Slash commands inside the REPL/TUI

```
/help                # list of commands
/help <name>         # detailed help for one command
/clear               # wipe context + memory + visible history
/model               # change model mid-session
/use <provider>      # switch provider
/mode <id>           # activate a mode (debugger, code-reviewer, …)
/memory              # show/edit project memory
/skill [name]        # list skills / show a specific skill
/context             # show token usage breakdown; /context mode, /context repair
/sessions            # list past sessions
/resume <id>         # resume a session
/todos [show|add|done|clear]    # tactical task board (auto-checkpointed)
/plan  [show|add|start|done|remove|clear]   # strategic roadmap (persistent across resume)
/director            # promote the current session into multi-agent director mode
/fleet status|usage|kill|manifest|retry [taskId|all]|log [<id> [raw]]  # inspect/control + retry + view subagent transcripts
/exit                # quit
```

## Mailbox HTTP surfaces

The canonical external-agent mailbox protocol lives in
`packages/core/src/coordination/mailbox-http-router.ts` and is
mounted by two CLI surfaces.

### `wstack mailbox serve` — standalone bridge

```bash
wstack mailbox serve [--port <n>] [--strict-port] [--host <ip>]
```

Starts a loopback HTTP bridge over one project's
`GlobalMailbox` with a per-project lock, token file, and 120/min
sliding-window rate limit. Routes match the table below.

### HQ project gateway — `wstack --hq`

When HQ runs, external agents can talk to any registered project's
mailbox through the project-scoped gateway:

```text
POST /api/projects/<projectId>/mailbox/send
POST /api/projects/<projectId>/mailbox/query
POST /api/projects/<projectId>/mailbox/check
POST /api/projects/<projectId>/mailbox/ack
POST /api/projects/<projectId>/mailbox/ack-many
POST /api/projects/<projectId>/mailbox/unread-count
POST /api/projects/<projectId>/mailbox/agents/register
POST /api/projects/<projectId>/mailbox/agents/heartbeat
POST /api/projects/<projectId>/mailbox/register-client
POST /api/projects/<projectId>/mailbox/heartbeat
GET  /api/projects/<projectId>/mailbox/agents
GET  /api/projects/<projectId>/mailbox/agents/online
GET  /api/projects/<projectId>/mailbox/events           # SSE stream
GET  /healthz                                          # both hosts
```

`projectId` is resolved server-side via `SessionRegistry`; raw
filesystem paths are never accepted. Requires a browser token with
`control.enqueue`. See
[docs/subcommands/hq.md § Project-scoped mailbox gateway](docs/subcommands/hq.md#project-scoped-mailbox-gateway-apiprojectsprojectidmailboxroute)
for the full endpoint contract and curl examples.

### Why one implementation?

The shared router owns the canonical wire protocol — request shape,
response codes, validation, reserved-identity protection, SSE framing,
and `router.close()` semantics. Both the standalone bridge and HQ
deliver byte-identical behaviour for the same input, so external
agents only need to learn one protocol. The bridge owns its lock and
token file; HQ owns its existing browser auth and `control.enqueue`
capability gate. Both mount the router via
`createMailboxHttpRouter({ mailbox, eventEmitter, authorize, rateLimiter })`,
exported from `@wrongstack/core/coordination`.

## Configuration

```
~/.wrongstack/config.json            bootstrap pointer (version + activeProfile)
~/.wrongstack/profiles/<name>/        profile-scoped settings and state
  config.json                         provider, model, tools, and feature settings
~/.wrongstack/.key                   AES-256-GCM secret-vault key (mode 0600)
~/.wrongstack/profiles/<name>/memory.md  profile memory
~/.wrongstack/profiles/<name>/skills/    profile skills
~/.wrongstack/projects/<hash>/       per-project state
  memory.md                          project memory (auto-gitignored)
  sessions/                          per-session artifacts
    <date>/
      sess_<ULID>.jsonl              append-only event log (messages, tool calls, task_* events)
      sess_<ULID>.summary.json       fast-path manifest read by /sessions
      sess_<ULID>.todos.json         ctx.todos checkpoint (atomic-written on every mutation)
      sess_<ULID>.plan.json          /plan strategic roadmap (atomic-written on every mutation)
      sess_<ULID>/                   multi-agent (director mode) fleet workspace
        fleet.json                   director manifest (debounced ~2s; final on shutdown)
        director-state.json          live task graph: pending/running/completed + spawn roster
        shared/                      cross-subagent scratchpad (markdown findings)
        subagents/<runId>/<subagentId>.jsonl   per-subagent transcripts
        attachments/                 spooled images/files for the session
  trust.json                         per-project tool/permission trust
.wrongstack/AGENTS.md                committable project memory
.wrongstack/skills/                  committable project skills
```

**Resume semantics.** `wstack --resume <id>` replays the messages JSONL into the agent context, reloads the session-scoped todos sidecar if present, and surfaces a banner summarizing any prior plan items and unfinished fleet tasks. Per-subagent transcripts under `subagents/` survive crashes — combine with the `director-state.json` checkpoint to inspect what each worker was doing when the run was interrupted.

API keys are encrypted at rest with AES-256-GCM and the key file at `~/.wrongstack/.key`. The vault auto-bootstraps on first run; the key never leaves the machine.

## Flags

| Flag | Effect |
|------|--------|
| `--tui` / `--no-tui` | Force/disable Ink TUI |
| `--desktop` | Open WrongStack Desktop (also `wstack desktop`) |
| `--webui` | Serve the project WebUI (also `wstack webui`) |
| `--hq` | Start the project-independent HQ dashboard (also `wstack hq`) |
| `--no-menu` | Skip the interactive launch menu (use saved default or TUI/REPL) |
| `--yolo` | Auto-approve tool calls unless explicitly denied |
| `--confirm-destructive` | Deprecated compatibility flag; YOLO no longer prompts by destructiveness |
| `--yolo-destructive` | Deprecated compatibility flag; YOLO no longer prompts by destructiveness |
| `--force-all-yolo` | Deprecated alias for `--yolo-destructive` |
| `--provider <id>` | Override the configured provider |
| `--model <id>` | Override the configured model |
| `--resume <id>` | Resume a saved session by id |
| `--config <path>` | Use a non-default config file |
| `--debug` | Verbose logging to `~/.wrongstack/logs/wrongstack.log` |
| `--version` | Print version |
| `--help` | Print help |

## Environment variables

| Variable | Purpose |
|----------|---------|
| `WRONGSTACK_BASH_ENV_PASSTHROUGH=1` | Disable the bash-tool env allowlist (legacy unsafe mode — see [SECURITY.md](../../SECURITY.md)) |
| `WRONGSTACK_CONFIG_DIR` | Override `~/.wrongstack` location |
| `WRONGSTACK_DEBUG=1` | Same as `--debug` |
| `NO_COLOR=1` | Disable ANSI colors |

Provider API keys can be set via env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) or stored encrypted via `wstack` first-run wizard.

## License

MIT
