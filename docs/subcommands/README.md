# Subcommands - Overview

WrongStack exposes standalone CLI entry points as `wstack <subcommand>` (the `wrongstack` binary is equivalent). The canonical named-subcommand registry is the `subcommands` object in `packages/cli/src/subcommands/index.ts`; `boot()` also normalizes a small set of shell surface aliases before that dispatch.

## Registered named subcommands

| Registered key | Aliases / nested forms | Reference |
|---|---|---|
| `wstack acp` | bare, `server`, and `serve` start the server | [ACP](acp.md) |
| `wstack init` | deprecated compatibility command; directs users to `auth` | [init](init.md) |
| `wstack auth` | `list`/`ls`; `remove`/`rm`; OAuth provider aliases | [authentication](auth.md) |
| `wstack update` | `--check-only`/`-c`; package-manager selectors | [update](update.md) |
| `wstack sessions` | nested `fleet` and `fork` forms | [sessions and config](sessions-config.md) |
| `wstack config` | `show`, `edit`, `history`, `restore` | [sessions and config](sessions-config.md) |
| `wstack rewind` | checkpoint flags; distinct from the TUI `/rewind` command | [rewind](rewind.md) |
| `wstack replay` | `--list`/`-l` | [replay](replay.md) |
| `wstack audit` | `--list`/`-l` | [audit](audit.md) |
| `wstack tools`, `wstack skills` | — | [tools and skills](tools-skills.md) |
| `wstack providers`, `wstack models` | model management includes `caps`/`capabilities` | [providers and models](providers-models.md) |
| `wstack mcp` | `list`, `add`, `remove`, `restart`, `serve` | [MCP](mcp.md) |
| `wstack plugin` | registry key `plugins` is an exact alias | [plugins](plugin.md) |
| `wstack diag`, `wstack doctor` | — | [diagnostics](diag-doctor.md) |
| `wstack export` | — | [session export](export.md) |
| `wstack usage` | — | [usage](usage.md) |
| `wstack version`, `wstack help` | `--version` and `--help` are top-level flag paths | [version and help](version-help.md) |
| `wstack projects` | — | [project registry](projects.md) |
| `wstack project id\|init\|rekey` | — | [project identity](project.md) |
| `wstack modeldiag` | `keys`, `caps`, `suggest`, `test`, `bench`, `eval` (`evall` alias) | [model diagnostics](modeldiag.md) |
| `wstack quick` | intercepted by `boot()` before its registered fallback handler | [quick launch](quick.md) |
| `wstack bench` | `run`, `compare`, `mine`, `report`, `list` | [benchmarks](bench.md) |
| `wstack hq` | bare and `serve` normalize to `--hq`; `token` remains a real subcommand | [HQ](hq.md) |
| `wstack mailbox` | bare and `serve` start the bridge; `help`/`--help`/`-h` show usage | [mailbox bridge](mailbox.md) |

There are **28 registered keys** backed by **27 distinct handlers**: `plugin` and `plugins` share one handler. `hq` is still in the registry for token management even though `wstack hq` and `wstack hq serve` are normalized to the `--hq` launch flag by `parseArgs()`.

## Shell surface aliases outside the registry

These forms are normalized or intercepted before named-subcommand dispatch:

| Form | Equivalent behavior |
|---|---|
| `wstack desktop` | `wstack --desktop` |
| `wstack webui` | `wstack --webui` |
| `wstack hq` / `wstack hq serve` | `wstack --hq` |
| `wstack resume <id>` | `wstack --resume <id>` |
| `wstack quick` | Set `--quick` and `--tui`, then continue through normal TUI startup |

`desktop`, `webui`, and `resume` are therefore user-facing command forms, but they are not keys in `subcommands`. `mailbox serve`, by contrast, is a nested action handled by the registered `mailbox` key.

## Subcommand handler interface

```typescript
type SubcommandHandler = (args: string[], deps: SubcommandDeps) => Promise<number>;

interface SubcommandDeps {
  config: Config;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  sessionStore?: SessionStore;
  skillLoader?: SkillLoader;
  toolRegistry?: ToolRegistry;
  modelsRegistry: ModelsRegistry;
  paths: WstackPaths;
  vault: SecretVault;
  cwd: string;
  projectRoot: string;
  userHome: string;
  flags?: Record<string, string | boolean>;
}
```

Exit code convention: `0` = success, `1` = generic error, `2` = config/user error, `130` = SIGINT.

## Adding a new subcommand

1. Create `packages/cli/src/subcommands/handlers/<name>.ts`.
2. Export a `const <name>Cmd: SubcommandHandler = async (args, deps) => ...`.
3. Register it in `packages/cli/src/subcommands/index.ts`.
4. Add tests under `packages/cli/tests/`.
5. Add or update docs under `docs/subcommands/`.

## vs Slash Commands

| Aspect | Subcommands | Slash commands |
|---|---|---|
| Invocation | `wstack <sub>` from shell | `/<cmd>` inside REPL/TUI |
| Context | No live agent context | Full `Context` |
| Exit | Returns exit code | Returns `{ message, exit? }` |
| Persistence | Config/session on disk | Session state and project state |
| Use case | Setup, config, project management | In-session control |
