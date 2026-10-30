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
| `--vibeui` | Launch the VibeUI focused coding workspace (default port 3476; `wstack vibeui` is equivalent). |
| `--simpleui` | Retired. SimpleUI was replaced by VibeUI; `--simpleui` and `wstack simpleui` open VibeUI and print a notice. |
| `--full-auto` | Retired with SimpleUI. Accepted but ignored with a warning; use `--yolo` instead. |
| `--hq` | Launch the cross-machine HQ Command Center. |
| `--no-menu` | Skip the launch menu on a TTY and go straight to the REPL. |
| `--yolo` | Auto-approve tool calls within the active permission policy (never overrides trust-denies). |
| `--provider <id>` / `--model <id>` | Skip the startup picker and pin a provider/model. |
| `-p, --print <query>` | Single-shot: run one query non-interactively and exit. |
| `--resume [id]` | Resume a saved session (prompts for one when omitted). |
| `--token-saving-mode` | Trim the tool surface and prompt to reduce token cost. |
| `--system-pro` | Use `system-pro.md` for the baseline system prompt in this launch. Equivalent to `--system-prompt pro`. |
| `--system-lite` | Use the compact `system-lite.md` baseline for this launch. Equivalent to `--system-prompt lite`. |
| `--system-scout` | Use the general-purpose Scout identity (`system-scout.md`) for this launch: a small direct tool set (files, shell, web, todo, memory) with the rest of the catalog reached through `tool_search` / `tool_use`. Equivalent to `--system-prompt scout`. |
| `--system-quick` | Use the minimal Quick identity (`system-quick.md`) for this launch: a very short understand-confirm-do prompt and at most 10 basic tools (read, write, edit, glob, grep, shell, fetch, clarify, nextsteps) plus `tool_search` / `tool_use`, so the rest of the catalog is reached on demand without its schemas entering the context. Equivalent to `--system-prompt quick`. |
| `--system-prompt default\|lite\|pro\|scout\|quick` | Select the baseline system prompt variant for this launch. `default` uses `system.md`; `lite` uses `system-lite.md`; `pro` uses `system-pro.md`; `scout` uses `system-scout.md` and the Scout tool surface; `quick` uses `system-quick.md` and the Quick tool surface, including profile/project instruction overrides. |
| `--host-profile` | Use the saved profile prompt instead of the CLI Quick default. In headless single-shot runs, also retain the profile's tool-coach setting. |

CLI sessions (TUI, REPL, and single-shot) select Quick immediately when no
`--system-*` variant is supplied, skipping the startup system-prompt picker.
Use `--host-profile` to reuse the saved profile selection. This launch default
does not overwrite the profile's `systemPrompt.variant`; WebUI, VibeUI, HQ, and
utility subcommands keep their existing defaults. Machine-driven single-shot
runs also disable the tool coach unless `--host-profile` is supplied.

SimpleUI was retired and replaced by VibeUI; `wstack simpleui` / `--simpleui` now open VibeUI.
`--full-auto` (formerly SimpleUI-only YOLO + autonomy for one run) is ignored;
use `--yolo`.

Director is always available. Use `/spawn`, `/fleet`, `/delegate`, or `/goal`;
`--director` and `--no-director` are no longer accepted.

Run `wstack --help` for the authoritative, version-specific flag list.

TUI startup keeps routine console logs, HQ connection warnings, and dependency
warnings off the screen, including `quick` and TUI selection from the launch
menu. Diagnostics follow the configured log level in `wrongstack.log`.
Startup errors and selection prompts stay visible. Choosing REPL preserves
normal console diagnostics.

---

## Subcommands

`wstack <subcommand> [args]`. Common ones:

| Subcommand | Purpose |
|------------|---------|
| `wstack init` | Deprecated compatibility command; prints guidance to `wstack auth` without writing project files. |
| `wstack auth` | Interactive auth menu (API keys + subscription OAuth sign-in). |
| `wstack sessions` | List, inspect, and resume saved sessions. |
| `wstack config` | Inspect and edit configuration. |
| `wstack models` | Browse the provider/model catalog (paginated). |
| `wstack tools` | List built-in tools. |
| `wstack skills` | List and manage bundled skills. |
| `wstack project id\|init\|rekey` | Manage the repository-stable `proj_<ULID>` identity. |
| `wstack update` | Update the CLI in place — see below. |
| `wstack version` | Print the installed version. |
| `wstack help` | Print top-level help. |

See [`docs/subcommands/`](subcommands/) for the full per-subcommand reference.

---

## Updating

### One-liner

WrongStack ships as a standalone binary through GitHub Releases:

```bash
# macOS / Linux — install (or reinstall) the latest release
curl -fsSL https://wrongstack.com/install.sh | sh
```

```powershell
# Windows
irm https://wrongstack.com/install.ps1 | iex
```

Then keep it current from inside the tool with `wstack update`.

The npm packages are legacy. The installer uninstalls old `wrongstack` /
`@wrongstack/cli` globals from npm, pnpm, yarn or bun (asking first on a
terminal) so they cannot shadow the binary.

### `wstack update`

`wstack update` downloads the latest GitHub release for your platform, verifies
it against the release `SHA256SUMS` and swaps the executable in place.

Legacy package installations print a warning, install the GitHub Releases binary,
verify it runs, then uninstall old global `wrongstack` / `@wrongstack/cli` packages
from npm, pnpm, yarn and Bun. This migration also runs when the package version
is already current. Open a new terminal afterward to pick up the binary's PATH.

```
Usage: wstack update [--check-only]
```

| Flag | Effect |
|------|--------|
| `--check-only`, `-c` | Report whether a newer version exists without installing anything. |
| Legacy `--pm`, `--package-manager`, `--npm`, `--pnpm`, `--yarn`, `--bun` | Ignored with a warning; updates always use GitHub Releases. |
| Legacy `--allow-scripts`, `--lifecycle-scripts` | Ignored with a warning; cannot enable a package update. |

Examples:

```bash
wstack update                         # download + verify the latest release
wstack update --check-only            # is there a newer release?
```

You can always update manually by re-running the install one-liner.
