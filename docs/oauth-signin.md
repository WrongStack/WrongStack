# Sign in with a subscription (OAuth)

WrongStack can authenticate against three vendor **subscriptions** instead of a
metered API key:

| Sign-in | Subscription | Wire family (provider id) | Endpoint |
|---|---|---|---|
| **Sign in with ChatGPT** | ChatGPT Plus / Pro / Team (Codex) | `openai-codex` | `chatgpt.com/backend-api` (Responses API) |
| **Sign in with Claude** | Claude Pro / Max | `anthropic-oauth` | `api.anthropic.com` (Messages API) |
| **Sign in with GitHub Copilot** | GitHub Copilot | `github-copilot` | Copilot proxy (OpenAI Chat Completions) |

This is an **orthogonal credential layer** — it sits *next to* the API-key
provider system, it doesn't replace it. The ~110 API-key providers pulled from
[models.dev](https://models.dev) keep working exactly as before; an OAuth
subscription just adds a new, separately-authenticated provider entry you can
select like any other.

---

> [!WARNING]
> **Using a subscription outside its official client is a Terms-of-Service gray
> area and can get your account rate-limited, suspended, or banned.** These flows
> present WrongStack to the vendor backend the way each official client does
> (Codex CLI / Claude Code / Copilot Chat), but that does **not** make it
> sanctioned. The supported, sanctioned path for programmatic use is an **API
> key**. Sign in with a subscription only if you accept that risk for your own
> account. WrongStack ships this as a convenience, with no warranty — you are
> responsible for your account.

---

## How it works

- **Distinct wire families.** Each subscription is its own `WireFamily`
  (`openai-codex`, `anthropic-oauth`, `github-copilot`) with its own request
  shape, headers, and auth. Nothing about the API-key `openai` / `anthropic`
  families changes.
- **Browser-based login.** Codex and Claude use a **PKCE loopback** OAuth flow
  (a local callback server receives the code); Copilot uses **GitHub's device
  flow** (you paste a code at `github.com/login/device`). No API key is typed.
- **Self-refreshing tokens.** Access tokens refresh automatically near expiry and
  once on a `401`; rotated tokens are written back to config transparently.
- **Encrypted at rest.** The access/refresh tokens are stored in
  `~/.wrongstack/config.json` under the provider entry, encrypted with your
  per-machine key (`~/.wrongstack/.key`, AES-256-GCM) like every other secret.
- **Client fidelity.** Each provider sends the User-Agent / beta / app headers of
  the corresponding official client so the subscription backend accepts the
  request. This is a documented gray area, **not** an undetectable disguise (see
  the warning above).

## Quick start

Interactive menu:

```bash
wstack auth          # → choose "s) Sign in with a subscription (ChatGPT / Claude / Copilot)"
```

Or go straight to one provider:

```bash
wstack auth login chatgpt     # Sign in with ChatGPT  → provider openai-codex
wstack auth login claude      # Sign in with Claude   → provider anthropic-oauth
wstack auth login copilot     # Sign in with Copilot  → provider github-copilot
```

After login, select the provider/model like any other:

```bash
wstack --provider openai-codex   --model gpt-5.5          "explain this repo"
wstack --provider anthropic-oauth --model claude-opus-4-8 "find the bug in src/auth.ts"
wstack --provider github-copilot  --model gpt-4o          "write tests for utils.ts"
```

…or pick them from the TUI `/model` picker — OAuth providers appear in the list
automatically once a subscription is signed in.

---

## Sign in with ChatGPT (Codex)

```bash
wstack auth login chatgpt
# aliases: openai · codex · codex-cli · openai-codex
```

- **Flow:** PKCE loopback (`localhost:1455/auth/callback`) against
  `auth.openai.com`, mirroring the real Codex CLI's "Sign in with ChatGPT".
- **Provider id:** `openai-codex` · **Endpoint:** `https://chatgpt.com/backend-api`
  (the Responses API, not `chat/completions`).
- **Models** (seeded; the picker shows them): `gpt-5.5`, `gpt-5.4`,
  `gpt-5.4-mini`, `gpt-5.3-codex-spark`.
- **Use:** `wstack --provider openai-codex --model gpt-5.5 "<task>"`
- **Requires** a ChatGPT **Plus / Pro / Team** plan with Codex access. A plain
  free account will authenticate but be rejected at request time.

## Sign in with Claude

```bash
wstack auth login claude
# aliases: anthropic · claude-pro · claude-max · anthropic-oauth
```

- **Flow:** PKCE loopback (`localhost:53692/callback`) against
  `claude.ai/oauth/authorize`, the same grant Claude Code uses.
- **Provider id:** `anthropic-oauth` · **Endpoint:** `https://api.anthropic.com`
  (Messages API, Bearer auth + Claude Code beta headers).
- **Models:** fetched live from your account's `/v1/models` at login; falls back
  to `anthropic-test-model`, `claude-opus-4-8`.
- **Use:** `wstack --provider anthropic-oauth --model claude-opus-4-8 "<task>"`
- **Requires** a Claude **Pro / Max** subscription. Modern Claude models
  eligible long-context models serve their full **1M-token** context window on this
  path with no extra flags (see [context windows](#context-windows) below).

## Sign in with GitHub Copilot

```bash
wstack auth login copilot
# aliases: github · github-copilot · gh
```

- **Flow:** GitHub **device flow** — you open `github.com/login/device` and paste
  the shown code. WrongStack then mints a short-lived Copilot token from your
  long-lived GitHub token.
- **Provider id:** `github-copilot` · **Endpoint:** the Copilot proxy resolved
  from the token (OpenAI Chat Completions wire).
- **Models:** fetched live from the Copilot models endpoint; falls back to
  `gpt-4o`.
- **Use:** `wstack --provider github-copilot --model gpt-4o "<task>"`
- **Requires** an active **GitHub Copilot** subscription on the signed-in
  account.

---

## Context windows

OAuth providers aren't published in the models.dev catalog under their own id, so
WrongStack resolves each model's real context window from its **sibling catalog**
(`anthropic-oauth` → `anthropic`, `openai-codex` / `github-copilot` → `openai`).
That means you get the true per-model window — e.g. **Claude Opus 4.8 → 1M**,
**gpt-5.5 → ~1.05M** — instead of a flat family default.

No beta header or `[1m]` suffix is needed: modern Claude (4.6+/4.8) serves 1M
natively, and the legacy `context-1m-2025-08-07` beta was retired on
2026-04-30. If you ever need to pin a different window, set
`providers.<id>.capabilities.maxContext` in `config.json`.

## Token storage, refresh & sign-out

- Tokens live under `providers.<id>` in `~/.wrongstack/config.json`, encrypted.
  The entry records `authMethod: "oauth"`, the access token (as `apiKey`), the
  `refreshToken`, and `expiresAt`.
- Refresh is automatic — near expiry before a request, and once on a `401`. The
  rotated tokens are persisted in place; you won't be asked to log in again until
  the refresh token itself is revoked or expires.
- To sign out, remove the provider entry (`wstack auth` → manage keys) or delete
  it from `config.json`. Re-run `wstack auth login <provider>` to sign back in.

## Troubleshooting

| Symptom | Meaning |
|---|---|
| `400 … You're out of extra usage` (Claude) | Login + wire are working — your subscription's usage quota is exhausted. Add usage at `claude.ai/settings/usage`. |
| `This account may not have … subscription access` | The signed-in account lacks the required plan (Codex/Copilot) — sign in with an entitled account or use an API key. |
| Provider not in the `/model` picker | The login didn't persist a provider entry. Re-run `wstack auth login <provider>` and watch for a success line. |
| Context shows a smaller window than expected | The model isn't in the sibling catalog; set `providers.<id>.capabilities.maxContext`, or refresh the catalog (drop `--no-models-refresh`). |

## See also

- [`docs/configuration.md`](configuration.md) — full config reference, including
  `providers.<id>` and `capabilities` overrides.
- [`docs/subcommands/`](subcommands/) — the `wstack auth` subcommand family.
- The API-key path remains the sanctioned option for automation — `wstack auth
  <provider>` stores a key the normal way.
