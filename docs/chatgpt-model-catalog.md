# ChatGPT model catalog maintenance

## Scope and verification plan

- Add the requested `gpt-6.1-sol` identifier to the existing refreshable CLI overlay for `openai-codex` and `openai-chatgpt`; do not invent limits, prices, or release dates.
- Preserve provider-specific curated entries when account discovery replaces a model snapshot, and expose those entries alongside saved account IDs in the shared picker resolver.
- Keep generic OpenAI sibling models and unrelated account providers out of this exception.
- Ensure Codex startup discovery uses its canonical endpoint when a saved configuration omits `baseUrl` or `family`.
- Verify with red/green overlay-to-registry-to-picker tests, discovery tests, neighbouring model suites, scoped typechecks, and diff review.

Risk: curated catalog suggestions are not proof of account entitlement. A listed model can still be rejected by the upstream account API. No authentication or transport behavior is changed.

## Why the model was missing

The Codex overlay had an empty `models` object; the ChatGPT plan provider had no overlay entry. The legacy core Codex list is deliberately empty. Account discovery replaces registry membership with its live/cache snapshot, while the shared WebUI resolver previously returned only saved account IDs. Consequently a stale snapshot hid newly released models, and adding an overlay entry alone could not fix the picker.

## Sources and precedence

`packages/cli/data/providers.json` is the curated model overlay, not a full mirror of models.dev. CLI and WebUI server load it through `DefaultModelsRegistry`, using the repository-hosted overlay, disk cache, and bundled file as fallback sources. `packages/webui/public/providers.json` is a provider presentation list, not this model overlay.

Authenticated discovery remains the source of automatically discovered rollout IDs, with no hardcoded allowlist. For the two canonical ChatGPT providers, entries explicitly supplied by the WrongStack overlay also remain catalog suggestions through live, cached, empty, or failed account discovery. Generic models.dev entries and sibling OpenAI models cannot expand account membership through this exception. Other account providers keep exact snapshot membership.

Maintain new curated models in `packages/cli/data/providers.json` for each applicable provider. Use `node scripts/sync-models.mjs --validate` to check the overlay and `--diff` / `--extract` to inspect public upstream metadata. These commands do not regenerate the overlay or establish account entitlement. Do not copy API-key pricing or context limits to subscription models without evidence.

The `gpt-6.1-sol` entry records the requested identifier and display name only. Its actual availability, limits, and pricing must come from the selected account/backend; no authenticated live invocation was used to establish them here.

## Root cause found 2026-10-05: the `client_version` gate

Both ChatGPT account catalogs — `chatgpt.com/backend-api/codex/models` (`openai-codex`) and `api.openai.com/v1/models` with a plan token (`openai-chatgpt`) — are the same version-gated document. The backend hides models from clients whose advertised Codex version is too old, and the gate is stricter than each model's published `minimal_client_version`. Measured live:

| `client_version` | Picker-visible models |
|---|---|
| none (plan API) / `0.153.4` | gpt-6-astra, gpt-5.6-sol/terra/luna, gpt-5.5 |
| `0.155.0`–`0.158.0` | + gpt-6-sol, gpt-6-luna |
| `0.159.0`+ | + gpt-6.1-sol, and gpt-5.5's retirement notice (`upgrade`) |
| `0.170.0` (checked 2026-11-18; absent at `0.160.0`) | + gpt-6.2-sol, gpt-6.2-astra (published minimum `0.166.0`) |

WrongStack pinned `0.153.4` and the plan API was queried with no version at all, so 3 of the account's 8 models never appeared. The pin is now `CODEX_CLIENT_VERSION = '0.170.0'` (`packages/providers/src/oauth/codex-protocol.ts`), and it is sent on every catalog request for both providers. To unhide a newer rollout without waiting for a release, set `WRONGSTACK_CODEX_CLIENT_VERSION=<semver>`; compare with `npm view @openai/codex version`. Both providers were checked live with a one-shot request to `gpt-6.1-sol`.

## What each surface shows, and where it comes from

| Field | Source |
|---|---|
| Model list | The account snapshot (live, or the cached snapshot offline). Authoritative. |
| Context window | The account's `max_context_window` (872K on the 6.x/5.6 line, 272K on gpt-5.5). Codex sends at most that × `effective_context_window_percent` (default 95). The public API's 1.05M is never used for these accounts. |
| Reasoning efforts | The account's `supported_reasoning_levels`, per model (`max` is absent on gpt-5.5). `ultra` (automatic task delegation) is not offered. |
| Retirement | The account's `upgrade` → `status: deprecated`. |
| Max output, knowledge cutoff | Not published by the account catalog; filled from models.dev `openai` for the same model id (`metadataFallbackProviderId`). |
| Per-token pricing | Never copied — subscription usage is not billed per token. |

Discovery snapshots are cached per account in `~/.wrongstack/cache/discovered-models-cache.json`; entries left behind by rotated refresh tokens are pruned on the next write.

## The overlay as the guarantee layer

`packages/cli/data/providers.json` carries the full current model set for both account providers, with the live context window, reasoning efforts, modalities and description, plus the models.dev output ceiling, knowledge cutoff and release date. Discovery still wins for every field it states; the overlay only guarantees that these models stay visible, with real limits, where discovery cannot see them — a stale `client_version`, an empty or failed snapshot, or an older installed binary (installed binaries read the overlay from GitHub `main`).

It is generated, never hand-edited: `bun run sync:chatgpt-overlay` reports drift (exit 1), `--write` rewrites both entries from the signed-in local account. Retiring models (the catalog's `upgrade`) and hidden routes are excluded, and per-token pricing is never written. `codex-catalog-overlay-sync.test.ts` checks completeness and that both providers carry the same set.
