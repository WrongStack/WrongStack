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
wstack auth login copilot
wstack auth login openrouter
wstack auth login antigravity
wstack auth login xai
wstack auth login kimi
wstack auth login meta
wstack auth login chatgpt-api
```

For account sign-ins, model choices come from the signed-in account's live
catalog. Cached choices are scoped to that account; no hardcoded model names
or generic API-provider lists are substituted when discovery is unavailable.

Accepted login aliases are:

- ChatGPT/Codex: `chatgpt`, `openai`, `codex`, `codex-cli`, `openai-codex`, `chatgpt-plus`, `plus`, `pro`.
- GitHub Copilot: `copilot`, `github`, `github-copilot`, `gh`.
- OpenRouter: `openrouter`, `openrouter-login`, `openrouter-oauth`.
- xAI/Grok: `xai`, `grok`, `xai-oauth`.
- Kimi Code: `kimi`, `kimi-code`, `kimi-coding`, `kimi-for-coding`.
- Meta: `meta`, `muse`, `meta-oauth`.
- ChatGPT plan API: `chatgpt-api`, `chatgpt-direct`, `openai-chatgpt`. This uses
  public Responses with a separate grant; `chatgpt` still means legacy Codex.

Claude has no sign-in: `claude`, `anthropic`, `claude-pro`, `claude-max`,
`anthropic-oauth` and `max` print how to add an Anthropic API key instead (on
Max/Team, link a Console organization first for the monthly API credits). See
[oauth-signin.md](../oauth-signin.md#claude-no-sign-in-use-an-api-key).

All four new flows use the existing account aliases, vault, TUI picker, and WebUI
settings. See [OAuth sign-in](../oauth-signin.md) for endpoints and renewal behavior.

### Import from an HQ key vault
```
wstack auth import --from hq [profile-id …]
```
Imports the provider profiles HQ grants this machine (all, or the given profile ids) into the active
profile. Enroll first with `wstack hq enroll <hq-url> <token>`. See the
[HQ key vault](hq.md#key-vault) for what is imported, how `wstack hq sync` keeps it in step,
and why a provider entered here is never overwritten.

### Direct (flag-based)
```
wstack auth <provider-id>
wstack auth <provider-id> --label <name> --family <family> --base-url <url>
wstack auth openai --alias personal-account
wstack auth openai --alias work-account
wstack auth login chatgpt --alias work-chatgpt
wstack auth local --name ollama --alias local-work --no-probe
```

### In-session slash command
```
/auth                    # List saved providers and key status
/auth status <provider>   # Detailed view of one provider
/auth open               # Show how to launch the interactive menu
/auth help               # Usage reference
```
Non-blocking — works under both the plain REPL and the Ink TUI.

An auth profile is a saved account alias. Its `type` is the canonical provider
used for transport/catalog lookup; its key and model settings belong to that
account. `--alias` creates a separate API-key profile and refuses an existing
alias. OAuth uses the alias for sign-in or explicit re-authentication. Without
`--alias`, direct key additions retain the existing multi-key behavior.

Fallback entries select `<auth-profile-alias>/<model-id>`, so the same model on
`personal-account` and `work-account` is two independent targets. A named
`fallbackProfile` is an ordered chain of these targets, not an account.

## Flags

| Flag | Effect |
|---|---|
| `--alias` | Account/auth profile alias (API key, OAuth login, or local preset) |
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
| `h` | Import from HQ — providers the HQ key vault grants this machine (enrolls first if needed) |
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
| `a` | Add a model (manual entry with catalog reference values shown, catalog prefill when available) |
| `x` on a model | Remove model (with confirmation) |
| `r` on a model | Reset to catalog values (drops overrides, restores models.dev defaults) |

## How credentials are stored

1. Prompt for API key (masked input, paste-safe)
2. Encrypt with `DefaultSecretVault` using `~/.wrongstack/.key`
3. Write atomically to the active profile config under `providers.<id>`

Keys are encrypted at rest using AES-256-GCM. The vault intentionally does not defeat a determined local attacker who can read both the config file and the key file — that level of secrecy needs the OS keychain.

Set `WRONGSTACK_VAULT_PASSPHRASE` to wrap the key file itself: the data key is then stored AES-256-GCM-encrypted under a key-encryption-key (KEK) derived from the passphrase with scrypt. Without the passphrase, the vault cannot decrypt any stored secret.

## Code structure

```
packages/cli/src/auth-menu/         # Modular auth menu implementation
  types.ts          — AuthMenuDeps interface
  shared.ts         — Rendering helpers, key input, confirmations, validation
  top-menu.ts       — Main menu loop
  provider-menu.ts  — Provider detail submenu
  add-provider.ts   — Catalog + custom provider addition flows
  direct.ts         — One-shot `wstack auth <provider>` flow
  panel-service.ts  — TUI /auth panel host implementation
  oauth-menu.ts     — OAuth kind resolution (aliases, 1/2/3 picks)
  local.ts          — Local-LLM presets (OmniRoute / Ollama / vLLM / LM Studio)
  local-presets.ts  — Local preset table
  loopback-server.ts — OAuth loopback listener
  openai-codex-oauth.ts / github-copilot-oauth.ts — per-kind OAuth flows
  auth-menu-audit.ts — Auth menu audit logging
  helpers.ts        — Config I/O wrappers
  index.ts          — Public API re-exports

packages/cli/src/auth-menu/index.ts # Auth-menu entry point
packages/cli/src/slash-commands/auth.ts  # /auth slash command
packages/cli/src/subcommands/handlers/auth.ts  # Subcommand handler
packages/cli/src/provider-config-utils.ts  # Shared config I/O + normalization
```
