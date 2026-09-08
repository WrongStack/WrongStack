# @wrongstack/plug-lsp

Language Server Protocol (LSP) integration for WrongStack. Provides a unified
`/lsp` command to install, run, and manage LSP servers, plus 4 LSP-backed tools
for the agent (diagnostics, definition, rename, codebase search).

## Quick Start

### 1. Nothing — it is on by default

The plugin is a built-in and runs unless you turn it off. With
`autoStart: "lazy"` no server process starts until you touch a file of a
matching language, and auto-discovery only adopts servers already installed on
the machine, so a machine with no language servers pays nothing.

To turn it off:

```json
{
  "plugins": [{ "name": "lsp", "enabled": false }]
}
```

### 2. Install a language server

```text
/lsp install typescript
/lsp install python
/lsp install go
```

### 3. That's it

`/lsp install` saves the server into your project-private config
(`~/.wrongstack/projects/<slug>/config.local.json`) and starts it in the current
session. No hand-edited JSON, no restart. `/lsp status` prints the file it wrote.

Entries are never written to the repo-committed `.wrongstack/config.json`: the
in-project config layer denies `extensions` outright, so a checked-in repo cannot
point a language server at an arbitrary binary.

## `/lsp` Command

The primary interface for all LSP operations:

| Command | Description |
|---|---|
| `/lsp` | List all configured servers and their states |
| `/lsp list` | Same as `/lsp` |
| `/lsp status` | Detailed status with failed server errors and active file count |
| `/lsp install <lang>` | Install the LSP server for a language |
| `/lsp add <name> --command <binary> --languages <csv> ...` | Register/start any installed stdio server |
| `/lsp start [name]` | Start all servers, or a specific one |
| `/lsp stop [name]` | Stop all servers, or a specific one |
| `/lsp restart [name]` | Restart all servers, or a specific one |
| `/lsp diagnostics [file]` | Show diagnostics for a file or workspace |
| `/lsp remove <name>` | Stop the server and delete its config entry |
| `/lsp enable <name>` | Turn a server back on and start it |
| `/lsp disable <name>` | Stop a server and keep it off across sessions |
| `/lsp help` | Show full help |

### Available Languages for `/lsp install`

| Language | Server | Install Method |
|---|---|---|
| `typescript` | `typescript-language-server` | npm |
| `python` | `pyright-langserver` | npm |
| `json` | `vscode-json-language-server` | npm |
| `html` | `vscode-html-language-server` | npm |
| `css` | `vscode-css-language-server` | npm |
| `yaml` | `yaml-language-server` | npm |
| `shell` | `bash-language-server` | npm |
| `go` | `gopls` | Go toolchain |
| `rust` | `rust-analyzer` | Rust toolchain |
| `ruby` | `ruby-lsp` | RubyGems |
| `csharp` | `csharp-ls` | .NET toolchain |
| `php` | `intelephense` | npm |

## Registered Tools

The plugin registers these 11 tools only while at least one enabled LSP server
is configured. With no server, the tools and their system-prompt guidance stay
absent; `/lsp install` and `/lsp add` remain available and activate them live.
Optional operations are capability-checked against the server's initialize response.

| Tool | Permission | Description |
|---|---|---|
| `lsp_diagnostics` | `auto` | Get type/lint diagnostics for a file or whole workspace |
| `lsp_definition` | `auto` | Jump to the definition of a symbol (more precise than grep) |
| `lsp_references` | `auto` | Find semantic references |
| `lsp_hover` | `auto` | Read inferred types, signatures, and documentation |
| `lsp_completion` | `auto` | Semantic completions for a cursor location, including live editor content when provided |
| `lsp_symbols` | `auto` | List the semantic symbol tree of a file |
| `lsp_code_actions` | `auto` | List server quick fixes/refactors without applying them |
| `lsp_execute_command` | `confirm` | Execute a command exposed by the active server |
| `lsp_request` | `confirm` | Invoke a documented vendor/custom request; lifecycle methods are blocked |
| `lsp_rename` | `confirm` | Safe semantic rename across the workspace |
| `codebase-lsp-search` | `auto` | Fast symbol search via WrongStack's index, with LSP fallback |

