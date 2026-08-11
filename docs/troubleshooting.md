# Troubleshooting

Common issues and how to fix them.

---

## Quick diagnosis

Run `wrongstack diag` (or `wstack diag`) to get a full diagnostic dump:

```bash
wrongstack diag
```

This prints:
- Version and apiVersion
- Active provider, model, and key status
- Loaded features (MCP, plugins, memory, skills)
- Connected MCP servers and their tool counts
- Registered tools and their owners
- Pipeline contents and override map
- Context window mode and thresholds
- Session store path and recent sessions

---

## Common issues

### "No provider configured"

**Symptom**: `No provider or model configured. Run 'wstack auth', or pass --provider <id> --model <id>.`

**Fix**:
```bash
wstack auth                        # interactive provider, key, and model setup
# or
wstack --provider anthropic --model <model-id>
```

### "API key not found"

**Symptom**: `Error: No API key found for provider 'anthropic'. Set ANTHROPIC_API_KEY or run 'wrongstack auth'.`

**Fix**:
```bash
# Option 1: Environment variable
export ANTHROPIC_API_KEY=sk-ant-...

# Option 2: Store encrypted key
wrongstack auth anthropic

# Option 3: Check existing key
wrongstack diag
```

### "Provider returned 401"

**Symptom**: `Provider error: 401 Unauthorized`

**Causes**:
- API key is invalid or expired
- Key was rotated but config still has the old one
- Wrong provider selected

**Fix**:
```bash
wrongstack auth anthropic          # re-enter key
wrongstack diag                    # verify key is loaded
```

### "Provider returned 429"

**Symptom**: `Rate limited. Retrying in N seconds...`

This is normal — WrongStack retries automatically with exponential backoff. If it persists:

- Wait a few minutes
- Switch to a different model: `/model`
- Add a backup key: `wrongstack auth groq`

### "Context window exceeded"

**Symptom**: `Context overflow. Triggering compaction...`

WrongStack auto-compacts, but if the conversation is very long:

```bash
/context mode frugal              # switch to aggressive compaction
/compact                          # manual compaction
/clear                            # start fresh
```

### "Tool execution timed out"

**Symptom**: `Tool 'bash' timed out after 300s`

The default per-tool timeout is 300 seconds. For long-running commands:

- Use `background: true` in the bash tool
- Or increase `tools.iterationTimeoutMs` in config

### "MCP server failed to connect"

**Symptom**: `MCP server 'filesystem' failed to start after 10s`

**Diagnosis**:
```bash
wrongstack mcp                    # list servers and their states
```

**Common causes**:
- `npx` not in PATH
- Package not installed: `npx -y @modelcontextprotocol/server-filesystem`
- Startup timeout too short: increase `startupTimeoutMs` in `mcpServers` config
- Port conflict (sse transport)
- Self-signed HTTPS server: add `tls: { rejectUnauthorized: false }` to the server config

**If the slot is `failed`** (reconnect budget exhausted after 5 cycles):
```bash
wrongstack mcp                    # check state
/mcp restart <name>               # manual reconnect from REPL
```

MCP tool names use the `mcp__<serverName>__<toolName>` namespace — calls to
`mcp__github__createIssue` route to the `github` server's `createIssue` tool.

### "Permission denied"

**Symptom**: Tool call blocked by permission policy.

**Fix options**:
```bash
# Auto-approve non-denied tool calls for this session
/yolo on

# Or allow specific pattern permanently
# When prompted: press 'a' to always-allow

# Or edit trust file directly
cat ~/.wrongstack/projects/<hash>/trust.json
```

### "Session damaged"

**Symptom**: `Session <id> has orphan tool_result events`

This happens when a session was interrupted mid-tool. Fix:

```bash
wrongstack resume <id>            # replay with repair
/context repair                   # manual repair in-session
```

### "Failed to connect to project server"

**Symptom**: a startup error naming a socket path, e.g.
`Error: Failed to connect to kanban project server at /tmp/wskb-v6/<hash>.sock`

A project daemon died without releasing its endpoint — `SIGKILL`, the OOM
killer, or a container stop. On Unix the socket file survives with nothing
listening behind it, which refuses clients *and* blocks replacements from
binding. Current builds reclaim this automatically on the next daemon start;
an older build stays wedged until the file is removed.

**Diagnosis**:
```bash
wstack doctor --daemons           # per-daemon status: live / stale / stopped
```

**Fix**:
```bash
wstack doctor --daemons --clear-stale
```

To see why a daemon refuses to start at all, run it in the foreground —
daemons are spawned with `stdio: 'ignore'`, so their startup errors are
otherwise discarded:

```bash
node .../@wrongstack/<pkg>/dist/project-server.js --project-root /path/to/project
```

See [project-daemons.md](project-daemons.md) for the ownership election and the
reclaim ladder.

### "Plugin failed to load"

**Symptom**: `Plugin '@wrongstack/telegram' setup failed: ...`

**Diagnosis**:
```bash
wrongstack plugin status          # check plugin state
wrongstack diag                   # full diagnostic
```

**Common causes**:
- Missing npm dependency: `pnpm install`
- apiVersion mismatch: check plugin's `apiVersion` vs kernel version
- Config validation error: check `extensions.<plugin-name>` in config

### TUI rendering issues

**Symptom**: Garbled output, resize artifacts, or missing content.

The TUI renders chat history in a bounded managed viewport. Use `PgUp`/`PgDn`
to review retained entries, or `/mouse on` for wheel and scrollbar navigation.
The complete session log remains available on disk.

**Fix**:

For tmux/screen users: ensure `$TERM` is set correctly.

### "Models.dev fetch failed"

**Symptom**: `Warning: Failed to fetch models.dev catalog. Using cached version.`

This is a non-fatal warning. The cached catalog works fine. If you need fresh data:

```bash
wrongstack models refresh         # force-refresh
```

Or disable the fetch entirely:
```jsonc
{ "features": { "modelsRegistry": false } }
```

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Generic error |
| `2` | Config error (invalid config, missing provider) |
| `130` | SIGINT (Ctrl+C) |

---

## Debug logging

```bash
wrongstack --verbose              # debug level
wrongstack --trace                # trace level (very verbose)
wrongstack --log-level debug      # explicit level
```

Logs are written to `~/.wrongstack/logs/wrongstack.log` by default.

---

## Resetting state

| What to reset | How |
|---|---|
| Active profile config | Remove `~/.wrongstack/profiles/<name>/config.json`, then run `wstack auth` |
| Trust rules | `rm ~/.wrongstack/projects/<hash>/trust.json` |
| Sessions | `rm ~/.wrongstack/projects/<hash>/sessions/*.jsonl` |
| Memory | Remove `~/.wrongstack/profiles/<name>/memory.md` and/or `<project>/.wrongstack/memory.md` |
| MCP cache | `rm ~/.wrongstack/cache/models.dev.json` |
| Everything | `rm -rf ~/.wrongstack` then `wstack auth` |

Use `wrongstack diag` to find the project hash and paths.

---

## Getting help

```bash
wrongstack help                   # general help
wrongstack help <subcommand>      # subcommand-specific help
/help                             # in-session slash command list
```

Report issues at [github.com/WrongStack/WrongStack](https://github.com/WrongStack/WrongStack) with:
1. `wrongstack diag` output
2. `wrongstack --verbose` log excerpt
3. Steps to reproduce
