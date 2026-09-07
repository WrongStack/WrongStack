# /openai-quota — ChatGPT (Codex) Subscription Quota

No aliases. The name is provider-scoped deliberately: this reads one provider's
subscription meter, not a cross-provider cost view.

## What it does

Shows how much of the signed-in ChatGPT account's plan has been consumed on each
rolling window, and when each window resets.

A "Sign in with ChatGPT" account (`openai-codex`) is metered on rolling windows —
typically a 5-hour one and a weekly one. The ChatGPT backend reports the burn
only in the **response headers** of the requests you already make; none of it
appears in the response body. WrongStack records every reading, and this command
renders the most recent one.

## Output

```
WrongStack — ChatGPT / Codex quota

  openai-codex — codex plan: pro
    5h   ████████████░░░░░░░░░░░░ 51% (49% left) · resets in 2h 18m
    7d   ██████░░░░░░░░░░░░░░░░░░ 24% (76% left) · resets in 4d 6h
    as of 12s ago
```

Bars turn amber at 70% and red at 90%. Extra rows appear when the account has
credits, when the backend names the limit that was reached, or when it attaches
a promo message.

## Notes

- **It costs nothing.** The reading is observational — it is never fetched on
  its own, which is why it appears only after the first request of a session.
  Before then, `/openai-quota` says so and tells you to send a message first.
- **Only ChatGPT-login accounts are metered this way.** API-key providers bill
  per token and report no window; they do not appear here. For provider health
  and failure counts see [`/provider-status`](provider-status.md).
- **On a `429`,** the same headers give an exact reset time, which the waiting
  room uses to park the model until the window reopens rather than re-probing an
  exhausted plan on a backoff schedule.

## The statusline chip

The `quota` chip on line 3 of the statusline shows the same data condensed to
one span: the most-consumed window across **every** metered provider, its burn,
and its countdown — amber from 70%, red at 90% or once a provider has actually
cut the account off. Toggle it with [`/statusline`](statusline.md).

The chip is provider-neutral. It reads the shared store in
`@wrongstack/core/quota`, so a second metered provider shows up in the same chip
as soon as its transport reports a reading — no second chip, no second parser.

## WebUI

The chat header carries the same chip. The server broadcasts every reading as
`provider.quota` — unstamped, because a plan belongs to the account and not to
a conversation, so all four tabs see it — and a tab that connects mid-session
asks once with `provider.quota.get` to replay what the server already holds.
Nothing is ever re-fetched from the provider.

## Adding another provider

A provider becomes metered by reporting, not by being special-cased:

1. Parse whatever the provider publishes (headers, a side channel, a body
   field) into a `ProviderQuotaSnapshot` — a provider id, a meter id, and a list
   of `{ id, usedPercent, windowMinutes?, resetsAt? }` windows.
2. Call `recordProviderQuota(providerId, snapshots)` from the transport.
   `WireAdapter.onResponseHeaders` is the hook for the header case.

Both chips, the WebSocket push, the store's merge rules, and this report all
work from there. See
`packages/providers/src/openai-codex-rate-limits.ts` for the reference
implementation.

See [OAuth sign-in](../oauth-signin.md) for the login flow and for how the same
headers feed prompt-cache affinity.
