# Launch Menu

The `wstack` CLI shows a five-option interactive launch menu when invoked
on a TTY with no surface flag. This document explains the menu, its
fallback rules, and how to opt out.

## When does it appear?

The menu (`packages/cli/src/boot/launch-menu.ts`) is shown when **all**
of these hold:

- `process.stdin.isTTY` is `true`
- No surface flag is set (`--webui`, `--simpleui`, `--hq`, `--desktop`)
- No positional subcommand is given (`auth`, `init`, `mcp`, `plugin`,
  `doctor`, …)
- No `--no-menu`, `--no-interactive`, or `--skip` flag is set
- No positional query or `--prompt <text>` is supplied
- The user has not passed a one-shot argument that implies the
  subcommand-dispatch path (`auth <provider>`, etc.)

In every other case the menu is silently skipped and the historical
`boot()` flow runs unchanged.

## Menu flow

```
  ✱ WrongStack launch mode
  ? Choose how to run WrongStack:
    1) TUI / REPL  (interactive terminal; TUI is the default)
    2) WebUI       (browser-based project UI; port 3456)
    3) SimpleUI    (lightweight browser UI; port 3466)
    4) HQ          (project-independent HQ dashboard; port 3499)
    5) Desktop     (Electron desktop shell; alias: --desktop)
  [1-5, q to quit] (auto 1 in 8s)
```

- A numeric answer (`1`–`5`) picks the surface.
- `q` (or `quit`) cancels — the CLI exits with code 0.
- Any other input (or a timeout) falls back to the first option
  (TUI/REPL).
- For modes 2/3/4 the menu then prompts for an optional port (Enter
  uses the surface's documented default) and host.
- Mode 5 launches Desktop the same way as `wstack --desktop` and
  does not ask for a port or host.

### Default ports

| Surface  | Default port | Source of truth |
|----------|--------------|-----------------|
| WebUI    | 3456         | `packages/webui-server/src/server/port-utils.ts` (`SURFACE_DEFAULT_PORTS.webui`) |
| SimpleUI | 3466         | `packages/webui-server/src/server/port-utils.ts` (`SURFACE_DEFAULT_PORTS.simpleui`) |
| HQ       | 3499         | `packages/cli/src/hq-server.ts` (`DEFAULT_PORT`) |
| Host     | 127.0.0.1    | `launch-menu.ts` (`DEFAULT_HOST`) |

Port validation mirrors the existing `handleHqShortCircuit` logic: an
integer in `1–65535`. Invalid input is re-prompted up to three times;
on exhaustion the surface default is used.

## Summary gate

After a successful run, the chosen mode + port are persisted to
the active `~/.wrongstack/profiles/<name>/config.json`:

```json
{
  "launch": {
    "menuChoice": { "mode": "webui", "port": 3456, "host": "127.0.0.1" }
  }
}
```

On the next invocation, the menu shows a one-line summary and a single
`Continue with these? [Y/n/q]` confirmation instead of re-asking the
same question — the same pattern used by `runLaunchPrompts` for the
inner TUI/REPL picker.

`y` (or a 5-second timeout) reuses the saved choice.
`n` re-prompts the full menu.
`q` exits gracefully with code 0.

The persisted record only contains overrides — the port is dropped when
it equals the surface default, so the source of truth stays in
`SURFACE_DEFAULT_PORTS` and `DEFAULT_PORT`.

## How to bypass the menu

| Use case | Solution |
|----------|----------|
| Script or CI run | Pass any surface flag: `wstack --webui`, `wstack --hq`, etc. |
| Non-interactive terminal | Already skipped (`!process.stdin.isTTY`). |
| Want to keep the historical `wstack` behaviour | Pass `--no-menu`. |
| One-shot query (refactor a file) | Pass the query positionally: `wstack "refactor src/auth.ts"`. The menu skips on positional arg. |
| Subcommand (provider setup, MCP, etc.) | Pass the subcommand: `wstack auth anthropic`, `wstack mcp add foo`. |

## Why a menu at all?

The CLI grew five parallel first-class surfaces (TUI/REPL, WebUI,
SimpleUI, HQ, Desktop) with separate launch flags. Users on a fresh install
often type plain `wstack` expecting *one* of them to start. The menu
replaces the implicit `TUI/REPL if no flag is set` choice with an
explicit one-liner, while preserving every existing escape hatch.

It also gives port + host a single, documented entry point — previously
each surface had its own flag (`--port`, `--host`) that wasn't surfaced
in the help text.

## Files touched

- `packages/cli/src/boot/launch-menu.ts` — the menu module.
- `packages/cli/src/cli-context.ts` — wires the menu between the
  help/desktop/HQ short-circuits and `boot()`.
- `packages/cli/src/arg-parser.ts` — adds `'no-menu'` to `BOOLEAN_FLAGS`.
- `packages/core/src/types/config.ts` — adds `LaunchMenuChoice` and
  `LaunchConfig.menuChoice`.
- `packages/cli/tests/launch-menu.test.ts` — 39 unit tests covering
  the skip predicate, argv transformation, persistence shape, and the
  prompt flow.
