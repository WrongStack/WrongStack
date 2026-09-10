# YOLO Mode

YOLO mode is WrongStack's broad auto-approval setting. When YOLO is on,
`DefaultPermissionPolicy` approves tool calls that were not blocked earlier by
explicit deny rules.

Current behavior:

- The stored config default (`BEHAVIOR_DEFAULTS.yolo`) is `false`. Interactive first launch currently selects YOLO on and persists that launch choice.
- `--yolo` forces broad auto-approval at startup. `--no-yolo` forces approval prompts and overrides both a saved YOLO preference and `--yolo`.
- Explicit denies still win: session soft-deny, trust-file deny patterns, and
  tools declared with `permission: 'deny'`.
- A tool's own `permission: 'confirm'` declaration is **not** an input to the
  YOLO decision. Under YOLO the only question asked is
  `gatedDestructiveKind()` — see below. A tool that declares `confirm` because
  it mutates something is auto-approved in YOLO like any other; that
  declaration governs the non-YOLO path. Gating on it instead turns YOLO into a
  prompt on ordinary work, which is the thing YOLO exists to remove.
- YOLO still confirms **genuinely destructive** calls. The measure is "does
  this do large damage to the machine or the project", not "does this look
  dangerous". The nine categories live in `security/yolo-risk.ts`
  (`DestructiveKind`); `agent-state` and `credential-bind` are permanently
  locked because they are writes that can switch the approval system itself
  off.
- `--confirm-destructive`, `--yolo-destructive`, and `--force-all-yolo` select
  *which* of those categories still prompt (`autonomy.yoloConfirm`); the two
  locked kinds are re-added on every entry path.

## Quick Reference

| Surface | How to use it |
|---|---|
| CLI flags | `wrongstack --yolo`, `wrongstack --no-yolo` |
| Slash command | `/yolo`, `/yolo on`, `/yolo off`, `/yolo toggle` |
| Programmatic | `permissionPolicy.setYolo(true)` |

When YOLO is off, mutating or sensitive calls fall through to confirm prompts.
Trust-file deny rules and `permission: 'deny'` tools still win regardless.

## Approval Timeout

Any approval that still reaches a human surface waits for exactly 120 seconds.
If nobody answers, the active Brain arbitration chain decides whether that one
call may run. The timed-out request cannot escalate back to the human; an
unavailable, failed, or inconclusive Brain decision rejects the call safely.
WebUI sends the deadline with the prompt and shows the remaining time.

## Permission Evaluation Order

Every tool call passes through `DefaultPermissionPolicy.evaluate()` before
execution. The first matching rule wins:

```text
1. Session soft deny          -> deny
2. Session soft allow         -> auto
3. Trust file deny pattern    -> deny
4. Tool default deny          -> deny
5. Trust file allow pattern   -> auto
6. Trust file auto flag       -> auto
7. YOLO                       -> auto
8. Smart bypass (write+read)  -> auto
9. Tool default               -> auto for non-mutating auto tools
10. Confirm prompt / event    -> confirm
```

This means trust-file deny rules and `permission: 'deny'` still win over YOLO.
When YOLO is off, mutating or sensitive calls can still ask for confirmation.

## Runtime Toggle

YOLO can be toggled during a REPL/TUI session:

```text
/yolo           show current status
/yolo on        enable YOLO
/yolo off       disable YOLO
/yolo toggle    flip current state
```

The slash command accepts these arguments:

| Argument | Effect |
|---|---|
| `on`, `enable`, `true`, `1` | Enable |
| `off`, `disable`, `false`, `0` | Disable |
| `toggle` | Flip |

## Source Values

Permission decisions can report these relevant sources:

| Source | Meaning |
|---|---|
| `yolo` | Auto-approved because YOLO mode is active |
| `yolo_destructive` | Legacy source value retained for older session/UI compatibility |
| `trust` | Matched an allow rule or trust-file auto flag |
| `deny` | Explicitly denied by a pattern or tool declaration |
| `user` | User answered a permission prompt |
| `context` | Smart bypass, such as writing a file already read this session |
| `default` | Tool's own declared permission level |

## Session-Scoped Soft Rules

When the user answers a permission prompt, the policy can remember the answer
for the rest of the session:

| Answer | Effect |
|---|---|
| `y` | `allowOnce()` auto-approves this tool/pattern once for the immediate re-run |
| `n` | `denyOnce()` blocks this tool/pattern for the session |
| `a` | `trust()` writes a permanent allow rule to `trust.json` |
| `d` | `deny()` writes a permanent deny rule to `trust.json` |

The one-shot allow entry is consumed on first use. The session maps are also
cleared when the trust file is reloaded.

## Security Notes

| Concern | Mitigation |
|---|---|
| Accidental destructive commands | Keep YOLO off when you want per-call review; use explicit trust-file deny rules for hard blocks |
| Project-boundary escape | Filesystem tools refuse reads/writes outside the active project root by default (`tools.restrictToProjectRoot: true`); explicit `features.allowOutsideProjectRoot` is the only way to opt out |
| YOLO left on unintentionally | TUI status and `/yolo` show the current state |
| Subagent privilege escalation | Subagents use `AutoApprovePermissionPolicy`, which denies dangerous capabilities, MCP tools, and legacy risky names by default |
| Trust file poisoning | Trust is per project at `~/.wrongstack/projects/<hash>/trust.json`; encrypted secrets are separate |

Example defensive trust rules:

```jsonc
// ~/.wrongstack/projects/<hash>/trust.json
{
  "bash": {
    "deny": [
      "rm -rf /*",
      "DROP TABLE*",
      "DELETE FROM*"
    ]
  },
  "write": {
    "deny": ["~/.ssh/*", "~/.gnupg/*", "/etc/*"]
  }
}
```

## Programmatic Usage

```ts
import { DefaultPermissionPolicy } from '@wrongstack/core';

const policy = new DefaultPermissionPolicy({
  trustFile: '/path/to/trust.json',
  yolo: true,
});

policy.setYolo(false);

const isYolo = policy.getYolo();
const destructiveGate = policy.getConfirmDestructive(); // deprecated compatibility state
```

For subagents:

```ts
import { AutoApprovePermissionPolicy } from '@wrongstack/core';

const subagentPolicy = new AutoApprovePermissionPolicy();
```

## Code Reference

- `packages/core/src/security/permission-policy.ts`
- `packages/cli/src/arg-parser.ts`
- `packages/cli/src/slash-commands/yolo.ts`
