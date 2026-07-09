# /tuneup - Session tune-up (alias: /checkup)

## What It Does

`/tuneup` runs a broad **health + context-cost checkup** of your WrongStack
setup and prints a findings list. `/tuneup fix` applies the safe, deterministic
subset and hands the judgement-heavy items to the agent as a follow-up turn.

Where [`/doctor`](./doctor.md) repairs the config JSON, `/tuneup` sweeps the
wider setup — skills, MCP servers, plugins, instruction files, hooks, version,
autonomy, and the permission allowlist. Bare `/tuneup` is strictly read-only.

`/checkup` is a registered alias.

## Checks

| # | Group | What it flags | `/tuneup fix` |
|---|---|---|---|
| 1 | Skills | Eager skill bodies exceeding `skills.eagerMaxChars`; foreign (`.claude`/other-tool) skills injected into every prompt | Advisory (switch to `skills.mode: progressive` / trim sources) |
| 1 | MCP servers | Configured-but-disabled servers; live servers stuck in `failed` | Advisory (`/mcp remove`/`restart`) |
| 1 | Plugins | Plugins listed in config but disabled | Advisory (remove the entry) |
| 2 | Instruction files | The same significant line duplicated across user memory / project `AGENTS.md` / root `CLAUDE.md` | Agent hand-off (dedup, keeping the committed copy) |
| 3 | Instruction files | Oversized root instruction file (> 12k chars or > 400 lines) | Agent hand-off (split into skills / nested files) |
| 4 | Hooks | Shell hooks with a ≥ 10s timeout; many hooks on one event | **Clamps** the timeout to 10s |
| 5 | Version | A newer WrongStack on npm (cached, best-effort) | Advisory (`wrongstack update`) |
| 6 | Autonomy | `autonomy.defaultMode` is not `auto` | **Sets** `autonomy.defaultMode: "auto"` |
| 7 | Permissions | Read-only bash/exec commands that keep getting denied (trust file `deny[]` + session history) | **Adds** the safe command names to `tools.exec.allow` |

## Usage

| Usage | Effect |
|---|---|
| `/tuneup` | Run all checks, read-only report |
| `/tuneup fix` | Apply deterministic fixes + hand fuzzy items to the agent |
| `/checkup` | Alias for `/tuneup` |

## Fix Safety

- Only three change kinds are ever written mechanically: `autonomy.defaultMode`,
  `tools.exec.allow`, and slow-hook `timeoutMs`. Everything else is advisory or
  handed to the agent.
- Writes target the **global** `~/.wrongstack/config.json` (never the untrusted
  in-project config — `tools.exec.allow` is a trusted-source-only field), and
  are preceded by a backup using the config-history convention (`config.json.last`
  plus a timestamped `.bak`). The change is mirrored into the in-memory config
  store and `/config-history`, so it takes effect without a restart.
- A corrupt global config is left untouched — `/tuneup fix` tells you to run
  `/doctor fix` first.
- The permission check uses a **conservative** read-only heuristic (a small
  allowlist of verbs like `ls`/`cat`/`grep`/`git status`, rejecting anything
  with redirection, pipes, or a write subcommand). An explicit `deny[]` entry is
  never overridden.
- Instruction-file cleanups are handed to the agent with an explicit "ask before
  deleting anything" instruction — nothing is auto-deleted.

## Code Reference

- `packages/cli/src/tuneup.ts` — pure check engine (`runTuneup` + per-item checks)
- `packages/cli/src/slash-commands/tuneup.ts` — the command (IO, backups, fixes)
- `packages/cli/src/update-check.ts` — reused `checkForUpdate()` (item 5)
- `packages/cli/src/config-history.ts` — backup/persist convention reused here
