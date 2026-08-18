# CLI Reference

Full reference for WrongStack's command-line surface: launch flags, subcommands,
and the `wstack update` self-updater. For slash commands (typed inside a running
session) see [`docs/slash/`](slash/). For every `wstack <subcommand>` see also
[`docs/subcommands/`](subcommands/).

> `wrongstack` and `wstack` are the same binary. Examples below use whichever is
> shorter; they are interchangeable.

---

## Launch flags

| Flag | Effect |
|------|--------|
| `--tui` | Launch the Ink/React full-screen TUI (lazy-loaded). |
| `--webui` | Launch the standalone browser UI + WebSocket bridge. |
| `--simpleui` | Launch the minimal SimpleUI chat surface. |
| `--desktop` | Launch the Electron desktop shell hosting a token-gated local WebUI. |
| `--hq` | Launch the cross-machine HQ Command Center. |
| `--no-menu` | Skip the five-option launch menu on a TTY and go straight to the REPL. |
| `--yolo` | Auto-approve tool calls within the active permission policy (never overrides trust-denies). |
| `--director` | Enable multi-agent Director orchestration. |
| `--provider <id>` / `--model <id>` | Skip the startup picker and pin a provider/model. |
| `-p, --print <query>` | Single-shot: run one query non-interactively and exit. |
| `--resume [id]` | Resume a saved session (prompts for one when omitted). |
| `--token-saving-mode` | Trim the tool surface and prompt to reduce token cost. |
| `--system-pro` | Use `system-pro.md` instead of `system.md` for the baseline system prompt in this launch. Equivalent to `--system-prompt pro`. |
| `--system-lite` | Use the compact `system-lite.md` baseline for this launch. Equivalent to `--system-prompt lite`. |
| `--system-prompt default\|lite\|pro` | Select the baseline system prompt variant for this launch. `default` uses `system.md`; `lite` uses `system-lite.md`; `pro` uses `system-pro.md`, including profile/project instruction overrides. |
| `--no-features` | Boot the minimal kernel — no MCP, plugins, memory tools, models.dev fetch, or skill discovery (fully offline). |

Run `wstack --help` for the authoritative, version-specific flag list.

---

## Subcommands

`wstack <subcommand> [args]`. Common ones:

| Subcommand | Purpose |
|------------|---------|
| `wstack init` | Scaffold project-level `.wrongstack/` config and identity. |
| `wstack auth` | Interactive auth menu (API keys + subscription OAuth sign-in). |
| `wstack sessions` | List, inspect, and resume saved sessions. |
| `wstack config` | Inspect and edit configuration. |
| `wstack models` | Browse the provider/model catalog (paginated). |
| `wstack tools` | List built-in tools. |
| `wstack skills` | List and manage bundled skills. |
| `wstack desktop` | Launch the Electron desktop shell. |
| `wstack project id\|init\|rekey` | Manage the repository-stable `proj_<ULID>` identity. |
| `wstack update` | Update the CLI in place — see below. |
| `wstack version` | Print the installed version. |
| `wstack help` | Print top-level help. |

See [`docs/subcommands/`](subcommands/) for the full per-subcommand reference.

---

## Updating

### One-liner

```bash
# Install (or reinstall) the latest release globally
npm i -g wrongstack

# Then keep it current from inside the tool
wstack update
```

### `wstack update`

`wstack update` detects your global package manager and reinstalls the latest
published `wrongstack` in place. Lifecycle scripts are skipped by default
(`--ignore-scripts`) for safety.

On Windows, `wstack update` ignores project-local package-manager shims and
uses an executable resolved outside the current project. If npm reports a
locked WrongStack native file (`EBUSY`, `EPERM`, or `EACCES`), stop running
WrongStack WebUI, Desktop, and background processes before retrying.

```
Usage: wstack update [--check-only] [--pm npm|pnpm|yarn|bun] [--allow-scripts]
```

| Flag | Effect |
|------|--------|
| `--check-only`, `-c` | Report whether a newer version exists without installing anything. |
| `--pm <manager>` | Force a specific package manager (`npm`, `pnpm`, `yarn`, or `bun`) instead of auto-detecting. |
| `--allow-scripts` | Run package lifecycle scripts during the update (off by default). |

Examples:

```bash
wstack update                 # update via the detected package manager
wstack update --check-only    # is there a newer release?
wstack update --pm pnpm       # force pnpm
```

You can always update manually instead:

```bash
npm i -g wrongstack@latest
# or
pnpm add -g wrongstack@latest
```
