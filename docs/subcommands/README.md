# Subcommands - Overview

WrongStack exposes standalone CLI entry points as `wstack <subcommand>` (the `wrongstack` binary is equivalent). The canonical named-subcommand registry is the `subcommands` object in `packages/cli/src/subcommands/index.ts`; `boot()` also normalizes a small set of shell surface aliases before that dispatch.

## Registered named subcommands

| Registered key | Aliases / nested forms | Reference |
|---|---|---|
| `wstack acp` | bare, `server`, and `serve` start the server | [ACP](acp.md) |
| `wstack remote` | SSH-hosted runtime and local WebUI tunnel | [remote](remote.md) |
| `wstack config-export`, `wstack config-import` | Portable behavior settings | [config transfer](config-transfer.md) |
| `wstack skill-suggest` | Skill routing and live service diagnostics | [skill evaluation](skill-suggest.md) |
| `wstack typesafe` | Jev account and decision diagnostics | [Jev diagnostics](typesafe.md) |
| `wstack proxy-status` | Optional WrongProxy health | [proxy status](proxy-status.md) |
| `wstack chronicle` | Chronicle maintenance/query | [Chronicle](chronicle.md) |
| `wstack permissions` | Inspect a tool permission decision | [permissions](permissions.md) |
| `wstack sage` | External-agent memory attachment and sync | [SAGE integration](sage.md) |
| `wstack governance` | Read-only project daemon status | [governance](governance.md) |
| `wstack sandbox`, `wstack automation` | Isolated runs and persistent jobs | [sandbox](sandbox.md), [automation](automation.md) |
| `wstack init` | deprecated compatibility command; directs users to `auth` | [init](init.md) |
| `wstack auth` | `list`/`ls`; `remove`/`rm`; OAuth provider aliases | [authentication](auth.md) |
| `wstack update` | `--check-only`/`-c`; package-manager selectors | [update](update.md) |
| `wstack desktop` | bare opens the app; `install`, `update`, `path`; `--version`, `--silent` | [desktop](desktop.md) |
| `wstack sessions` | nested `fleet` and `fork` forms | [sessions and config](sessions-config.md) |
| `wstack config` | `show`, `edit`, `history`, `restore` | [sessions and config](sessions-config.md) |
| `wstack rewind` | checkpoint flags; distinct from the TUI `/rewind` command | [rewind](rewind.md) |
| `wstack replay` | `--list`/`-l` | [replay](replay.md) |
| `wstack audit` | `--list`/`-l` | [audit](audit.md) |
| `wstack tools`, `wstack skills` | — | [tools and skills](tools-skills.md) |
| `wstack providers`, `wstack models` | model management includes `caps`/`capabilities` | [providers and models](providers-models.md) |
| `wstack mcp` | `list`, `add`, `remove`, `restart`, `serve` | [MCP](mcp.md) |
| `wstack plugin`, `wstack plugins` | shared handler | [plugins](plugin.md) |
| `wstack diag`, `wstack doctor` | — | [diagnostics](diag-doctor.md) |
| `wstack export` | — | [session export](export.md) |
| `wstack usage` | — | [usage](usage.md) |
| `wstack version`, `wstack help` | `--version` and `--help` are top-level flag paths | [version and help](version-help.md) |
| `wstack projects` | — | [project registry](projects.md) |
| `wstack project id\|init\|rekey` | — | [project identity](project.md) |
| `wstack import-claude-code` | `--apply`, `--overwrite`, `--enable-project-servers` | [Claude Code import](import-claude-code.md) |
| `wstack modeldiag` | `keys`, `caps`, `suggest`, `test`, `bench`, `eval` (`evall` alias) | [model diagnostics](modeldiag.md) |
| `wstack quick` | intercepted by `boot()` before its registered fallback handler | [quick launch](quick.md) |
| `wstack bench` | `run`, `compare`, `mine`, `report`, `list` | [benchmarks](bench.md) |
| `wstack hq` | bare and `serve` normalize to `--hq`; `token` remains a real subcommand | [HQ](hq.md) |
| `wstack mailbox` | bare and `serve` start the bridge; `help`/`--help`/`-h` show usage | [mailbox bridge](mailbox.md) |

The [source-derived catalog](../current-catalog.md#shell-subcommands) lists every registered key and distinct handler: `plugin` and `plugins` share one handler. `hq` is still in the registry for token management even though `wstack hq` and `wstack hq serve` are normalized to the `--hq` launch flag by `parseArgs()`.

## Shell surface aliases outside the registry

These forms are normalized or intercepted before named-subcommand dispatch:

| Form | Equivalent behavior |
|---|---|
| `wstack webui` | `wstack --webui` |
| `wstack hq` / `wstack hq serve` | `wstack --hq` |
| `wstack resume <id>` | `wstack --resume <id>` |
| `wstack quick` | Set `--quick` and `--tui`, then continue through normal TUI startup |

`webui` and `resume` are therefore user-facing command forms, but they are not keys in `subcommands`. `mailbox serve`, by contrast, is a nested action handled by the registered `mailbox` key.

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
