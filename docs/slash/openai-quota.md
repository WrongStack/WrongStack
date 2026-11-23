# /openai-quota — ChatGPT (Codex) Subscription Quota

`openai-chatgpt` accounts and their configured aliases also appear in this
command and the WebUI quota panel. Sign in to `openai-codex` once with the same
ChatGPT account/workspace; keep `openai-chatgpt` as the active model provider.
The Codex credential is used only for quota reads because the direct OAuth token
cannot access ChatGPT's usage endpoints. When the profile has no `openai-codex`
sign-in, the CLI and WebUI hosts fall back to the official Codex CLI's login
(`$CODEX_HOME/auth.json`, default `~/.codex/auth.json`). That fallback is
read-only: an expired or rejected token is skipped and never refreshed, so the
Codex CLI stays signed in.

WrongStack reads `/backend-api/wham/usage/chatpass/apps` and requires exactly one
entry matching the direct account's issued OAuth client ID. Only after that
match does it read `/backend-api/wham/usage` for account-wide plan limits.
The app's own windows and the plan's windows are separate meters; the app's
configured allowance is not treated as remaining usage. Other applications
and Codex model buckets are never copied. Missing or ambiguous registrations
produce no reading. Tokens use normal renewal and host persistence.

The WebUI reads on panel open and refresh; both hosts also refresh after turns,
without delaying inference, at most once per minute per provider instance.
These undocumented account endpoints were verified live on 2026-10-12.
Without a matching Codex sign-in, use [ChatGPT Usage](https://chatgpt.com/settings/usage).

OpenAI's [recovery guidance](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
also warns that a usage-limit error may represent an app-specific limit;
it does not establish that the whole plan is exhausted or supply a reset time.

No aliases. The name is provider-scoped deliberately: this reads one provider's
subscription meter, not a cross-provider cost view.

## What it does

Shows how much of the signed-in ChatGPT account's plan has been consumed on each
rolling window, and when each window resets.

A "Sign in with ChatGPT" account (`openai-codex`) is metered on rolling windows —
typically a 5-hour one and a weekly one, depending on the plan. Two sources
feed the reading:

- **The account usage endpoint** (`GET chatgpt.com/backend-api/wham/usage`, the
  read behind the official client's `/status`). The command asks it first,
  through the active ChatGPT transport or — when the session runs on another
  provider — through each saved ChatGPT sign-in. It is a status read, not a
  model call, so the quota shows before any message and without a session turn.
- **The response headers** (`x-codex-*`) of the requests you already make,
  which keep the reading current as turns run.

WrongStack records every reading, and this command renders the most recent one.

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

- **It costs nothing.** The usage read spends none of the plan it reports, and
  the header readings ride on requests you were already making. A token near
  expiry is refreshed first (the rotated token is persisted as for any turn);
  a `401` refreshes once and retries. A read that fails leaves the standing
  reading in place.
- **Extra meters.** The usage endpoint also lists per-model or per-feature
  limits (`additional_rate_limits`); each one with a window shows as its own
  meter. Identity fields in that response (email, user id) are never kept.
- **In the WebUI,** the chat sidebar's quota panel triggers the same read on
  open, every five minutes and on its refresh button, so the Codex card fills
  before any session has run.
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

## Every metered provider at once

[`/provider-quota`](provider-quota.md) renders the same report for Claude
Pro/Max and GitHub Copilot alongside ChatGPT/Codex. This command stays
provider-scoped so the one question it answers needs no scrolling past the
others.

## Adding another provider

A provider becomes metered by reporting, not by being special-cased:

1. Parse whatever the provider publishes (headers, a side channel, a body
   field) into a `ProviderQuotaSnapshot` — a provider id, a meter id, and a list
   of `{ id, usedPercent, windowMinutes?, resetsAt? }` windows.
2. Call `recordProviderQuota(providerId, snapshots)` from the transport.
   `WireAdapter.onResponseHeaders` is the hook for the header case.

Both chips, the WebSocket push, the store's merge rules, and this report all
work from there — adding Claude Pro/Max and GitHub Copilot needed no change to
any surface.

Three implementations to copy from, in increasing order of awkwardness:

- `packages/providers/src/openai-codex-rate-limits.ts` — headers, with limit
  families discovered rather than hard-coded, and a positional window whose
  length must be read from `window-minutes` rather than assumed.
- `packages/providers/src/anthropic-rate-limits.ts` — headers, where the window
  length is in the header name; shows how to tell a plan budget apart from a
  per-minute throughput bucket, and why a "which window binds" hint needs a
  status to agree before it counts as "cut off".
- `packages/providers/src/github-copilot-quota.ts` — the case where the provider
  publishes nothing on the response: how to bind the read to the token
  lifecycle instead of the request path, and why that is not the same thing as
  polling a metered endpoint.

See [OAuth sign-in](../oauth-signin.md) for the login flow and for how the same
headers feed prompt-cache affinity.
