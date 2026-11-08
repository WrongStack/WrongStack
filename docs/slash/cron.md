# `/cron` — Session wakeup monitor

`/cron` lists the session wakeups: timers the agent scheduled for itself with
the built-in `session_wakeup` tool ("check the deploy in ten minutes", "look
at CI every five minutes"). They replaced the cron plugin's jobs. In the TUI,
bare `/cron` opens the live monitor; `/cron list` prints the same list. The
list is read through `session_wakeup` (action `list`) with a five-second
deadline; if the tool is not registered, the list is reported as unavailable
rather than empty.

Each row shows the wakeup id, its prompt, the interval (`once` for a one-shot
wakeup), the last and next fire time and how often it fired, plus the
per-session limit of 10 wakeups. The slash view only reads: the agent
schedules and cancels wakeups with `session_wakeup` (actions `schedule` and
`cancel`).

When a wakeup fires, its prompt reaches the agent as a runtime notice: a
running loop receives it at the next iteration, and an idle session is woken
for it. Wakeups are session-only and in-process: they never keep the CLI
alive, die with the process, and recurring ones expire after 24 hours. For
jobs that survive sessions, use [persistent automation](../subcommands/automation.md).

Sources: [`cron-slash.ts`](../../packages/tui/src/cron-slash.ts),
[`resource overrides`](../../packages/tui/src/hooks/use-resource-slash-commands.ts),
[`session-wakeup.ts`](../../packages/tools/src/session-wakeup.ts).
