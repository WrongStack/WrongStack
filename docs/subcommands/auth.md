# `wstack auth` — API Key Management

## What it does

Manages provider API credentials. Supports interactive menu, quick listing, and flag-based scripted use. Also available as a slash command (`/auth`) during active sessions.

## Usage modes

### Interactive menu
```
wstack auth
```
Opens the full interactive key manager: browse catalog providers, add custom entries, manage keys, set active key, edit family/baseUrl/models.

### Quick listing
```
wstack auth list
wstack auth ls
```
Prints all saved providers with their keys (masked), active indicators, families, and base URLs. No prompt — read-only, safe for scripts and CI.

### Status and removal

```text
wstack auth status <provider-id>
wstack auth remove <provider-id>
wstack auth rm <provider-id>
```

`status` is read-only. `remove`/`rm` asks for confirmation before deleting the provider and all of its saved keys.

### Subscription OAuth login

```text
wstack auth login chatgpt
wstack auth login claude
wstack auth login copilot
```

Accepted login aliases are:

- ChatGPT/Codex: omitted id, `openai`, `codex`, `chatgpt`, `codex-cli`, `openai-codex`.
- Claude: `claude`, `anthropic`, `claude-pro`, `claude-max`, `anthropic-oauth`.
- GitHub Copilot: `copilot`, `github`, `github-copilot`, `gh`.

### Direct (flag-based)
```
wstack auth <provider-id>
wstack auth <provider-id> --label <name> --family <family> --base-url <url>
```

### In-session slash command
```
/auth                    # List saved providers and key status
/auth status <provider>   # Detailed view of one provider
/auth open               # Show how to launch the interactive menu
/auth help               # Usage reference
```
Non-blocking — works under both the plain REPL and the Ink TUI.

## Flags (direct mode only)

| Flag | Effect |
|---|---|
| `--label` | Human label for this credential set (default: "default") |
| `--family` | Provider family: `anthropic`, `openai`, `openai-compatible`, `google` |
| `--base-url` | Custom API base URL |
| `--env` | Comma-separated env vars to check (e.g. `ANTHROPIC_API_KEY`) |

## Interactive menu keys

### Top level
| Key | Action |
|-----|--------|
| `a` | Add a provider from the models.dev catalog |
| `c` | Add a custom provider (bypass catalog) |
| `1`-`N` | Manage a saved provider |
| `q` | Quit |

### Provider submenu

| Key | Action |
|-----|--------|
| `a` | Add another key |
| `u <n>` | Update key `<n>` |
| `d <n>` | Delete key `<n>` (with confirmation) |
| `s <n>` | Set key `<n>` as active |
| `f` | Edit wire family |
| `B` | Edit base URL |
| `m` | Edit visible model list (comma-separated bulk edit) |
| `x` | Remove this provider entirely (with confirmation) |
| `b` | Back to top menu |
| `q` | Quit |

### TUI `/auth` panel — model editing

The in-session TUI panel (`/auth` in the Ink TUI) adds model-level editing on top of the CLI menu. These actions exist only in the TUI panel, not in the `wstack auth` CLI menu:

| Key | Action |
|-----|--------|
| `Enter` on a model | Edit model details (limits, cost, modalities, capabilities, dates) |
| `a` | Add a model (from catalog search, with manual fallback) |
| `x` on a model | Remove model (with confirmation) |
| `r` on a model | Reset to catalog values (drops overrides, restores models.dev defaults) |

## How credentials are stored

1. Prompt for API key (masked input, paste-safe)
2. Encrypt with `DefaultSecretVault` using `~/.wrongstack/.key`
3. Write atomically to the active profile config under `providers.<id>`

Keys are encrypted at rest using AES-256-GCM. The vault intentionally does not defeat a determined local attacker who can read both the config file and the key file — that level of secrecy needs the OS keychain.

## Code structure

```
packages/cli/src/auth-menu/         # Modular auth menu implementation
  types.ts         — AuthMenuDeps interface
  shared.ts        — Rendering helpers, key input, confirmations, validation
  top-menu.ts      — Main menu loop
  provider-menu.ts — Provider detail submenu
  add-provider.ts  — Catalog + custom provider addition flows
  direct.ts        — One-shot `wstack auth <provider>` flow
  helpers.ts       — Config I/O wrappers
  index.ts         — Public API re-exports

packages/cli/src/auth-menu.ts       # Backward-compatible re-export shim
packages/cli/src/slash-commands/auth.ts  # /auth slash command
packages/cli/src/subcommands/handlers/auth.ts  # Subcommand handler
packages/cli/src/provider-config-utils.ts  # Shared config I/O + normalization
```
