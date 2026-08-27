# Tool auto-thinning

Stats-driven tool disable pipeline. Off by default; opt in with
`/settings autothin on` (or directly in your profile config). The user
always stays in control — this feature only *enables* the policy, it
never decides for you which tools to thin.

## What it does

The pipeline observes every tool invocation via the EventBus
(`tool.started` / `tool.executed` / `tool.failed`) and folds the counts
into a per-tool, per-day rollup in Chronicle (`tool_daily`). When
enabled, it runs the configured policy against the rollup and disables
tools that match:

  - invocations in the window are at or below `minInvocations`, AND
  - the most recent invocation is older than `idleDays` days.

Disabled tools are tagged `reason: 'auto-thinned'` in
`ToolsConfig.disabledToolMeta` so the decision survives restarts and
`/tool autothin undo` restores only the auto-thinned subset — user
disables are preserved.

## What it does NOT do

  - It does **not** delete, remove, or rewrite any tool.
  - It does **not** collapse similar tools (e.g. `bash` + `pwsh` + `exec`).
  - It does **not** decide for you which tools to thin — the
    `apply` step is explicit (`/tool autothin apply`), and the policy
    is bounded by `neverAutoThin` so you can pin escape-hatch tools.

## Configuration

`tools.autoThin` in your active profile config:

```json
{
  "tools": {
    "autoThin": {
      "enabled": true,
      "idleDays": 30,
      "minInvocations": 3,
      "applyOnBoot": false,
      "neverAutoThin": ["bash", "exec"]
    }
  }
}
```

| Field | Default | Notes |
| --- | --- | --- |
| `enabled` | `false` | Master switch. When `false`, the pipeline is dormant. |
| `idleDays` | `30` | Tools not invoked in this many days are candidates. |
| `minInvocations` | `3` | Tools with invocations ≤ this in the window are candidates. |
| `applyOnBoot` | `false` | When `true`, the host runs `apply` on every boot. When `false`, you must call `/tool autothin apply` explicitly. |
| `neverAutoThin` | `[]` | Tool names the pipeline must NEVER disable, regardless of stats. Use this for an emergency `bash` escape hatch. |

## Slash commands

```
/tool autothin status                  # show config + last-run summary
/tool autothin candidates              # dry-run: list what WOULD be thinned
/tool autothin apply                   # disable every candidate now
/tool autothin undo                    # re-enable everything auto-thinned
/tool autothin config <key> <value>    # enabled|applyOnBoot|idleDays|minInvocations|neverAutoThin
```

`/settings autothin on|off` toggles `enabled`. The other knobs have
dedicated subcommands: `/settings autothin-idle <days>`,
`/settings autothin-min <count>`, `/settings autothin-boot on|off`.

## Data sources

The pipeline picks a source per boot, preferring the cross-session
Chronicle rollup when available:

  - **Chronicle (primary)**: the `tool_daily` table in
    `<chronicle>/metrics.db`. Cross-session history is what the user
    actually wants to thin against.
  - **In-process bridge (fallback)**: the per-tool Map maintained by
    `wireMetricsToEvents`. Used when Chronicle is unavailable (no
    `node:sqlite` at runtime) or hasn't refreshed yet.

The `kind` field in `/tool autothin candidates` output tells you which
source the candidate set came from.

## Trust posture

`tools.autoThin` and `tools.disabledToolMeta` are operator-owned
preferences. The in-project policy (`in-project-policy.ts`) denies the
whole subtree from any repo-committed config, so a hostile checkout
can't flip auto-thinning on (or rewrite the audit trail) without
operator consent. The cloud-sync contract allows the field to LEAVE
the machine (so the user's preference syncs across their own devices)
but DENIES it INBOUND from a remote portal — same posture as the
existing `tools.disabledTools` denylist.

## Audit trail

Every auto-thinning decision is recorded in
`ToolsConfig.disabledToolMeta[name] = { reason: 'auto-thinned', at, caller }`.
`reason` distinguishes operator-authored disables from auto-thinned
ones; `at` is the wall-clock timestamp; `caller` is a free-form label
(`'boot-time auto-thin'`, `'manual apply'`, etc.).

Use `listDisabled()` on the `ToolRegistry` to enumerate the full
disabled set with reasons, and `enableAutoThinned()` to restore only
the auto-thinned subset.
