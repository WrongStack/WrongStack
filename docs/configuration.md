# Configuration Reference

WrongStack uses a layered configuration system. Settings are merged from multiple sources with a clear precedence order.

---

## Config file locations

| Layer | Path | Purpose |
|---|---|---|
| Global | `~/.wrongstack/config.json` | Developer-level defaults (provider, keys, features) |
| Project-private | `~/.wrongstack/projects/<slug>/config.local.json` | Project overrides outside the repo (not committed) |
| In-project | `<project>/.wrongstack/config.json` | Repo-local safe preferences only; unsafe fields are stripped before merge |
| CLI flags | `--provider`, `--model`, `--yolo`, etc. | Session-scoped overrides |

**Precedence** (highest wins): CLI flags → extra config sources → env vars → in-project → project-private → global → built-in defaults.

---

## Full config schema

```jsonc
{
  "version": 1,
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "apiKey": "enc:v1:<iv>:<tag>:<ciphertext>",
  "baseUrl": "https://api.anthropic.com",
  "providers": { /* ... */ },
  "context": { /* ... */ },
  "tools": { /* ... */ },
  "mcpServers": { /* ... */ },
  "plugins": [],
  "log": { /* ... */ },
  "features": { /* ... */ },
  "yolo": false,
  "cwd": ".",
  "extensions": { /* ... */ }
}
```

---

## Top-level fields

