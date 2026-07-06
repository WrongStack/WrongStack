# /shadow — Shadow Agent fleet monitor

Starts, manages, and stops the **Shadow Agent**: a one-shot monitoring agent
that watches the whole fleet (across all terminals on the project), detects
loops and spike tasks, and can intervene. Healthy work windows are evaluated
with deterministic host rules; an LLM pass runs only on explicit request or
after the host observes problematic work — Shadow does not post routine
"all healthy" reports.

Alias: `/shadow-agent`.

## Subcommands

| Command | Effect |
|---|---|
| `/shadow start [--model=<provider/model>]` | Queue one quiet Shadow fleet check. |
| `/shadow stop` | Stop the active Shadow Agent. |
| `/shadow status` | Show all running agents and their current tasks. |
| `/shadow hoop <agent-id> [--reason=<text>]` | Stop the target agent immediately and send a notification. |
| `/shadow hoop all [--reason=<text>]` | Stop every running agent. |
| `/shadow model <provider/model>` | Change the analysis model (applied on next `start`). |
| `/shadow interval <ms>` | Change the legacy interval default (min 5000 ms; kept for compatibility). |

## What Shadow watches

- All fleet agents and their current tasks
- Mailbox state and message flow
- Spike tasks (agents that start/stop instantly)
- Fleet-wide activity across every terminal on the project

The spawned agent gets the `fleet`, `mailbox`/`mail_inbox`/`mail_send`, and
`terminate_subagent` tools — enough to observe, message, and intervene.

## Model selection

Models must be `provider/model` (e.g. `anthropic/anthropic-test-model`);
`default` (or omitting `--model`) uses the current leader provider/model.
Only one Shadow Agent instance is allowed per session.

## Examples

```
/shadow start
/shadow start --model=anthropic/anthropic-test-model
/shadow status
/shadow hoop subagent-abc123 --reason=looping
```

## Notes

- `/shadow` requires a running director with subagent support (`/fleet` or
  `/spawn` first).
- The host also arms Shadow automatically: after a work window that ends in
  failure/max-iterations, a one-shot quiet pass is dispatched without any
  user action.

See also: `/agents` (transcript monitoring), `/fleet` (fleet management),
`/mailbox` (the channel Shadow uses to notify).
