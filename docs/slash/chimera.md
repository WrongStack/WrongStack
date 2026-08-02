# `/chimera` — Post-session reviewer status

`/chimera` is registered by the opt-in `wstack-chimera` plugin **only when that plugin's resolved `enabled` option is true**. It reports:

- whether Chimera is enabled;
- the provider and model selected for its review subagent;
- the maximum number of changed files considered;
- the auto-fix mode; and
- that output uses the provider's model-native ceiling.

## Subcommands

| Command | Effect |
|---------|--------|
| `/chimera` | Show current status. |
| `/chimera autoFix <off\|ask\|auto>` | Set the auto-fix mode for the current session (runtime only, config file unchanged). |

The auto-fix modes:

- **off** — Send the review result to the mailbox. The leader agent waits for a user command (default).
- **ask** — Send the review as an ask. The leader prompts the user for permission before acting.
- **auto** — Send the review result, then automatically resume the same session leader to verify and apply actionable findings. The runtime waits for the leader follow-up before closing the session and completes the mailbox item when that turn succeeds.

Successful explicit “all clear” reports are completed automatically without waking the leader. Failed, unparseable, review-only, denied, timed-out, or failed-follow-up reports remain available for manual disposition.

Every completed review is durably written before the runtime publishes its completion event, regardless of whether it came from manual review, auto-review, cascade, or the optional post-session Chimera plugin. The project-scoped stores are:

- `~/.wrongstack/projects/<slug>/review-reports.jsonl` — full report text, provenance, counts, and report lifecycle;
- `~/.wrongstack/projects/<slug>/review-findings.jsonl` — parsed findings and finding lifecycle.

Mailbox delivery remains a separate notification channel backed by the project mailbox. Disabling the optional `wstack-chimera` plugin does not disable persistence for reviews produced by auto-review.

Store mutations and compaction are coordinated with cross-process file locks. Once the combined JSONL size reaches 8 MiB, retention compaction runs at most once per 24 hours: completed/skipped reports are retained for 90 days, resolved findings for 30 days, and ignored findings for 14 days. Compaction replaces files atomically and malformed/truncated JSONL lines are skipped during recovery.

Use the core [`/review`](review.md) command to request a manual changed-file review. Chimera's automatic review is driven by the `session.ended` event, not by invoking `/chimera`.

Configuration is read from `extensions["wstack-chimera"]`.

## Code reference

- `packages/core/src/plugins/chimera-plugin.ts`
- `packages/cli/src/execution-chimera-review.ts`