| Field | Type | Default | Description |
|---|---|---|---|
| `version` | `1` | `1` | Config schema version. Must be `1`. |
| `provider` | `string` | *(required)* | Active provider id (e.g. `anthropic`, `openai`, `groq`). |
| `model` | `string` | *(required)* | Active model id (e.g. `claude-opus-4-7`, `gpt-4.1`). |
| `apiKey` | `string` | — | API key for the active provider. Auto-encrypted on first contact. |
| `baseUrl` | `string` | — | Custom API base URL. Overrides the provider's default endpoint. |
| `yolo` | `boolean` | `false` | Auto-approve normal project work. Clearly destructive calls may still prompt unless `--yolo-destructive` is used. Overridden by `--yolo` CLI flag. |
| `fallbackModels` | `string[]` | — | Ordered fallback chain tried when the primary model is overloaded (429/529/5xx) and its own retries are exhausted. Each entry is `model`, `provider/model`, or `provider model`. Cross-provider. The primary is re-tried first each turn. Overridden by `--fallback-model a,b,c`. |
| `hooks` | `object` | — | Lifecycle shell hooks keyed by event. See [`hooks`](#hooks--lifecycle-hooks) below and [hooks.md](./hooks.md). |
| `cwd` | `string` | `process.cwd()` | Working directory. Overridden by `--cwd` CLI flag. |

---

## `providers` — Per-provider configuration

A map of provider id → provider config. Each entry can declare its own API key, base URL, model, and quirks.

```jsonc
{
  "providers": {
    "anthropic": {
      "type": "anthropic",
      "apiKey": "enc:v1:...",
      "model": "claude-opus-4-7"
    },
    "groq": {
      "type": "openai-compatible",
      "apiKey": "enc:v1:...",
      "baseUrl": "https://api.groq.com/openai/v1",
      "model": "llama-3.3-70b-versatile"
    },
    "ollama": {
      "type": "openai-compatible",
      "baseUrl": "http://localhost:11434/v1",
      "family": "openai-compatible"
    }
  }
}
```

### ProviderConfig fields

| Field | Type | Default | Description |
|---|---|---|---|
| `type` | `string` | — | Provider type (usually matches the wire family). |
| `apiKey` | `string` | — | API key. Auto-encrypted. Falls back to `<PROVIDER>_API_KEY` env var. |
| `apiKeys` | `ProviderApiKey[]` | — | Multiple keys with labels. Pick one with `activeKey`. |
| `activeKey` | `string` | first entry | Label of the key to use from `apiKeys`. |
| `baseUrl` | `string` | provider default | Custom API endpoint. |
| `headers` | `Record<string, string>` | — | Extra HTTP headers sent with every request. |
| `model` | `string` | — | Default model for this provider. |
| `family` | `string` | auto-detected | Wire family override (`anthropic`, `openai`, `openai-compatible`, `google`). Required for offline/custom endpoints. |
| `envVars` | `string[]` | provider default | Custom env var names to probe for API keys. |
| `models` | `string[]` | — | Restrict visible models for this provider. |
| `quirks` | `Record<string, unknown>` | — | Provider-specific behavior flags. See provider-author-guide.md. |
| `capabilities` | `Record<string, unknown>` | — | Override reported capabilities (e.g. `maxContext`, `vision`). |

---

## `context` — Context window management

Controls compaction behavior, token thresholds, and context window modes.

```jsonc
{
  "context": {
    "mode": "balanced",
    "warnThreshold": 0.6,
    "softThreshold": 0.75,
    "hardThreshold": 0.9,
    "autoCompact": true,
    "preserveK": 10,
    "eliseThreshold": 2000,
    "strategy": "hybrid",
    "llmSelector": false,
    "effectiveMaxContext": 200000,
    "maxSessionTokens": 1000000,
    "maxDailyTokens": 5000000
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `mode` | `string` | `"balanced"` | Context window policy. One of: `balanced`, `frugal`, `deep`, `archival`. Switch at runtime with `/context mode`. |
| `warnThreshold` | `number` | `0.6` | Fraction of context window that triggers a warning. Runtime override: `/context thresholds`. |
| `softThreshold` | `number` | `0.75` | Fraction that triggers soft compaction. Runtime override: `/context thresholds`. |
| `hardThreshold` | `number` | `0.9` | Fraction that triggers aggressive compaction and hard-overflow protection. Runtime override: `/context thresholds`. |
| `autoCompact` | `boolean` | `true` | Automatically compact when thresholds are crossed. |
| `preserveK` | `number` | `10` | Number of recent message pairs to preserve during compaction. |
| `eliseThreshold` | `number` | `2000` | Token count above which old tool results are elided (a token count, not a fraction). |
| `strategy` | `string` | `"hybrid"` | Compaction strategy. `hybrid` (default) is **lossless rule-based, no LLM** — it elides oversized old tool results and collapses ancient turns into a digest that keeps all text and drops only raw tool I/O (still in the session log). `intelligent` adds LLM summarization (needs a provider; falls back to the lossless digest on failure). `selective` adds LLM-driven keep/collapse selection. |
| `llmSelector` | `boolean` | `false` | Shortcut for `strategy: "selective"` when `strategy` is unset. An explicit `strategy` wins. |
| `effectiveMaxContext` | `number` | provider-reported or unknown for custom `baseUrl` | Override the effective context window size in tokens. Use this for proxies/account-gated endpoints whose real limit differs from models.dev. Runtime override: `/context limit`. |
| `maxSessionTokens` | `number` | — | Maximum tokens per session. |
| `maxDailyTokens` | `number` | — | Maximum tokens per day. |
| `summarizerModel` | `string` | active model | Model used for LLM-assisted summarization. |

### Context modes

| Mode | Behavior |
|---|---|
| `balanced` | Default rolling compaction; preserves recent tail, trims old heavy tool output. |
| `frugal` | Token-saver; compacts early, keeps a tighter verbatim tail. |
| `deep` | Long-reasoning; delays compaction, keeps more recent turns intact. |
| `archival` | Decision-preserving; compacts steadily, keeps summaries prominent. |

---

## `tools` — Tool execution settings

```jsonc
{
  "tools": {
    "defaultExecutionStrategy": "smart",
    "maxIterations": 100,
    "iterationTimeoutMs": 300000,
    "sessionTimeoutMs": 1800000,
    "perIterationOutputCapBytes": 1048576,
    "autoExtendLimit": true
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `defaultExecutionStrategy` | `string` | `"smart"` | `parallel` (all at once), `sequential` (one by one), `smart` (auto). |
| `maxIterations` | `number` | `100` | Soft limit on agent loop iterations. Auto-extends when `autoExtendLimit` is true. |
| `iterationTimeoutMs` | `number` | `300000` | Per-iteration timeout (5 minutes). |
| `sessionTimeoutMs` | `number` | `1800000` | Total session timeout (30 minutes). |
| `perIterationOutputCapBytes` | `number` | `1048576` | Max output bytes per iteration (1 MB). Excess is truncated. |
| `autoExtendLimit` | `boolean` | `true` | Automatically extend iteration limit by 100 when hit. |

---

## `mcpServers` — MCP server configuration

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "enabled": true,
      "allowedTools": ["read_file", "write_file", "list_directory"],
      "permission": "confirm"
    },
    "github": {
      "name": "github",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "enc:v1:..."
      },
      "enabled": false
    }
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | *(required)* | Server name. Used in tool namespace: `mcp__<name>__<tool>`. |
| `transport` | `string` | *(required)* | `stdio`, `sse`, or `streamable-http`. |
| `command` | `string` | — | Command to spawn (stdio transport). |
| `args` | `string[]` | — | Arguments for the command. |
| `env` | `Record<string, string>` | — | Environment variables for the subprocess. API keys auto-encrypted. |
| `url` | `string` | — | Server URL (sse/streamable-http transport). |
| `headers` | `Record<string, string>` | — | Extra HTTP headers (sse/streamable-http transport). |
| `enabled` | `boolean` | `false` | Whether to connect at startup. |
| `allowedTools` | `string[]` | all tools | Restrict which tools are registered. |
| `permission` | `string` | `"confirm"` | Default permission for MCP tools: `auto`, `confirm`, `deny`. |
| `startupTimeoutMs` | `number` | `10000` | Timeout for initial connection. |
| `requestTimeoutMs` | `number` | `60000` | Timeout for individual tool calls. |
| `tls.ca` | `string` | — | Path to CA certificate file (HTTPS transports). |
| `tls.rejectUnauthorized` | `boolean` | `true` | Verify server certificate (set `false` for self-signed). |

### Built-in presets

WrongStack ships with a set of built-in MCP server presets. Use
`wrongstack mcp add <name>` to add one to your config:

| Preset | Description | Default `permission` | Auto-enabled? |
|---|---|---|---|
| `filesystem` | Read/write/navigate local filesystem | `confirm` | No |
| `github` | GitHub API — issues, PRs, repos, search | `confirm` | No |
| `context7` | Codebase-aware documentation (context7.ai) | `confirm` | No |
| `brave-search` | Web search (requires `BRAVE_SEARCH_API_KEY`) | `confirm` | No |
| `block` | Postgres database access via SQL | `confirm` | No |
| `everart` | AI image generation | `confirm` | No |
| `slack` | Slack messaging, channels, search | `confirm` | No |
| `aws` | EC2, S3, Lambda, IAM, CloudFormation | `confirm` | No |
| `google-maps` | Directions, geocoding, places | `confirm` | No |
| `sentinel` | Security vulnerability scanning | `deny` | No |
| `zai-vision` | Image analysis, screenshot understanding | `auto` | No |
| `minimax-vision` | MiniMax image understanding (read-only) | `auto` | No |
| **`playwright`** | Browser automation — navigate, screenshot, click, type, evaluate JS | `confirm` | No |
| **`ssh`** | Remote SSH — execute commands, transfer files, tunnels, health checks | `confirm` | No |

Playwright and SSH are opt-in presets. Add and enable only the MCP servers you
want available in a session.

SSH requires the `mcp-ssh-manager` host configuration. After adding the preset,
set your server credentials in `~/.ssh-manager/.env`:

```env
SSH_SERVER_PRODUCTION_HOST=prod.example.com
SSH_SERVER_PRODUCTION_USER=deploy
SSH_SERVER_PRODUCTION_KEYPATH=~/.ssh/prod_deploy
```

Then enable it:
```bash
wrongstack mcp add ssh
/mcp enable ssh
```

For the full preset reference and usage, see [subcommands/mcp.md](subcommands/mcp.md).

---

## `fallbackModels` — Overload fallback chain

When the active model returns an overload error (HTTP 429/529/5xx) and its own
retry policy is exhausted, the agent switches to the next entry in this list and
retries the same turn. Entries may cross providers. The configured primary is
always tried first at the start of every new turn.

```jsonc
{
  "provider": "anthropic",
  "model": "claude-opus-4-8",
  "fallbackModels": [
    "claude-sonnet-4-6",      // same provider, bare model id
    "openai/gpt-5.4",         // cross-provider (provider must have credentials)
    "groq llama-3.3-70b-versatile"
  ]
}
```

CLI override (comma-separated): `wrongstack --fallback-model "claude-sonnet-4-6,openai/gpt-5.4"`.

A fallback entry whose provider has no resolvable credentials is skipped (with a
warning) and the chain continues. Each switch emits a `provider.fallback` event.

---

## `hooks` — Lifecycle hooks

Shell commands run at lifecycle points (`PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, `SessionStart`, `Stop`). The hook payload is written to the
command's stdin as JSON; a JSON `HookOutcome` on stdout (or exit code `2`)
steers the agent. `PreToolUse`/`PostToolUse` entries take a `matcher` (a
pipe-delimited tool-name list, or `*`).

```jsonc
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "bash", "command": "./scripts/guard-bash.sh", "timeoutMs": 3000 }
    ],
    "PostToolUse": [
      { "matcher": "edit|write", "command": "npm run -s lint:staged" }
    ],
    "UserPromptSubmit": [
      { "command": "./scripts/inject-context.sh" }
    ]
  }
}
```

Disable all hooks for a session with `--no-hooks`. Plugins can register
in-process hooks via `api.registerHook(...)`. See [hooks.md](./hooks.md) for the
full payload/outcome schema and the security model.

---

## `features` — Feature flags

```jsonc
{
  "features": {
    "mcp": true,
    "plugins": true,
    "memory": true,
    "modelsRegistry": true,
    "skills": true,
    "tokenSavingMode": "off"
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `mcp` | `boolean` | `true` | Load MCP servers declared in `mcpServers`. |
| `plugins` | `boolean` | `true` | Load npm plugins declared in `plugins`. |
| `memory` | `boolean` | `true` | Register `remember`/`forget` tools backed by memory store. |
| `modelsRegistry` | `boolean` | `true` | Fetch models.dev catalog at startup. Set `false` for offline use. |
| `skills` | `boolean` | `true` | Discover and load skills from disk. |
| `tokenSavingMode` | `TokenSavingTier` | `"off"` | Token-saving level for the system prompt. Controls tool count, description length, and guidance sections. |

### Token-saving tiers

`tokenSavingMode` replaces the old boolean `--token-saving-mode` flag with a multi-level system:

| Tier | Tools | Tool descriptions | Measured savings |
|------|-------|-----------------|------------------|
| `off` | All 37 | 80 chars | 0 tokens (baseline) |
| `minimal` | 10 (TIER1 only) | 40 chars | ~2.5–2.7k tokens |
| `light` | 10 (TIER1 only) | 50 chars | ~2.3–2.4k tokens |
| `medium` | 25 (TIER1 + TIER2) | 60 chars | ~1.4–1.5k tokens |
| `aggressive` | 35 (TIER1 + TIER2 − task + TIER3 − setWorkingDir) | 70 chars | ~1.0k tokens |

The five tiers optimize along two different axes; pick the one that matches
your use case rather than reading "savings" as monotonic:

- **Fewer tools + lots of guidance trimmed** — `minimal` (~2.5k saved), `light` (~2.4k saved). TIER1 only (10 tools). Best for single-file edits, quick fixes, and tasks where the model already knows everything it needs.
- **Fewer tools + full guidance** — `medium` (~1.4k saved). TIER1+TIER2 (25 tools). Best for standard development where the model benefits from explicit delegation/mailbox guidance.
- **Many tools + compact guidance** — `aggressive` (~1k saved). TIER1+TIER2+most-TIER3 (35 tools). Best when the task needs a wider tool surface (lint/test/install/etc.) but prompt real estate is tight. Context Management and Commit Hygiene remain at full because they're most useful under context pressure.

The original design doc estimated "~4-5k tokens saved at `aggressive`", but
that estimate assumed a much smaller tool set (~22 tools). The current
implementation keeps the wider tool set on purpose — dropping more tools at
`aggressive` would make it indistinguishable from a stricter version of
`medium`. The savings estimates above are empirical, measured by
`packages/cli/tests/token-saving-measurement.test.ts`.

Memory tools (`remember`, `forget`, `searchMemory`, `relatedMemory`) are gated on
`features.memory`, not on the tier — they appear at every tier when memory is enabled
and at no tier when it is disabled.

CLI flags:
- `--token-saving-tier minimal` — set tier directly
- `--token-saving-mode` — still works, maps to `medium` tier (backward compatible)
- `--token-saving-tier off` — disable (same as omitting the flag)

In the TUI, use `/settings` and navigate to the **Token Saving** row. Press `←`/`→` to cycle through tiers. A `↻ Takes effect next session` hint appears because the setting requires a restart.

**Deprecated:** `true`/`false` boolean values for `tokenSavingMode` are still accepted and mapped: `true` → `"medium"`, `false` → `"off"`.

All flags are independent. `--no-features` sets all to `false`.

---

## `plugins` — Plugin configuration

```jsonc
{
  "plugins": [
    "@wrongstack/telegram",
    "@wrongstack/plug-lsp",
    {
      "name": "@yourorg/custom-plugin",
      "enabled": true,
      "options": {
        "port": 9090
      }
    }
  ]
}
```

Each entry is either a string (package name, always enabled) or an object:

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | *(required)* | npm package name or local path. |
| `enabled` | `boolean` | `true` | Whether to load the plugin. |
| `options` | `Record<string, unknown>` | — | Plugin-specific configuration. Validated against `configSchema` if declared. |

---

## `log` — Logging

```jsonc
{
  "log": {
    "level": "info",
    "file": "~/.wrongstack/logs/wrongstack.log"
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `level` | `string` | `"info"` | Log level: `error`, `warn`, `info`, `debug`, `trace`. |
| `file` | `string` | auto | Log file path. Defaults to `~/.wrongstack/logs/wrongstack.log`. |

Override with `--verbose` (`debug`), `--trace` (`trace`), or `--log-level <level>`.

---

## `session` — Session logging & audit trail

Controls what gets persisted to the per-project session JSONL file
(`~/.wrongstack/projects/<hash>/sessions/<date>/sess_<ULID>.jsonl`).

```jsonc
{
  "session": {
    "auditLevel": "standard",
    "sampling": {
      "toolProgress": {
        "sampleRate": 8
      }
    }
  }
}
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `auditLevel` | `"minimal"` \| `"standard"` \| `"full"` | `"standard"` | How much detail is written to the persistent session log. |
| `sampling.toolProgress.sampleRate` | `number` | `8` | Sampling rate for high-volume `tool_progress` events (`log` / `partial_output`). `1` = no sampling. Only applies when `auditLevel` is `"full"`. |

### `auditLevel` values

- **minimal** — Only the absolute minimum required for resume, rewind and crash recovery (`user_input`, `llm_response`, `tool_result`, checkpoints, in-flight markers).
- **standard** (recommended) — Adds high-value lightweight audit events: `llm_request` (light), `tool_call_start`/`tool_call_end`, `compaction`, `error`, etc.
- **full** — Enables high-volume events such as `tool_progress` (streaming tool output). These events are heavily sampled by default to avoid log bloat.

### Sampling

When `auditLevel` is `"full"`, certain events (especially `tool_progress`) can generate thousands of lines. WrongStack applies smart sampling:

- `warning`, `metric`, `file_changed` → always recorded.
- `log` and `partial_output` → first message is kept, then every Nth message (controlled by `sampleRate`).

You can increase verbosity for debugging:

```jsonc
{
  "session": {
    "auditLevel": "full",
    "sampling": {
      "toolProgress": {
        "sampleRate": 2   // very chatty
      }
    }
  }
}
```

---

## `extensions` — Per-plugin config namespaces

```jsonc
{
  "extensions": {
    "wstack-auth": {
      "tokenUrl": "https://auth.example.com/token",
      "refreshBefore": 300
    },
    "wstack-metrics": {
      "sink": "prometheus",
      "port": 9090
    }
  }
}
```

Each key is a plugin name. The value is a free-form object validated by the plugin's `configSchema`. Plugins read their namespace via `configStore.getExtension(pluginName)`.

---

## Environment variables

| Variable | Description |
|---|---|
| `<PROVIDER>_API_KEY` | API key for the provider (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). |
| `WRONGSTACK_LOG_LEVEL` | Override log level (`error`, `warn`, `info`, `debug`, `trace`). |
| `WRONGSTACK_FETCH_ALLOW_PRIVATE` | Set `1` to allow localhost/private IPs in the `fetch` tool. |
| `WRONGSTACK_BASH_ENV_PASSTHROUGH` | Set `1` to disable the bash-tool env allowlist (legacy unsafe mode). |
| `WRONGSTACK_CHILD_ENV_PASSTHROUGH` | Set `1` to opt back to old child-process env behavior. |
| `WRONGSTACK_SHELL` | Windows only. Force the shell the `bash` tool uses: `cmd`/`cmd.exe`, `powershell`/`powershell.exe`, or `pwsh`/`pwsh.exe`. When unset, WrongStack pins one shell for the session at boot — **PowerShell by default** (pwsh 7+ if present, else Windows PowerShell 5.1) — and tells the model to write that shell's syntax. Set `WRONGSTACK_SHELL=cmd` to opt back into cmd.exe. See [Windows shell selection](#windows-shell-selection-wrongstack_shell). |
| `WRONGSTACK_INDEX_QUESTION_THRESHOLD` | File-count threshold for the "Run codebase indexing now?" pre-launch prompt. Default `500`. Set to a high number to suppress the question. |
| `WRONGSTACK_HQ_URL` | HQ command center URL for telemetry publishing (e.g. `http://localhost:3499`). When set, TUI/REPL/WebUI/CLI hosts connect to this HQ and publish mailbox events, fleet snapshots, and client lifecycle telemetry. See [HQ Command Center Plan](./plans/hq-command-center-2026-06.md). |
| `WRONGSTACK_HQ_TOKEN` | Client enrollment token for HQ authentication. Required for non-loopback HQ servers. Passed as `?token=` on the outbound `/ws/client` WebSocket. |
| `WRONGSTACK_HQ_ENABLED` | Set `1` to force HQ publishing even when `WRONGSTACK_HQ_URL` is unset (defaults to `http://localhost:3499`). Set `0` to explicitly disable when `WRONGSTACK_HQ_URL` is set. |
| `WRONGSTACK_HQ_RAW_CONTENT` | Set `1` to opt into sending raw prompt/tool/mailbox content to HQ. **Off by default** — HQ telemetry redacts raw bodies, file contents, and full tool args unless this is enabled. Only use with trusted HQ servers. |
| `WRONGSTACK_HQ_PROJECT_ALIAS` | Override the project display name sent to HQ (e.g. `monorepo-core` instead of the directory basename). |
| `METRICS_HOST` | Prometheus metrics bind address (default `127.0.0.1`). |
| `NO_COLOR` | Disable ANSI color output. |

### HQ command center

The HQ command center (`wstack --hq`) is a project-independent observability layer. See the full architecture and deployment guide in [plans/hq-command-center-2026-06.md](./plans/hq-command-center-2026-06.md).

**Start HQ:**

```bash
wstack --hq                      # localhost:3499
wstack --hq --host 0.0.0.0       # LAN access
wstack --hq --port 8080 --open   # custom port + open browser
```

**Connect clients to HQ:**

```bash
# All clients (TUI, REPL, WebUI) auto-publish telemetry when HQ_URL is set:
export WRONGSTACK_HQ_URL=http://localhost:3499
export WRONGSTACK_HQ_TOKEN=<enrollment-token>   # required for remote HQ
wstack

# Override project display name:
export WRONGSTACK_HQ_PROJECT_ALIAS=my-project
```

**Defaults:** when `WRONGSTACK_HQ_URL` is unset, no publisher is created and hosts run normally with zero overhead. Mailbox send/ack/register/heartbeat events are the primary telemetry source. Raw message bodies and file contents are never sent unless `WRONGSTACK_HQ_RAW_CONTENT=1`.

### Windows shell selection (`WRONGSTACK_SHELL`)

The `bash` tool historically ran everything through `cmd.exe` on Windows. That works for `echo`, `dir`, `set`, and other internal commands, but fails on PowerShell cmdlets (`Get-Content`, `Set-Location`, …) with "'Get-Content' is not recognized as an internal or external command." It also left a gap: the model was never told which shell it was writing for, so it would emit bash-isms (`2>/dev/null`, `rm -rf`, here-docs) that the heuristic then had to guess at.

WrongStack now **pins one shell for the whole session at boot** and tells the model exactly which shell + syntax to use (a guidance block in the system-prompt Environment section). One stable target replaces per-command guessing.

**Selection precedence** (Windows only):

1. **`WRONGSTACK_SHELL` override** — if you set it to `cmd`/`cmd.exe`, `powershell`/`powershell.exe`, or `pwsh`/`pwsh.exe` (case-insensitive), that shell is used unconditionally and left untouched. Unknown values (typos, other shells) are **silently ignored**.
2. **Session default (boot-time pin)** — when `WRONGSTACK_SHELL` is unset, boot resolves one shell and exports it: **PowerShell 7 (`pwsh`)** when `pwsh.exe` is on `PATH`, else **Windows PowerShell 5.1 (`powershell`)**, else `cmd.exe`. Because this is written back into `WRONGSTACK_SHELL`, every command in the session — and the system prompt's `Shell:` line and syntax guidance — agree on it.
3. **Per-command auto-detection (fallback)** — only reached when `WRONGSTACK_SHELL` is somehow still unset (e.g. an embedding that did not run boot). If the command "looks like" PowerShell (see below), it runs there; otherwise `cmd.exe`.

This is a deliberate behavior change: the Windows default is now **PowerShell**, not `cmd.exe`. To keep the old cmd.exe behavior, set `WRONGSTACK_SHELL=cmd`.

On non-Windows the picker is a no-op; the tool routes through `/bin/bash -c` and no session pin is applied (`WRONGSTACK_SHELL` there is treated by `bash.ts` as an explicit shell binary path, unchanged).

**Advisory bash-ism guard.** As a final safety net for models that ignore the prompt guidance, when a Windows `bash`-tool command **exits non-zero**, WrongStack scans it for POSIX idioms the resolved shell can't accept (`/dev/null`, `export`, heredocs, `&&` on PowerShell 5.1, `rm -rf`, `which`, …) and appends a short `[wrongstack]` hint with the correct replacement so the model can rewrite and retry. It is **advisory only** — never rewrites or blocks the command — and is **failure-coupled**, so it stays silent on success (PowerShell aliases like `ls`/`cat` work) and never fires on POSIX.

### `exec` tool command allowlist (`tools.exec`)

The `exec` tool — the safer, structured alternative to `bash` — only runs commands on a curated allowlist. The defaults cover the common dev/build toolchains:

- **JS/TS:** `node`, `npm`, `pnpm`, `yarn`, `npx`, `bun`, `deno`, `corepack`, `tsc`, `tsx`, `ts-node`, `vite`, `vitest`, `jest`, `biome`, `eslint`, `prettier`, `turbo`, `nx`, `webpack`, `rollup`, `parcel`, `next`, `astro`, `playwright`, `cypress`
- **Go:** `go` · **Rust:** `cargo`, `rustc` · **Python:** `python`, `python3`, `pip`, `pip3`, `pytest`, `ruff`, `mypy`, `uv`, `uvx`, `poetry`, `hatch`, `tox`
- **Ruby:** `ruby`, `gem`, `bundle` · **PHP:** `php`, `composer`, `phpunit` · **JVM:** `java`, `javac`, `mvn`, `gradle`, `gradlew` · **.NET:** `dotnet`
- **Native:** `make`, `cmake` · **VCS:** `git` · **Containers:** `docker`, `podman`, `kubectl`
- Common POSIX file/text utilities (`pwd`, `ls`, `cat`, `head`, `tail`, `grep`, `rg`, `find`, `sed`, `awk`, …)

Extend or trim the list in config:

```jsonc
// ~/.wrongstack/config.json
{
  "tools": {
    "exec": {
      "allow": ["terraform", "bazel"],  // add commands
      "deny":  ["docker", "rm"]          // remove commands
    }
  }
}
```

**Security:**
- `allow` **expands** what the agent may execute, so it is honored **only from the trusted user config** (`~/.wrongstack/config.json`). The config loader strips `tools.exec.allow` from the untrusted, repo-committed `<project>/.wrongstack/config.json` (with a `config.in_project_unsafe_fields_ignored` warning naming `tools.exec.allow`).
- `deny` only ever **removes** commands, so it is honored from any source (in-project repo config included).
- Per-argument hard-blocking is deliberately narrow: clear destructive / project-escape patterns (`rm -rf /`, unsafe `rm` targets, `git --exec=`, `git -C`, `git -c`, `find -exec`, publishing/deploying subcommands, `docker push`, …) are blocked, but normal development commands such as `pnpm run test`, `pnpm dlx ...`, `npx ...`, `node -e ...`, `python -m ...`, and `docker build` are allowed. `cwd` is confined to the project, args are passed as a clean array (no shell parsing), and every `exec` call is still gated by the `confirm` permission. For anything outside the allowlist, the model falls back to `bash`.

**Autonomous autophase.** The autonomous AutoPhase verifier runs its verify command *without* per-call confirmation, so it keeps a narrower base allowlist (`pnpm`/`npm`/`yarn`/`bun`). It additionally honors your **explicit** `tools.exec.allow` opt-ins (not the broadened `exec` defaults), so a Go/Rust project can run e.g. `go test ./...` autonomously once you add `go` to `tools.exec.allow` and point `WRONGSTACK_AUTOPHASE_VERIFY_CMD` at it. Because `tools.exec.allow` is trusted-config-only, a repo still cannot widen what runs autonomously.

**Auto-detection signals.** A command is routed to PowerShell if it contains any of these unambiguous patterns:

- **Cmdlet verb-noun syntax** — `Get-Content`, `Set-Location`, `Invoke-WebRequest`, `Remove-Item`
- **Dollar-sign variables** — `$env:PATH`, `$foo`, `$_`, `$script:bar`
- **Subexpressions** — `$(Get-Date)`
- **Here-strings** — `@"..."@`, `@'...'@`
- **Splatting / call operator** — `@( ... )`, `& $script`
- **Comparison operators** — `-eq`, `-ne`, `-match`, `-like`, `-contains`, `-and`, `-replace`, `-split`
- **`.ps1` extension** — `.\build.ps1`
- **PS-only aliases** — `gci`, `gi`, `gp`, `gcm`, `gps`, `sl`, `rm`, `cat`, `cp`, `mv`
- **Cmdlet flags** — `-WhatIf`, `-Confirm`, `-ErrorAction`
- **Pipeline cmdlets** — `Where-Object`, `ForEach-Object`, `Select-Object`, `Sort-Object`, `Group-Object`
- **Write-* output cmdlets** — `Write-Host`, `Write-Output`, `Write-Error`, `Write-Warning`
- **Registry provider paths** — `HKLM:\`, `HKCU:\`, `HKCR:\`
- **Bracketed type casts** — `[string]`, `[int]`, `[xml]`, `[System.IO.File]`
- **PS comment blocks** — `<# ... #>`
- **PS-only parameters** — `-AsPlainText`, `-PipelineVariable`, `-FilterHashtable`, `-OutVariable`

Deliberately **not** treated as PowerShell tells (both shells accept them): `C:\`-style paths, `cd`/`echo` (exist in cmd.exe too), and lone `ls`/`where`/`select` (ambiguous with cmd.exe builtins and unix tools on `PATH`).

**Execution model.** PowerShell commands are piped to the shell's stdin rather than interpolated into a `-Command "..."` argument:

```
pwsh -NoLogo -NoProfile -NonInteractive -Command -
```

This sidesteps the entire class of quoting bugs from embedding multi-line, single-quoted, or dollar-laden scripts into an argument string.

**Script wrapping.** Every PowerShell command is wrapped with four reliability fixes before it reaches stdin:

1. **UTF-8 BOM** (`U+FEFF`) — so PowerShell 5.1 decodes non-ASCII characters correctly (PS 7+ already defaults to UTF-8; the BOM is harmless there).
2. **Console output encoding** — `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` ensures PS 5.1 emits UTF-8 on stdout, preventing mojibake of non-ASCII filenames and CJK output.
3. **Exit-code propagation** — the command runs inside `try { … } finally { exit $LASTEXITCODE }`, so native commands' exit codes (dotnet, npm, node) reach the parent. Without this, `pwsh -Command -` exits `0` even on failure.
4. **Confirmation suppression** — `$ConfirmPreference='None'` and `$WhatIfPreference=$false` so `-Confirm` cmdlets don't block waiting for interactive input.

**Forcing a shell.** To always use PowerShell regardless of detection:

```bash
# Windows (PowerShell 7 if available, else Windows PowerShell 5.1)
set WRONGSTACK_SHELL=powershell
# or explicitly
set WRONGSTACK_SHELL=pwsh
```

To always use cmd.exe (disables auto-detection entirely):

```bash
set WRONGSTACK_SHELL=cmd
```

**Provider paths (registry, certificates, etc.).** PowerShell provider paths such as `HKLM:\`, `HKCU:\`, `cert:\`, `wsman:\`, `env:\`, and `function:\` are not filesystem paths — they are PowerShell-specific abstractions that only exist inside the PowerShell provider system. Node.js's `fs` APIs cannot read them, and the `read`/`write`/`edit` tools will reject them as escaping the workspace. Access them through the `bash` tool instead, which routes to PowerShell:

```powershell
Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion" -Name "ProgramFilesDir"
Get-ChildItem -Path "cert:\LocalMachine\My"
```

---

## Secrets

API keys and auth tokens are encrypted with **AES-256-GCM** using a 32-byte key at `~/.wrongstack/.key` (mode `0600` on POSIX).

**Format**: `enc:v1:<iv>:<tag>:<ciphertext>`

Field detection is regex-based — any field matching `/apikey|authtoken|bearer|secret|password|refreshtoken|sessionkey|access[_-]?token|private[_-]?key/i` is auto-encrypted on write and decrypted on read. Plaintext keys in older configs are migrated transparently on boot.

### Adding a key

```bash
wrongstack auth anthropic       # interactive prompt
wrongstack auth groq            # same for any provider
```

Or set the environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

---

## Examples

### Minimal (offline, no network)

```jsonc
{
  "version": 1,
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "providers": {
    "anthropic": {
      "apiKey": "enc:v1:...",
      "family": "anthropic"
    }
  },
  "features": {
    "mcp": false,
    "plugins": false,
    "memory": false,
    "modelsRegistry": false,
    "skills": false
  }
}
```

### Multi-provider with Groq fast lane

```jsonc
{
  "version": 1,
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "providers": {
    "anthropic": { "apiKey": "enc:v1:..." },
    "groq": {
      "type": "openai-compatible",
      "apiKey": "enc:v1:...",
      "baseUrl": "https://api.groq.com/openai/v1"
    }
  }
}
```

### Token-saver

```jsonc
{
  "version": 1,
  "provider": "anthropic",
  "model": "claude-sonnet-4-7",
  "context": {
    "mode": "frugal",
    "strategy": "intelligent"
  },
  "tools": {
    "maxIterations": 50,
    "autoExtendLimit": false
  }
}
```
