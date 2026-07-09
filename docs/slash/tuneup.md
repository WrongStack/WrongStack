# /tuneup - Session tune-up (alias: /checkup)

## What It Does

`/tuneup` runs a broad **health + context-cost + performance checkup** of your
WrongStack setup and prints a findings list. `/tuneup fix` applies the safe,
deterministic subset; `/tuneup fix --power` also flips the autonomy profile; and
`/tuneup deep` hands the findings to the agent for a project-specific plan.

Where [`/doctor`](./doctor.md) repairs the config JSON, `/tuneup` sweeps the
wider setup and recommends the knobs that make a session faster and more
resilient. Bare `/tuneup` is strictly read-only. `/checkup` is a registered alias.

## Checks

| Group | What it flags | `/tuneup fix` |
|---|---|---|
| Version | A newer WrongStack on npm (cached, best-effort) | Advisory (`wrongstack update`) |
| Autonomy | `autonomy.defaultMode` is not `auto` | **`--power` only** |
| Performance | Auto-fallback off with no chain; adaptive concurrency off; circuit-breaker off; session-start indexing off; oversubscribed `maxConcurrent` | **Writes** `fallbackAuto`, `adaptiveConcurrency.enabled`; rest advisory |
| Reliability | `session.auditLevel: minimal`; vault key not passphrase-hardened; large session logs | Advisory (`/prune`, `WRONGSTACK_VAULT_PASSPHRASE`) |
| Config | `/doctor`-style config issues | Advisory (`/doctor fix`) |
| Skills | Eager bodies over `skills.eagerMaxChars`; foreign skills injected every prompt | **Writes** `skills.mode: progressive` |
| MCP | Configured-but-disabled servers; live `failed` servers | Advisory |
| Plugins | Listed but disabled | Advisory |
| Instruction files | Duplicated lines across memory/AGENTS.md/CLAUDE.md; oversized root file | Agent hand-off |
| Hooks | Shell hooks ≥ 10s timeout; many hooks on one event | **Clamps** the timeout |
| Permissions | Read-only bash/exec commands that keep getting denied | **Adds** to `tools.exec.allow` |

## Usage

| Usage | Effect |
|---|---|
| `/tuneup` | Run all checks, read-only report |
| `/tuneup fix` | Apply safe deterministic fixes (never touches autonomy) |
| `/tuneup fix --power` | …and enable the autonomy + YOLO + director profile |
| `/tuneup fix --pick` | Confirm each fix before applying |
| `/tuneup fix --profile power` | Alias for `fix --power` |
| `/tuneup deep` | Hand the findings to the agent for a tailored optimization plan |
| `/checkup …` | Alias for `/tuneup` |

## The power profile

A plain `/tuneup fix` **never** flips autonomy, YOLO, or director — that respects
the "autonomy is user-owned" invariant. Only the explicit `--power` opt-in writes
`autonomy.defaultMode: "auto"`, `yolo: true`, and `launch.director: true`, and
live-applies YOLO + auto mode through the same runtime controllers `/yolo` and
`/autonomy` use, so it takes effect immediately.

## Deep mode

`/tuneup deep` is the non-mechanical tier: it runs the report, then hands the
agent a prompt with the live findings and asks for a prioritized, project-aware
optimization plan (which knob, why it helps here, how to apply). It changes
nothing itself — the plan is for you to approve.

## Fix Safety

- Deterministic changes only: `autonomy.defaultMode` / `yolo` / `launch.director`
  (power), `fallbackAuto`, `adaptiveConcurrency.enabled`, `skills.mode`,
  `tools.exec.allow`, and slow-hook `timeoutMs`. Everything else is advisory or
  handed to the agent.
- Writes target the **global** `~/.wrongstack/config.json` (never the untrusted
  in-project config — `tools.exec.allow` is a trusted-source-only field), and are
  preceded by a backup (`config.json.last` + a timestamped `.bak`). The change is
  mirrored into the in-memory config store and `/config-history`, so it takes
  effect without a restart.
- A corrupt global config is left untouched — `/tuneup fix` tells you to run
  `/doctor fix` first.
- The permission check uses a conservative read-only heuristic (verbs like
  `ls`/`cat`/`grep`/`git status`; rejects redirection, pipes, write subcommands).
- Instruction-file cleanups are handed to the agent with an explicit "ask before
  deleting anything" instruction — nothing is auto-deleted.

## Code Reference

- `packages/cli/src/tuneup.ts` — pure check engine (`runTuneup`, per-item checks, `buildDeepPrompt`)
- `packages/cli/src/slash-commands/tuneup.ts` — the command (IO, backups, fixes, arg parsing)
- `packages/cli/src/update-check.ts` — reused `checkForUpdate()` (version check)
- `packages/cli/src/config-doctor.ts` — reused `diagnoseConfig()` (config category)
- `packages/cli/src/config-history.ts` — backup/persist convention reused here
