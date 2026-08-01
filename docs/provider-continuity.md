# Provider continuity: reset room, bridge, and fallback

WrongStack keeps an in-flight task moving across provider capacity and transport
failures. The continuity path is shared by the leader, Chimera workers, fleet
subagents, one-shot LLM helpers, and council seats.

This document describes the complete routing policy. For field-by-field config,
see [configuration.md](configuration.md). For the interactive command, see
[slash/fallback.md](slash/fallback.md).

## Routing order

On a fallback-worthy failure, targets are considered in this order:

```text
active provider/model
  -> fallbackBridge
  -> selected fallback profile / explicit fallbackModels
  -> favorite models
  -> same-provider configured models
  -> cross-provider configured models
```

Duplicate, unavailable, calendar-blocked, and reset-room targets are removed.
Where automatic continuity is enabled, the final last-resort inventory is
intentionally uncapped: if any permitted configured model remains usable,
continuing the task takes priority over ending at the normal smart-chain limit.
`favoriteModelsOnly` and an explicit one-shot `fallbackAuto: false` can narrow
that inventory by policy.

`fallbackBridge` is optional. It is a single operator-selected
`provider/model` route intended to be fast and to have enough context for the
largest live conversation. It is tried before every ordinary fallback source,
including task-specific explicit chains.

## Configure a bridge

From a running REPL or TUI:

```text
/fallback bridge set openai/gpt-5.4-mini
/fallback
```

Disable it with:

```text
/fallback bridge clear
```

Or set the active-profile/project config directly:

```jsonc
{
  "fallbackBridge": "openai/gpt-5.4-mini"
}
```

The reference must include both provider and model. The provider must already
have resolvable credentials or a configured keyless endpoint. A bridge that
cannot be constructed is logged and skipped; it never prevents the remaining
fallback chain from running.

## When the bridge is used

The bridge activates only after a failure classified as one of:

- `quota_exhausted`
- `rate_limit`
- `overloaded`
- `server`
- `timeout`
- `network`
- `stream_hang`

It is not used for request-shaped or user-actionable failures:

- authentication or permission failure;
- invalid request;
- context overflow (compaction owns recovery);
- content filtering (the content-filter recovery strategy owns rerouting);
- unclassified failures.

Normal in-place retry policy still runs before a transient failure enters the
fallback layer. Explicit exhausted account/plan quota is different: it is
non-retryable on the same provider and enters the reset room immediately.

## Reset room semantics

The provider/model status tracker is shared by every worker in the process and
the CLI persists its reset-room snapshot across restarts.
When one worker learns that a route is unavailable, other workers re-check the
tracker immediately before a call and skip that route without spending another
request.

Two quota scopes are distinguished:

- **Provider/account/plan quota** blocks the logical provider. Sibling models
  using the same exhausted subscription are skipped too.
- **Model/route quota** blocks only that provider/model pair. Healthy sibling
  models remain eligible.

Provider reset hints are honored when supplied in headers or error text. This
includes full timestamps and short UTC forms such as:

```text
Your token-plan 1-week quota has been exhausted.
The quota will reset at 07-26 17:57:00 UTC.
```

Without a usable reset hint, the configured tracker cooldown applies. Expired
entries return to healthy lazily on the next availability check or during an
explicit status sweep.

Inspect or release entries with:

```text
/provider-status waiting
/provider-status retry <provider> <model>
```

Manual release schedules a real half-open probe; it does not declare the route
healthy without testing it.

## Temporary routing and primary recovery

After a successful bridge or fallback hop, the active agent stays on that
working route while the primary cools down. It does not probe the failed
primary between every task.

When cooldown expires, the next turn performs a half-open primary probe:

- success restores the primary and clears its failure ladder;
- failure returns to bridge/fallback routing and lengthens the primary
  cooldown, up to the configured maximum.

This is what makes the bridge temporary: it carries work through the outage but
does not permanently replace the selected session model.

## Multi-agent behavior

The same status tracker and bridge policy are injected into:

- the main CLI/WebUI agent;
- Director/Fleet subagents, including Chimera roles;
- runtime light subagents used by standalone SDD work;
- one-shot helpers and council seats.

A quota response from any of them updates the same reset-room state. Existing
fallback chains are re-checked just before each attempt, which closes the race
where another concurrent worker blocks a route after the chain was resolved.

Chimera review/fix/cascade work also has a bounded outer retry ladder. It first
uses the assigned worker route and its effective chain; if the whole worker run
still fails, it advances through remaining routes and keeps the live session
provider/model as the final rung. Mutating ladders are intentionally shorter to
avoid repeatedly entering a tree that an earlier failed worker may have edited.

## Shadow continuity audit

The host-owned Shadow Agent observes `provider.status_changed` quota events.
It does not choose models or override deterministic routing. Instead it waits
until the active work window closes, then performs one quiet fleet pass to
verify that leader/subagent work continued or completed after fallback.

Repeated events for the same blocked route are deduplicated. When the route
becomes healthy, that observation key is cleared so a future independent outage
can be audited. Shadow sends mail only when work remains failed or stalled after
fallback, or for another high/critical anomaly.

## Choosing a bridge

Prefer a model/provider with:

1. an independent quota pool from the primary provider;
2. a context window at least as large as the primary's expected live context;
3. low cold-start and first-token latency;
4. tool-use and structured-output support required by your agents;
5. credentials that are not tied to the same subscription package as the
   primary.

Do not use a same-plan alias as the bridge for provider-wide quota recovery.
Logical provider identity mapping will correctly quarantine it with the
exhausted plan.

Crossing to a smaller context window emits a `contextWindowWarning` on the
`provider.fallback` event. It is a warning rather than a hard rejection because
the current request may still fit, but a continuity bridge should normally be
selected large enough to avoid this condition.

## Observability

Continuity uses these EventBus events:

| Event | Meaning |
|---|---|
| `provider.status_changed` | A route entered or left healthy/degraded/blocked state. |
| `provider.active_blocked` | The selected route was already blocked and will be skipped. |
| `provider.fallback` | A physical provider/model hop is about to be attempted. |
| `provider.attempt.failed` | One physical attempt failed, including retry metadata. |

`provider.fallback` includes the source and destination, HTTP status,
cross-provider flag, and optional smaller-context warning. REPL/TUI/WebUI
surfaces can render the same events without reclassifying provider errors.

## Limits and failure behavior

Continuity requires at least one constructible, scheduled, non-blocked model.
If the bridge and every configured fallback are unavailable, the last provider
error is returned. WrongStack cannot continue an LLM task with zero usable LLM
capacity.

The bridge does not:

- bypass authentication or missing credentials;
- ignore model availability calendars;
- override `favoriteModelsOnly` for normal smart-chain derivation (the explicit
  bridge itself remains honored);
- move or replay side effects from an already completed tool call;
- mask a request that is invalid for every provider.

## Troubleshooting

### Bridge is configured but never selected

Check `/fallback` and `/provider-status waiting`. Confirm the reference is
`provider/model`, the provider has credentials or a base URL, and the model is
not blocked by its availability calendar.

### Bridge is selected but context warnings appear

Choose a bridge with a larger advertised context window, or compact the session
before the next provider call. The warning reports both source and destination
limits.

### Every Chimera worker fails together

Use a bridge on an independent provider/quota pool. Multiple model names on the
same weekly token plan are not independent fallbacks and are intentionally
quarantined together for provider-wide quota errors.

### A recovered provider is still skipped

Wait for its parsed reset time/cooldown, or request a half-open probe with
`/provider-status retry <provider> <model>`. Inspect the exact logical identity
shown by `/provider-status`; gateway transports may normalize their wire id.