**Positions use 1-based line numbers and 1-based UTF-8 byte columns** — matching
WrongStack's grep tool convention, not LSP's 0-based UTF-16 code units.

## Configuration Reference

Full configuration options under `extensions["@wrongstack/plug-lsp"]`:

```json
{
  "extensions": {
    "@wrongstack/plug-lsp": {
      "autoStart": "lazy",
      "diagnosticsAfterEdit": "background",
      "diagnosticsWaitMs": 1500,
      "severityFilter": ["error", "warning"],
      "maxDiagnosticsPerFile": 5,
      "maxDiagnosticsTotal": 50,
      "autoDiscover": true,
      "logServerOutput": false,
      "servers": {
        "typescript": {
          "command": "typescript-language-server",
          "args": ["--stdio"],
          "languages": ["typescript", "typescriptreact"],
          "fileExtensions": { ".custom-ts": "typescript" },
          "rootPatterns": ["tsconfig.json"],
          "initializationOptions": {},
          "settings": {},
          "startupTimeoutMs": 15000,
          "enabled": true
        }
      }
    }
  }
}
```

### Options

| Option | Default | Description |
|---|---|---|
| `autoStart` | `"lazy"` | `"lazy"` = start on first file access; `"eager"` = all at session start; `"never"` = manual only |
| `diagnosticsAfterEdit` | `"background"` | `"background"` = fetch after edits; `"manual"` = on request only |
| `diagnosticsWaitMs` | `1500` | How long `lsp_diagnostics` waits for a push-only server's first `publishDiagnostics` after a file is opened or edited. A cold `tsserver` needs a second or two; the tool returns as soon as the push lands. |
| `severityFilter` | `["error","warning"]` | Which diagnostic severities to return |
| `maxDiagnosticsPerFile` | `5` | Maximum diagnostics per file |
| `maxDiagnosticsTotal` | `50` | Maximum diagnostics total |
| `autoDiscover` | `true` | Auto-discover servers on PATH or `node_modules/.bin` |
| `logServerOutput` | `false` | Log server stderr to WrongStack log |

## TypeScript 5/6 vs TypeScript 7

TypeScript 7 ships a native binary with **no `tsserver.js`**, so
`typescript-language-server` cannot start against it at all:

```text
The TypeScript of the workspace (TypeScript 7.0.2 at ".../typescript/lib")
provides no tsserver.js. No other valid TypeScript installation was found.
```

That same binary *is* a language server — `tsc --lsp --stdio` — so there are
two presets and auto-discovery picks exactly one, from the **workspace's own**
TypeScript version (`node_modules/typescript/package.json`, walking up):

| Workspace TypeScript | Preset | Command |
|---|---|---|
| 7 or newer | `typescript-native` | `tsc --lsp --stdio` |
| 6 or older, or none | `typescript` | `typescript-language-server --stdio` |

Both presets claim the same language ids, so they can never be discovered
together. A `typescript` or `typescript-native` entry you wrote yourself is
always kept as-is and suppresses discovery of the other.

## Auto-Discovery

With `autoDiscover: true` (the default), the plugin searches for servers in:

1. **`node_modules/.bin`** — npm-installed binaries, walking up from the project
2. **`PATH`** — resolved to a concrete file, not the bare name: on Windows Node
   does not apply `PATHEXT`, so spawning a name that `where.exe` finds still
   fails with `ENOENT` unless the `.cmd`/`.exe` shim is named explicitly.

This means a minimal config is often sufficient:

```json
{
  "features": { "plugins": true },
  "plugins": ["@wrongstack/plug-lsp"]
}
```

If `typescript-language-server` is in your project's `node_modules/.bin`, it is
automatically discovered and started on first file access.

