# `wstack diag` · `wstack doctor` — Diagnostics & Health Checks

## `wstack diag` — Full Diagnostic Dump

Prints a structured snapshot of the current WrongStack environment:

```
WrongStack diagnostics
  apiVersion:    0.6.0
  cwd:           /home/user/project
  projectRoot:   /home/user/project
  projectHash:   abc123
  projectDir:    ~/.wrongstack/projects/abc123
  globalRoot:    ~/.wrongstack
  modelsCache:   ~/.wrongstack/cache/models.dev.json
  cacheAge:      45m
  node:          v22.10.0
  os:            win32 10.0.19045
  provider:      anthropic
  model:         anthropic-test-model
  tools:         47
  plugins:       2
  mcpServers:    1
```

No exit code on success. Returns `1` only on catastrophic failure.

## `wstack doctor` — Health Checks

Runs a battery of checks and prints them with icons:

```
WrongStack doctor

  ✓ provider               anthropic
  ✓ model                  anthropic-test-model
  ✓ api key                found in vault
  ✓ models cache           45m old
  ✓ secret vault           ~/.wrongstack/.key
  ✓ sessions writable      ~/.wrongstack/projects/abc123/sessions
  ✓ mcp:filesystem         stdio npx @modelcontextprotocol/server-filesystem
  ✓ node                   v22.10.0

All checks passed.
```

### Checks performed

| Check | Status | Fix if fail |
|---|---|---|
| `provider` | ok / fail | `wstack init` or `wstack auth` |
| `model` | ok / fail | `wstack init` |
| `api key` | ok / fail | `wstack auth <provider>` |
| `models cache` | ok / warn | `wstack models refresh` |
| `secret vault` | ok / warn | Created lazily on first encrypt |
| `sessions writable` | ok / fail | Check directory permissions |
| `mcp:<name>` | ok / fail | Fix transport config |
| `node` | ok / fail | Upgrade to Node.js ≥ 22 |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | All passed (with warnings → amber) |
| `1` | At least one `fail` |

## Code reference

- `packages/cli/src/subcommands/handlers/diag-doctor.ts`
- `packages/cli/src/version.ts` — `API_VERSION`