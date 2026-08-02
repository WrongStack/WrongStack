# `/chimera` — Post-session reviewer status

`/chimera` is registered by the opt-in `wstack-chimera` plugin **only when that plugin's resolved `enabled` option is true**. It reports:

- whether Chimera is enabled;
- the provider and model selected for its review subagent;
- the maximum number of changed files considered;
- the manual follow-up policy; and
- that output uses the provider's model-native ceiling.

## Subcommands

| Command | Effect |
|---------|--------|
| `/chimera` | Show current status. |
| `/chimera autoFix <off\|ask\|auto>` | Compatibility command; explains that follow-ups are manual. |

Every mode is now passive: the full report is persisted and sent to the mailbox,
while TUI, WebUI, and SimpleUI receive a compact “report ready” notice. Reports
never resume the leader or start mutating cascade agents. Successful explicit
“all clear” reports are completed automatically; findings wait for the user to
inspect them and explicitly request action.

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