Installed `clangd`, `csharp-ls`, `jdtls`, `kotlin-language-server`,
`sourcekit-lsp`, `lua-language-server`, `zls`, and `intelephense` binaries are
also auto-discovered. For any other stdio server, use for example:

```text
/lsp add vue --command vue-language-server --languages vue --extension .vue=vue --arg --stdio
```

Repeat `--arg`, `--root`, and `--extension` as needed. Quoted command paths are
supported on Windows.

## Server Lifecycle

Each server runs as a separate child process communicating via JSON-RPC over stdio.
The plugin handles:

- **Initialization handshake** — sends `initialize` → waits for `InitializeResult` → sends `initialized`
- **Document tracking** — sends `textDocument/didOpen` on first read, `textDocument/didChange` after edits
- **Crash recovery** — 3 restart attempts with exponential backoff (1s, 4s, 16s)
- **Graceful shutdown** — sends `shutdown` then `exit` on session end
- **Diagnostics matching** — buffers are keyed by canonical path, not by the raw
  URI string: a server may answer a `didOpen` for `file:///C:/dir/a.ts` with
  diagnostics for `file:///c%3A/dir/a.ts`

States shown to users: `disabled`, `idle`, `starting`, `initializing`, `ready`,
`failed`, and `reconnecting`. `idle` means configured but not running; it is not
a successful handshake.

## Custom Server Configuration

For languages not in the preset list, prefer `/lsp add`. Direct config remains
available when initialization options, settings, or environment variables are needed:

```json
"servers": {
  "myserver": {
    "command": "my-language-server",
    "args": ["--stdio"],
    "languages": ["mylang"],
    "rootPatterns": ["mylang.config"],
    "startupTimeoutMs": 20000
  }
}
```

## CLI Setup Command

For CI/CD or scripted installation, use the setup CLI directly:

```sh
# Install all preset servers (npm-based only)
pnpm --filter @wrongstack/plug-lsp setup -- --cwd /path/to/project

# Install specific servers
pnpm --filter @wrongstack/plug-lsp setup -- --cwd . --languages typescript,python,go

# Dry run
pnpm --filter @wrongstack/plug-lsp setup -- --dry-run --languages typescript
```

## Troubleshooting

**Server shows as "failed"**: Check the server binary is on PATH and starts correctly.
Run `/lsp status` to see the error message from the server's stderr.

**No diagnostics**: Open the file first (LSP servers report diagnostics for open files).
Run `/lsp diagnostics <file>` after reading the file.

**Wrong language detected**: Set the `languages` array explicitly in the server config
to include the language ID for your file (e.g., `"python"` for Python files).

## Architecture

```
packages/plug-lsp/src/
├── slash-commands/
│   ├── lsp.ts          — unified /lsp command dispatcher
│   ├── install.ts       — language server installation logic
│   ├── list/start/stop/restart/diagnostics.ts — individual commands
├── server/
│   ├── lsp-server.ts   — per-server LSP client (one process per server)
│   ├── connection.ts    — JSON-RPC 2.0 over stdio transport
│   └── lifecycle.ts     — state machine for server lifecycle
├── tools/              — 5 LSP-backed agent tools (diagnostics, definition, completion, rename, codebase-search)
├── registry.ts         — manages all server instances
├── document-tracker.ts — tracks open/edited files across sessions
├── auto-discover.ts    — PATH and node_modules discovery
├── config-persist.ts   — writes server entries to the project-private config
└── presets.ts          — built-in server configurations
```

## Plugin Command Names

The plugin registers slash commands with the `@wrongstack/plug-lsp` namespace:

- `/@wrongstack/plug-lsp:list`
- `/@wrongstack/plug-lsp:start`
- `/@wrongstack/plug-lsp:stop`
- `/@wrongstack/plug-lsp:restart`
- `/@wrongstack/plug-lsp:diagnostics`

These are also available as the short form **`/lsp`**, **`/lsp list`**, etc.
