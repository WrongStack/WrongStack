# Launch Menu

The `wstack` CLI shows a five-option interactive launch menu when invoked
on a TTY with no surface flag. This document explains the menu, its
fallback rules, and how to opt out.

## When does it appear?

The menu (`packages/cli/src/boot/launch-menu.ts`) is shown when **all**
of these hold:

- `process.stdin.isTTY` is `true`
- No surface flag is set (`--webui`, `--vibeui`, `--hq`;
  the retired `--simpleui` counts as `--vibeui`)
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
    1) TUI     (interactive terminal; default)
    2) REPL    (line-by-line terminal prompt)
    3) WebUI   (browser-based project UI; port 3456)
    4) VibeUI  (focused coding workspace; port 3476)
    5) HQ      (project-independent HQ dashboard; port 3499)
  [1-5, q to quit] (auto 1 in 8s)
```

- A numeric answer (`1`–`5`) picks the surface.

SimpleUI was retired and replaced by VibeUI; `wstack simpleui` / `--simpleui` now open VibeUI.
The menu no longer lists SimpleUI; VibeUI moved to option 4.

- `q` (or `quit`) cancels — the CLI exits with code 0.
- Any other input (or a timeout) falls back to the first option
  (TUI).
- For modes 3/4/5 the menu then prompts for an optional port (Enter
  uses the surface's documented default) and host.

### Default ports

| Surface  | Default port | Source of truth |
|----------|--------------|-----------------|
| WebUI    | 3456         | `packages/webui-server/src/server/port-utils.ts` (`SURFACE_DEFAULT_PORTS.webui`) |
| VibeUI   | 3476         | `packages/webui-server/src/server/port-utils.ts` (`SURFACE_DEFAULT_PORTS.vibeui`) |
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

## Reuse startup choices

The later startup gates — provider/model, system prompt (Lite / Standard /
Pro / Scout) and TUI-REPL · YOLO · Autonomy — follow
`launch.rememberStartupChoices` (TUI **Settings → Startup → Reuse startup
choices**, or `/settings reuse-startup-choices on|off`). The surface menu
above is not covered: it keeps no saved choice yet.

- **on** (default; unset = on): once a choice has been saved, boot reuses it
  without asking `Continue with these?`. First run still asks, a saved
  provider/model that is no longer usable still opens the picker, and a CLI
  flag that differs from the saved value still opens the individual prompts.
- **off**: every launch asks. After the questions, boot offers
  `Stop asking these startup questions? [y/N]` (default N after 5 s); `y`
  sets the switch back to on.

The system prompt can also be changed from inside the TUI: **Settings →
Startup → System prompt** (`/settings system-prompt lite|standard|pro|scout`).
It writes `systemPrompt.variant` to the profile config and applies from the
**next session**; the running session keeps the prompt and tool surface it
was built with.

## How to bypass the menu

| Use case | Solution |
|----------|----------|
| Script or CI run | Pass any surface flag: `wstack --webui`, `wstack --hq`, etc. |
| Non-interactive terminal | Already skipped (`!process.stdin.isTTY`). |
| Want to keep the historical `wstack` behaviour | Pass `--no-menu`. |
| One-shot query (refactor a file) | Pass the query positionally: `wstack "refactor src/auth.ts"`. The menu skips on positional arg. |
| Subcommand (provider setup, MCP, etc.) | Pass the subcommand: `wstack auth anthropic`, `wstack mcp add foo`. |

## Why a menu at all?

The CLI grew four parallel first-class surfaces (TUI/REPL, WebUI,
VibeUI, HQ) with separate launch flags. Users on a fresh install
often type plain `wstack` expecting *one* of them to start. The menu
replaces the implicit `TUI/REPL if no flag is set` choice with an
explicit one-liner, while preserving every existing escape hatch.

It also gives port + host a single, documented entry point — previously
each surface had its own flag (`--port`, `--host`) that wasn't surfaced
in the help text.

## Files touched

- `packages/cli/src/boot/launch-menu.ts` — the menu module.
- `packages/cli/src/cli-context.ts` — wires the menu between the
  help/HQ short-circuits and `boot()`.
- `packages/cli/src/arg-parser.ts` — adds `'no-menu'` to `BOOLEAN_FLAGS`.
- `packages/contracts/src/types/config.ts` — adds `LaunchMenuChoice` and
  `LaunchConfig.menuChoice`.
- `packages/cli/tests/launch-menu.test.ts` — 39 unit tests covering
  the skip predicate, argv transformation, persistence shape, and the
  prompt flow.
