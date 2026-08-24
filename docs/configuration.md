# Configuration Reference

WrongStack uses a layered configuration system. Settings are merged from multiple sources with a clear precedence order.

---

## Config file locations

| Layer | Path | Purpose |
|---|---|---|
| Bootstrap | `~/.wrongstack/config.json` | `version` and `activeProfile` only |
| Active profile | `~/.wrongstack/profiles/<name>/config.json` | Developer-level defaults (provider, keys, features) |
| Project-private | `~/.wrongstack/projects/<slug>/config.local.json` | Project overrides outside the repo (not committed) |
| In-project | `<project>/.wrongstack/config.json` | Repo-local safe preferences only; unsafe fields are stripped before merge |
| CLI flags | `--provider`, `--model`, `--yolo`, `--no-yolo`, etc. | Session-scoped overrides |

**Precedence** (highest wins): CLI flags → extra config sources → env vars → in-project → project-private → active profile → bootstrap metadata → built-in defaults.

---

## Full config schema

```jsonc
{
  "version": 1,
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "apiKey": "enc:v1:<iv>:<tag>:<ciphertext>",
  "baseUrl": "https://api.anthropic.com",
  "providers": { /* ... */ },
  "context": { /* ... */ },
  "tools": { /* ... */ },
  "mcpServers": { /* ... */ },
  "plugins": [],
  "log": { /* ... */ },
  "features": { /* ... */ },
  "yolo": false,
  "modelRuntime": { /* ... */ },
  "systemPrompt": { "variant": "default" },
  "modelMatrix": { /* ... */ },
  "fleet": { /* ... */ },
  "fallbackModels": [],
  "fallbackBridge": "openai/gpt-5.4-mini",
  "fallbackProfiles": { /* ... */ },
  "fallbackAuto": true,
  "fallbackMaxLastResortCandidates": 12,
  "fallbackStickiness": { "primaryProbeInterval": 60000, "stickyFallbackTurns": 0 },
  "cwd": ".",
  "extensions": { /* ... */ }
}
```

---

## Top-level fields

| Field | Type | Default | Description |
|---|---|---|---|
| `version` | `1` | `1` | Config schema version. Must be `1`. |
| `provider` | `string` | *(required)* | Active provider id (e.g. `anthropic`, `openai`, `groq`). |
| `model` | `string` | *(required)* | Active model id (e.g. `claude-opus-4-7`, `gpt-4.1`). |
| `apiKey` | `string` | — | API key for the active provider. Auto-encrypted on first contact. |
| `baseUrl` | `string` | — | Custom API base URL. Overrides the provider's default endpoint. |
| `yolo` | `boolean` | `false` | Auto-approve non-denied tool calls. Interactive first launch currently selects and persists `true`. Override at startup with `--yolo` or `--no-yolo`. |
| `fallbackModels` | `string[]` | — | Ordered fallback chain tried when the primary model is overloaded (429/529/5xx) and its own retries are exhausted. Each entry is `model`, `provider/model`, or `provider model`. Cross-provider. After a fallback hop, the primary is retried only after its cooldown expires. Overridden by `--fallback-model a,b,c`. |
| `fallbackBridge` | `string` | — | Optional fully-qualified `provider/model` emergency route tried before the ordinary chain. It remains active when `fallbackAuto` is off and shares health/calendar filtering with other fallbacks. Configure with `/fallback bridge set ...`. |
| `fallbackProfiles` | `Record<string, string[]>` | — | Named fallback chains. `/setmodel` and WebUI Model Routing can point a role/phase/default entry at a profile. |
| `fallbackAuto` | `boolean` | `true` | Auto-derive a fallback chain from other keyed providers when `fallbackModels` is empty. Toggle with `/fallback auto on\|off`. |
| `fallbackMaxLastResortCandidates` | `number` | `12` | Maximum number of auto-discovered models appended as a last-resort tail after the bridge, explicit chain, named profile, and default profile are all exhausted. Set to `0` to disable the tail entirely. Fractional values are floored. Validated by `/config doctor`. |
| `fallbackStickiness` | `object` | `{ primaryProbeInterval: 60000, stickyFallbackTurns: 0 }` | Controls how the fallback engine transitions between the primary and fallback models. See [Fallback stickiness](#fallback-stickiness) below. |
| `favoriteModels` | `string[]` | `[]` | User-curated model refs prioritized by pickers and smart fallback derivation. |
| `favoriteModelsOnly` | `boolean` | `false` | Restrict the **auto-derived** smart-default fallback chain to `favoriteModels`. **Explicit** settings are always honored as written — this includes `fallbackModels`, `fallbackProfiles`, and matrix model-only entries (`agent_model_assign` with `model=...`, no `profile=...`). The smart-default chain is at most as strict as the matrix model-only mode: the matrix already requires favorites whenever `favoriteModels` is non-empty (via `isFavoriteRef`), regardless of this toggle. The toggle only narrows the auto-derivation path, and only when `favoriteModels` is non-empty — an empty `favoriteModels` list means the smart default falls back to including every usable provider/model pair. Toggle with `/fallback fav only on\|off`. |
| `modelRuntime` | `object` | — | Runtime request controls for the leader/default request path: reasoning, prompt-cache TTL, and gated generation parameters. |
| `systemPrompt` | `object` | `{ "variant": "default" }` | Baseline system prompt selection. `variant: "default"` loads `system.md`; `variant: "lite"` loads the compact `system-lite.md`; `variant: "pro"` loads `system-pro.md`. Overridden for one launch by `--system-pro`, `--system-lite`, or `--system-prompt default\|lite\|pro`. |
| `modelMatrix` | `Record<string, ModelMatrixEntry>` | — | Per-role/phase/`*` subagent routing matrix. Entries can override provider/model/fallback profile and role-specific runtime controls. |
| `fleet` | `FleetConfig` | — | Fleet budgets, supervision, worktrees, peer awareness, and subagent lifecycle. User config only; stripped from in-project config. |
| `brain` | `BrainConfig` | — | Decision layer: autonomy ceiling, deterministic rules, heuristics, LLM quality gate + circuit breaker, council, decision cache, replay trace, ledger, monitor. See [`brain`](#brain--decision-layer-autonomy-rules-council-trace). User config only; stripped from in-project config. |
| `hooks` | `object` | — | Lifecycle shell hooks keyed by event. See [`hooks`](#hooks--lifecycle-hooks) below and [hooks.md](./hooks.md). |
| `cwd` | `string` | `process.cwd()` | Working directory. Overridden by `--cwd` CLI flag. Director Mode is permanently on — no `--director` flag or config field exists. |

---

## Fallback stickiness

The fallback system automatically rotates to a backup model when the primary
provider returns capacity/transport errors (429, 5xx, overload, timeout, stream
hang). Five design decisions govern how transitions work:

### How the chain is traversed

1. **Deterministic continuity order** — `fallbackBridge` is the immediate escape
   hatch, followed by the explicit/role/profile chain and the `default` profile.
   When `fallbackAuto` is enabled, the runtime finally exhausts every permitted
   configured target; the normal smart preview remains capped at four entries.
   Chimera's bounded outer retry ladder preserves the live session model as its
   final rung after those worker-specific routes.

2. **Stale-entry resilience** — A chain entry that returns a non-fallback-worthy
   error (e.g. 404 / `invalid_request` from a retired model) is **skipped**, not
   used to abort the rest of the chain. Only the primary's triggering error
   decides whether fallback begins at all.

3. **Last-working-fallback memory** — The engine remembers which fallback model
   last succeeded. On subsequent primary failures, that model is **tried first**,
   avoiding a full re-traversal through entries that already proved flaky. The
   memory is cleared only when the primary fully recovers.

### Primary recovery

4. **Graduated recovery** — A single primary success does **not** fully reset
   the failure ladder. The system requires `primaryRecoverySuccesses` (default:
   2) consecutive primary successes before clearing the exponential backoff
   streak. If the primary fails again during partial recovery, the backoff
   continues from where it left off (60s → 120s → 240s …), not from scratch.

5. **Sticky dwell controls** — Two config fields let you control how long the
   system stays on a working fallback before probing the primary:

| Field | Type | Default | Description |
|---|---|---|---|
| `fallbackStickiness.primaryProbeInterval` | `number` | `60000` (60s) | Base cooldown (ms) applied after the primary fails. While active, the system stays on the fallback instead of re-probing the primary every turn. Set `0` to probe every turn (legacy behavior). |
| `fallbackStickiness.stickyFallbackTurns` | `number` | `0` | Minimum number of turns to dwell on a working fallback before the primary becomes eligible for a half-open probe — **even if** the cooldown timer has already expired. Set to e.g. `3` to require three full turns on the fallback before risking a switch back. |

Both controls stack: the primary is only probed when **both** the timer has
expired and the turn count is met.

### Example: Conservative transitions

Stays on a working fallback for at least 3 turns, and waits 2 minutes between
primary probe attempts:

```jsonc
{
  "fallbackStickiness": {
    "primaryProbeInterval": 120000,
    "stickyFallbackTurns": 3
  }
}
```

### Example: Aggressive primary recovery

Probes the primary every turn (no cooldown), but still requires 2 consecutive
successes before fully trusting it:

```jsonc
{
  "fallbackStickiness": {
    "primaryProbeInterval": 0
  }
}
```

> **Note:** `primaryProbeInterval: 0` disables the cooldown entirely. The
> graduated recovery (consecutive-success requirement) still applies — it is a
> separate mechanism baked into the extension, not configurable through
> `fallbackStickiness`.

### Interaction with the provider status tracker

The `ProviderModelStatusTracker` adds a second layer of protection independent
of `fallbackStickiness`. A model that returns a 429 is immediately quarantined
for 5 minutes (`blockAfterRateLimitHits: 1`), and account-level quota exhaustion
quarantines all sibling models on the same provider. Quarantined entries are
filtered out of the chain **before** the stickiness controls apply.

---

## `systemPrompt` — Baseline system prompt selection

The host system prompt normally loads the baseline identity/instructions from
`system.md`. Set `systemPrompt.variant` to use the pro baseline instead:

```jsonc
{
  "systemPrompt": {
    "variant": "pro"
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `variant` | `"default" \| "pro"` | `"default"` | `default` loads `system.md`; `pro` loads `system-pro.md`. |

CLI flags override this setting for one launch:

```bash
wstack --system-pro
wstack --system-prompt pro
wstack --system-prompt default
```

The selected file follows the normal instruction override layers. For a
project-local pro prompt that is not committed, create:

```text
<project>/.wrongstack/instructions/system-pro.md
```

That file is used when `variant` is `"pro"` and overrides the bundled
`packages/core/instructions/system-pro.md` for that project.

---

## `providers` — Per-provider configuration

A map of provider id → provider config. Each entry can declare its own API key, base URL, model, and quirks.

```jsonc
{
  "providers": {
    "anthropic": {
      "type": "anthropic",
      "apiKey": "enc:v1:...",
      "model": "claude-opus-4-7"
    },
    "ai-gateway": {
      "type": "ai-gateway",
      "envVars": ["AI_GATEWAY_API_KEY"],
      "model": "anthropic/claude-sonnet-5",
      "models": [
        "anthropic/claude-sonnet-5",
        "anthropic/claude-opus-5",
        "openai/gpt-5.6-sol"
      ]
    },
    "groq": {
      "type": "openai-compatible",
      "apiKey": "enc:v1:...",
      "baseUrl": "https://api.groq.com/openai/v1",
      "model": "llama-3.3-70b-versatile"
    },
    "ollama": {
      "type": "openai-compatible",
      "baseUrl": "http://localhost:11434/v1",
      "family": "openai-compatible"
    }
  }
}
```

The `ai-gateway` entry uses Vercel AI Gateway through AI SDK 7. Model ids use
`provider/model` form, and the credential is read from `AI_GATEWAY_API_KEY`; do
not place the plaintext key in project configuration.

Per-model facts (context window, output ceiling, vision, reasoning) are resolved
from the models.dev entry of the provider named in the model id — so
`anthropic/claude-sonnet-4.6` inherits the catalog's `anthropic` facts. Sampling
settings, `responseFormat` and prompt caching are forwarded through AI SDK's
unified call settings. `logprobs`/`topLogprobs` and `candidateCount` have no
unified equivalent and are not sent; the provider reports them as unsupported
rather than dropping them silently.

### ProviderConfig fields

| Field | Type | Default | Description |
|---|---|---|---|
| `type` | `string` | — | Provider type (usually matches the wire family). |
| `apiKey` | `string` | — | API key. Auto-encrypted. Falls back to `<PROVIDER>_API_KEY` env var. |
| `apiKeys` | `ProviderApiKey[]` | — | Multiple keys with labels. Pick one with `activeKey`. |
| `activeKey` | `string` | first entry | Label of the key to use from `apiKeys`. |
| `baseUrl` | `string` | provider default | Custom API endpoint. |
| `headers` | `Record<string, string>` | — | Extra HTTP headers sent with every request. |
| `model` | `string` | — | Default model for this provider. |
| `family` | `string` | auto-detected | Wire family override (`anthropic`, `openai`, `openai-compatible`, `google`). Required for offline/custom endpoints. |
| `envVars` | `string[]` | provider default | Custom env var names to probe for API keys. |
| `models` | `string[]` or inline model objects | — | Models to surface **in addition to** the catalog, listed first. **Additive, never subtractive** — naming a model here does not hide the others, so this cannot be used as an allowlist. Accepts plain model id strings (`["gpt-4o", "claude-sonnet-4"]`) or full models.dev-style objects with all schema fields (limits, cost, modalities, capabilities). See [Model configuration](#model-configuration-models--custommodels) below. |
| `autoDiscoverModels` | `boolean` | provider default | Fetch `{baseUrl}/v1/models` at startup and merge the result into the catalog. On by default for gateway-style providers (`ai-gateway`, `openrouter`, `omniroute`). See [Model discovery](#model-discovery) below. |
| `customModels` | `Record<string, CustomModelDefinition>` | — | Per-model metadata overrides. Keys are model ids. Each entry can carry `name`, `maxOutput`, `capabilities`, and `modelsDev` (full models.dev schema payload). See [Model configuration](#model-configuration-models--custommodels) below. |
| `quirks` | `Record<string, unknown>` | — | Provider-specific behavior flags. See [CompatibilityQuirks](#compatibility-quirks) below. |
| `capabilities` | `Record<string, unknown>` | — | Override reported capabilities (e.g. `maxContext`, `vision`). |

### Model discovery

Gateway-style providers front hundreds of models and add new ones continuously,
so their model list is **discovered at runtime, not read from models.dev**. At
startup each provider with `autoDiscoverModels` enabled and a resolvable base
URL has its `/v1/models` endpoint fetched; the result is merged into the
in-memory catalog under that provider's own id. Every surface that reads the
catalog — the startup picker, `/model`, `/setmodel`, the WebUI selector and its
search — picks the models up automatically. Nothing is written to config.

The last successful fetch is cached, so a provider that is briefly unreachable
keeps its models across a restart. A failed fetch with no cache is a logged
no-op: startup never breaks because a gateway was down.

models.dev stays in the loop as an **enrichment** layer, not a gate. It supplies
context/output limits and pricing where it knows the model, and a model it has
never heard of is still fully usable — a capability the endpoint does not state
is treated as *unknown*, which inherits the transport's own baseline rather than
being read as *unsupported*. An endpoint that enumerates its supported
parameters and omits one is making a statement, and that IS honoured.

Set `autoDiscoverModels: false` to opt a provider out, or `true` (with a
`baseUrl`) to opt an arbitrary OpenAI-compatible endpoint in.

### Model configuration (`models` + `customModels`)

Provider model entries support two shapes — plain strings (legacy) and full models.dev objects (new):

#### Plain string allowlist (zero-migration)

```jsonc
{
  "providers": {
    "openai": {
      "type": "openai",
      "apiKey": "sk-...",
      "models": ["gpt-4o", "gpt-4o-mini", "o3"]
    }
  }
}
```

Models not in this list are hidden from pickers and fallback derivation. The catalog metadata (context window, pricing, capabilities) comes from the live models.dev registry automatically.

#### Inline model objects (full schema)

Each entry in `models` can be a full models.dev-style object with all schema fields:

```jsonc
{
  "providers": {
    "acme": {
      "type": "acme",
      "family": "openai-compatible",
      "apiKey": "sk-...",
      "models": [
        {
          "id": "acme-pro",
          "name": "Acme Pro",
          "description": "Full-featured model",
          "limit": { "context": 500000, "output": 64000 },
          "cost": { "input": 5, "output": 20, "cache_read": 0.5 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "tool_call": true,
          "reasoning": true,
          "temperature": true,
          "knowledge": "2025-06-01",
          "release_date": "2026-01-15"
        }
      ]
    }
  }
}
```

#### `customModels` overrides

Catalog models can be overridden field-by-field using `customModels`. Only the fields you set are overridden; untouched fields resolve from the live models.dev catalog at runtime (delta storage):

```jsonc
{
  "providers": {
    "openai": {
      "models": ["gpt-4o"],
      "customModels": {
        "gpt-4o": {
          "modelsDev": {
            "limit": { "context": 200000 }
          }
        }
      }
    }
  }
}
```

The same override shape works at the config **root** level, where it wins over provider-local entries for the same model id:

```jsonc
{
  "models": {
    "gpt-4o": {
      "name": "My GPT-4o",
      "modelsDev": { "limit": { "context": 128000 } }
    }
  },
  "providers": {
    "openai": { "models": ["gpt-4o"] }
  }
}
```

#### Resizable model fields (models.dev schema)

| Section | Fields | Description |
|---|---|---|
| **Identity** | `id`, `name`, `description`, `family` | Model identification |
| **Limits** | `limit.context`, `limit.output`, `limit.input` | Token limits (0 is valid) |
| **Pricing** | `cost.input`, `cost.output`, `cost.cache_read`, `cost.cache_write` | USD per 1M tokens |
| **Modalities** | `modalities.input[]`, `modalities.output[]` | String arrays: `"text"`, `"image"`, `"audio"`, `"video"`, `"pdf"` |
| **Capabilities** | `tool_call`, `reasoning`, `temperature`, `attachment`, `structured_output`, `open_weights` | Boolean flags |
| **Dates** | `release_date`, `last_updated`, `knowledge` | ISO date strings |

> **Note:** `modalities.input` and `modalities.output` are plain string arrays — `modalities.input[0]` is `"text"` (a string), not an object.

#### Precedence

Metadata resolution order (highest wins):

1. **Top-level `config.models`** — per-model overrides from the config root (`mergeCustomModelDefs`; wins over provider-local entries for the same id)
2. **`providers.<id>.customModels`** — per-field overrides from config (inline models.dev-style objects in `models[]` are normalized into this layer at load)
3. **models.dev catalog** — live registry data (refreshed at boot)
4. **Wire-family defaults** — hardcoded per provider family

#### Reset to catalog values

Both the WebUI ModelListEditor and TUI `/auth` panel support resetting a model's overrides back to the live models.dev catalog values. This drops the `customModels` entry for that model id so the runtime falls back to fresh catalog data.

Wire-level behavior flags for OpenAI-compatible and family-overridden providers. Set them under the `quirks` key on any provider config entry. All quirks are optional.

```jsonc
{
  "providers": {
    "my-proxy": {
      "type": "openai-compatible",
      "apiKey": "sk-...",
      "baseUrl": "https://proxy.example.com/v1",
      "quirks": { "maxTools": 128 }
    }
  }
}
```

| Quirk | Type | Description |
|---|---|---|
| `maxTools` | `number` | Maximum tool definitions the provider accepts per request. When the registered tool count exceeds this limit, lower-priority tools are filtered out before the request is sent. Priority is name-based: core file/shell tools (`read`, `write`, `edit`, `bash`, `exec`, `grep`, `glob`) are kept last; diagnostic tools ending in `_status` or `_test` are dropped first. If a `tool_choice` pin points to a filtered-out tool, it falls back to `auto`. A warning is logged on first use listing the dropped tool names. Applies to all wire families (OpenAI, Anthropic, Google). |
| `stripCacheControl` | `boolean` | Strip `cache_control` annotations from system prompt blocks before sending. Use for providers that reject Anthropic-style cache breakpoints. |
| `systemAsMessage` | `boolean` | Send the system prompt as the first user message instead of the `system` field. Some compatible endpoints do not support a top-level `system` parameter. |
| `flattenContentToString` | `boolean` | Flatten structured message content to plain strings. Needed by endpoints that only accept `content: string` and reject `content: ContentBlock[]`. |
| `preserveToolCallIds` | `boolean` | Preserve tool-call IDs verbatim. Some endpoints assign their own IDs and reject client-provided ones. |
| `parallelToolsDisabled` | `boolean` | Disable parallel tool calls. Set for endpoints that return errors when multiple tool calls appear in a single response. |
| `thinkingParam` | `'zai-glm' \| 'kimi-toggle' \| 'always-on'` | Control how thinking/reasoning parameters are serialized. `zai-glm` maps effort to Z.AI's `reasoning_effort` values; `kimi-toggle` uses Kimi's `{ type: 'enabled' }` toggle; `always-on` suppresses disabled-thinking parameters for models that reject them. |
| `stripThinkTags` | `boolean` | Route literal `<think>` tags to the thinking channel and drop stray closers. For models that emit raw think tags in content instead of structured thinking blocks. |

---

## `context` — Context window management

Controls compaction behavior, token thresholds, and context window modes.

```jsonc
{
  "context": {
    "mode": "balanced",
    "warnThreshold": 0.6,
    "softThreshold": 0.75,
    "hardThreshold": 0.9,
    "autoCompact": true,
    "preserveK": 10,
    "eliseThreshold": 2000,
    "strategy": "hybrid",
    "llmSelector": false,
    "effectiveMaxContext": 200000,
    "maxSessionTokens": 1000000,
    "maxDailyTokens": 5000000
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `mode` | `string` | `"balanced"` | Context window policy. One of: `balanced`, `frugal`, `deep`, `archival`. Switch at runtime with `/context mode`. |
| `warnThreshold` | `number` | `0.6` | Fraction of context window that triggers a warning. Runtime override: `/context thresholds`. |
| `softThreshold` | `number` | `0.75` | Fraction that triggers soft compaction. Runtime override: `/context thresholds`. |
| `hardThreshold` | `number` | `0.9` | Fraction that triggers aggressive compaction and hard-overflow protection. Runtime override: `/context thresholds`. |
| `autoCompact` | `boolean` | `true` | Automatically compact when thresholds are crossed. |
| `preserveK` | `number` | `10` | Number of recent message pairs to preserve during compaction. |
| `eliseThreshold` | `number` | `2000` | Token count above which old tool results are elided (a token count, not a fraction). |
| `strategy` | `string` | `"hybrid"` | Compaction strategy. `hybrid` (default) is **lossless rule-based, no LLM** — it elides oversized old tool results and collapses ancient turns into a digest that keeps all text and drops only raw tool I/O (still in the session log). `intelligent` adds LLM summarization (needs a provider; falls back to the lossless digest on failure). `selective` adds LLM-driven keep/collapse selection. |
| `llmSelector` | `boolean` | `false` | Shortcut for `strategy: "selective"` when `strategy` is unset. An explicit `strategy` wins. |
| `effectiveMaxContext` | `number` | provider-reported or unknown for custom `baseUrl` | Override the effective context window size in tokens. Use this for proxies/account-gated endpoints whose real limit differs from models.dev. Runtime override: `/context limit`. |
| `maxSessionTokens` | `number` | — | Maximum tokens per session. |
| `maxDailyTokens` | `number` | — | Maximum tokens per day. |
| `summarizerModel` | `string` | active model | Model used for LLM-assisted summarization. |

### Context modes

| Mode | Behavior |
|---|---|
| `balanced` | Default rolling compaction; preserves recent tail, trims old heavy tool output. |
| `frugal` | Token-saver; compacts early, keeps a tighter verbatim tail. |
| `deep` | Long-reasoning; delays compaction, keeps more recent turns intact. |
| `archival` | Decision-preserving; compacts steadily, keeps summaries prominent. |

---

## `tools` — Tool execution settings

```jsonc
{
  "tools": {
    "defaultExecutionStrategy": "smart",
    "maxIterations": 100,
    "iterationTimeoutMs": 300000,
    "sessionTimeoutMs": 1800000,
    "perIterationOutputCapBytes": 1048576,
    "autoExtendLimit": true,
    "loopDetection": {
      "mode": "steer-then-cut",
      "steerThreshold": 3,
      "cutThreshold": 5,
      "windowSize": 12,
      "callRepeatThreshold": 4
    }
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `defaultExecutionStrategy` | `string` | `"smart"` | `parallel` (all at once), `sequential` (one by one), `smart` (auto). |
| `maxIterations` | `number` | `100` | Soft limit on agent loop iterations. Auto-extends when `autoExtendLimit` is true. |
| `iterationTimeoutMs` | `number` | `300000` | Per-iteration timeout (5 minutes). |
| `sessionTimeoutMs` | `number` | `1800000` | Total session timeout (30 minutes). |
| `perIterationOutputCapBytes` | `number` | `1048576` | Max output bytes per iteration (1 MB). Excess is truncated. |
| `autoExtendLimit` | `boolean` | `true` | Automatically extend iteration limit by 100 when hit. |
| `loopDetection` | `object` | see below | Agent-loop repetition detector. All fields optional. |

### `tools.loopDetection`

The detector watches two signals: consecutive effectively-identical iterations (same tool-name set + inputs + text) and per-call repeats — the same tool invoked with identical arguments N times within a sliding window, even when interleaved with other calls (e.g. re-reading the same file for the 4th time).

| Field | Type | Default | Description |
|---|---|---|---|
| `mode` | `string` | `"steer-then-cut"` | `steer-then-cut`: inject a corrective `[loop-detector]` note at the steer threshold, end the turn only if repetition persists to the cut threshold. `cut`: legacy hard-stop at the steer threshold (per-call detector off). `off`: disable detection. |
| `steerThreshold` | `number` | `3` | Consecutive identical iterations before the detector acts (min 2). |
| `cutThreshold` | `number` | `5` | Consecutive identical iterations at which the turn is cut in `steer-then-cut` mode (min `steerThreshold + 1`). |
| `windowSize` | `number` | `12` | Sliding window of recent tool calls for per-call repeat detection (min 4). |
| `callRepeatThreshold` | `number` | `4` | Identical (name + canonicalized args) calls within the window that trigger a steer note (min 2). |

Every detection emits a `tool.loop_detected` event with `action` (`steer`/`cut`) and `scope` (`iteration`/`call`) so UIs can render a warning chip.

---

## `mcpServers` — MCP server configuration

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "enabled": true,
      "allowedTools": ["read_file", "write_file", "list_directory"],
      "permission": "confirm"
    },
    "github": {
      "name": "github",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "enc:v1:..."
      },
      "enabled": false
    }
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | *(required)* | Server name. Used in tool namespace: `mcp__<name>__<tool>`. |
| `transport` | `string` | *(required)* | `stdio`, `sse`, or `streamable-http`. |
| `command` | `string` | — | Command to spawn (stdio transport). |
| `args` | `string[]` | — | Arguments for the command. |
| `env` | `Record<string, string>` | — | Environment variables for the subprocess. API keys auto-encrypted. |
| `url` | `string` | — | Server URL (sse/streamable-http transport). |
| `headers` | `Record<string, string>` | — | Extra HTTP headers (sse/streamable-http transport). |
| `enabled` | `boolean` | `false` | Whether to connect at startup. |
| `allowedTools` | `string[]` | all tools | Restrict which tools are registered. |
| `permission` | `string` | `"confirm"` | Default permission for MCP tools: `auto`, `confirm`, `deny`. |
| `startupTimeoutMs` | `number` | `10000` | Timeout for initial connection. |
| `requestTimeoutMs` | `number` | `60000` | Timeout for individual tool calls. |
| `tls.ca` | `string` | — | Path to CA certificate file (HTTPS transports). |
| `tls.rejectUnauthorized` | `boolean` | `true` | Verify server certificate (set `false` for self-signed). |

### Built-in presets

WrongStack ships with a set of built-in MCP server presets. Use
`wrongstack mcp add <name>` to add one to your config:

| Preset | Description | Default `permission` | Auto-enabled? |
|---|---|---|---|
| `filesystem` | Read/write/navigate local filesystem | `confirm` | No |
| `github` | GitHub API — issues, PRs, repos, search | `confirm` | No |
| `context7` | Codebase-aware documentation (context7.ai) | `confirm` | No |
| `brave-search` | Web search (requires `BRAVE_SEARCH_API_KEY`) | `confirm` | No |
| `block` | Postgres database access via SQL | `confirm` | No |
| `everart` | AI image generation | `confirm` | No |
| `slack` | Slack messaging, channels, search | `confirm` | No |
| `aws` | EC2, S3, Lambda, IAM, CloudFormation | `confirm` | No |
| `google-maps` | Directions, geocoding, places | `confirm` | No |
| `sentinel` | Security vulnerability scanning | `deny` | No |
| `zai-vision` | Image analysis, screenshot understanding | `auto` | No |
| `minimax-vision` | MiniMax image understanding (read-only) | `auto` | No |
| **`playwright`** | Browser automation — navigate, screenshot, click, type, evaluate JS | `confirm` | No |
| **`ssh`** | Remote SSH — execute commands, transfer files, tunnels, health checks | `confirm` | No |

Playwright and SSH are opt-in presets. Add and enable only the MCP servers you
want available in a session.

SSH requires the `mcp-ssh-manager` host configuration. After adding the preset,
set your server credentials in `~/.ssh-manager/.env`:

```env
SSH_SERVER_PRODUCTION_HOST=prod.example.com
SSH_SERVER_PRODUCTION_USER=deploy
SSH_SERVER_PRODUCTION_KEYPATH=~/.ssh/prod_deploy
```

Then enable it:
```bash
wrongstack mcp add ssh
/mcp enable ssh
```

For the full preset reference and usage, see [subcommands/mcp.md](subcommands/mcp.md).

---

## `fallbackModels` — Overload fallback chain

When the active model returns an overload error (HTTP 429/529/5xx) and its own
retry policy is exhausted, the agent switches to the next entry in this list and
retries the same turn. Entries may cross providers. After a successful fallback,
the agent stays on that fallback while the primary is cooling down instead of
re-probing it on every new turn. When the cooldown expires, the primary is tried
as a half-open probe; a successful probe restores the primary, while another
overload extends the cooldown up to the cap.

```jsonc
{
  "provider": "anthropic",
  "model": "claude-opus-4-8",
  "fallbackBridge": "openai/gpt-5.4-mini",
  "fallbackModels": [
    "anthropic-test-model",      // same provider, bare model id
    "openai/gpt-5.4",         // cross-provider (provider must have credentials)
    "groq llama-3.3-70b-versatile"
  ]
}
```

CLI override (comma-separated): `wrongstack --fallback-model "anthropic-test-model,openai/gpt-5.4"`.

A fallback entry whose provider has no resolvable credentials is skipped (with a
warning) and the chain continues. Each switch emits a `provider.fallback` event.
The bridge must include both provider and model. With automatic fallback on,
configured usable models beyond the four-entry smart preview remain available
as an uncapped last-resort tail.

---

## `modelRuntime` — Request runtime controls

`modelRuntime` applies runtime request knobs across REPL, TUI, and WebUI. The
request pipeline maps the object into provider `Request` fields and gates every
field against the active model's advertised capabilities, so unsupported knobs
are omitted instead of being sent to the provider.

```jsonc
{
  "modelRuntime": {
    "reasoning": {
      "mode": "auto",        // auto | on | off
      "effort": "high",      // none | minimal | low | medium | high | xhigh | max
      "preserve": false
    },
    "cache": {
      "ttl": "1h",           // 5m | 1h — Anthropic explicit-cache TTL
      "geminiExplicit": false // opt-in Gemini server-side cachedContents (see below)
    },
    "parameters": {
      "topK": 40,
      "frequencyPenalty": 0,
      "presencePenalty": 0,
      "seed": 1234,
      "user": "local-dev"
    }
  }
}
```

`reasoning.mode: "auto"` means WrongStack does not send an explicit
enable/disable field and the provider/model default wins. `"on"` requests
reasoning when supported. `"off"` requests disable only for models that advertise
safe disable support.

The TUI `/settings` picker and WebUI Settings panel expose the top-level
reasoning and cache controls. Use `modelMatrix[*].modelRuntime` for
role-specific subagent overrides.

### Prompt caching across providers

Caching is provider-agnostic. Each request carries a stable cache-partition key
derived from the frozen system-prompt prefix, which each wire maps to its own
mechanism:

- **Anthropic** (`cacheControl: native`) — explicit `cache_control` breakpoints
  (capped at Anthropic's 4-breakpoint limit) with the `cache.ttl` above.
- **OpenAI / GitHub Copilot** (`cacheControl: auto`) — the key is sent as
  `prompt_cache_key` so automatic prompt caching hits on load-balanced backends.
- **DeepSeek** — automatic server-side caching needs no client key; nothing to set.
- **Google Gemini** — *implicit* caching works automatically on a byte-stable
  prefix (no setup). Set `cache.geminiExplicit: true` to also create a
  server-side `cachedContents` resource for the system instruction + tool defs
  and reference it by name each turn (bigger savings on large stable prefixes).
  It is best-effort: any failure falls back to a normal inline request, so
  enabling it can never break a call.

Real cache-hit ratio (read/write tokens) is shown in `/context`.

---

## `modelMatrix` — Per-role subagent routing

`modelMatrix` maps subagent roles, phase names, or `*` to a model target and/or
runtime override. It is resolved at subagent spawn time in this order:

```
exact role -> role phase -> * -> leader model
```

Entries may select a provider/model, use a named fallback profile, override only
runtime settings, or combine those fields:

```jsonc
{
  "fallbackProfiles": {
    "cheap-review": ["openai/gpt-5-mini", "groq/llama-3.3-70b-versatile"]
  },
  "modelMatrix": {
    "security-scanner": {
      "provider": "minimax",
      "model": "minimax-m3",
      "modelRuntime": { "reasoning": { "mode": "on", "effort": "high" } }
    },
    "bug-hunter": {
      "modelRuntime": { "reasoning": { "mode": "on", "effort": "low" } }
    },
    "review": {
      "fallbackProfile": "cheap-review",
      "modelRuntime": { "reasoning": { "preserve": false } }
    },
    "*": {
      "model": "claude-haiku-4-5"
    }
  }
}
```

When `modelRuntime` is present without a model, the subagent inherits the leader
provider/model but uses the role-specific runtime controls. Configure this from
the CLI with `/setmodel reasoning ...` or from WebUI Settings -> Model Routing.

---

## `hooks` — Lifecycle hooks

Command or HTTP handlers run at lifecycle points (`PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, `SessionStart`, `Stop`). The hook payload is written to the
command's stdin as JSON; a JSON `HookOutcome` on stdout (or exit code `2`)
steers the agent. `PreToolUse`/`PostToolUse` entries take a `matcher` (a
pipe-delimited tool-name list, or `*`).

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "name": "bash-safety",
        "matcher": "bash",
        "stage": "validate",
        "command": "bash ./scripts/guard-bash.sh",
        "timeoutMs": 3000,
        "failurePolicy": "closed",
        "policy": true
      }
    ],
    "PostToolUse": [
      { "matcher": "edit|write", "command": "npm run -s lint:staged" }
    ],
    "UserPromptSubmit": [
      { "command": "bash ./scripts/inject-context.sh" }
    ]
  }
}
```

`--no-hooks` disables ordinary automation; trusted entries with `policy: true`
remain active. `failurePolicy` defaults to `open`, so normal/YOLO work does not
gain new approval prompts. Plugins can register in-process hooks via
`api.registerHook(...)`. See [hooks.md](./hooks.md) for the full schema.

---

## `features` — Feature flags

```jsonc
{
  "features": {
    "mcp": true,
    "plugins": true,
    "memory": true,
    "modelsRegistry": true,
    "skills": true,
    "tokenSavingMode": "off"
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `mcp` | `boolean` | `true` | Load MCP servers declared in `mcpServers`. |
| `plugins` | `boolean` | `true` | Load npm plugins declared in `plugins`. |
| `memory` | `boolean` | `true` | Register `remember`/`forget` tools backed by memory store. |
| `modelsRegistry` | `boolean` | `true` | Fetch models.dev catalog at startup. Set `false` for offline use. |
| `skills` | `boolean` | `true` | Discover and load skills from disk. |
| `tokenSavingMode` | `TokenSavingTier` | `"off"` | Token-saving level for the system prompt. Controls tool count, description length, and guidance sections. |

### Token-saving tiers

`tokenSavingMode` replaces the old boolean `--token-saving-mode` flag with a multi-level system:

| Tier | Tools | Tool descriptions | Measured savings |
|------|-------|-----------------|------------------|
| `off` | All built-ins | 80 chars | 0 tokens (baseline) |
| `minimal` | 23 (TIER1 only) | 40 chars | ~2.6k tokens |
| `light` | 23 (TIER1 only) | 50 chars | ~2.1k tokens |
| `medium` | 43 (TIER1 + TIER2) | 60 chars | ~1.0k tokens |
| `aggressive` | 23 (TIER1 only) | 70 chars | ~1.1k tokens |

The five tiers optimize along two different axes; pick the one that matches
your use case rather than reading "savings" as monotonic:

- **Fewer tools + lots of guidance trimmed** — `minimal` (~2.6k saved), `light` (~2.1k saved). TIER1 only (23 tools). Best for focused edits and quick fixes.
- **Fewer tools + full guidance** — `medium` (~1.0k saved). TIER1+TIER2 (43 tools). Best for standard development where the model benefits from explicit delegation/mailbox guidance.
- **Fewer tools + compact guidance** — `aggressive` (~1.1k saved). TIER1 only (23 tools). Best when prompt real estate is tight: the tool set matches `minimal`/`light` while guidance blocks are compacted hardest. Context Management and Commit Hygiene remain at full because they're most useful under context pressure.

Every tier retains `codebase-stats`, `codebase-search`, and `codebase-index`, so token saving never forces broad `tree`/`grep`/`glob` exploration when a persisted index is available.

The original design doc estimated "~4-5k tokens saved at `aggressive`", but
that estimate assumed a much smaller tool set (~22 tools). The current
implementation keeps the wider tool set on purpose — dropping more tools at
`aggressive` would make it indistinguishable from a stricter version of
`medium`. The savings estimates above are empirical, measured by
`packages/cli/tests/token-saving-measurement.test.ts`.

Memory tools (`remember`, `forget`, `memory_search`, `memory_for_file`,
`memory_for_path`, and the other `memory_*` tools) are gated on
`features.memory`, not on the tier — they appear at every tier when memory is enabled
and at no tier when it is disabled.

CLI flags:
- `--token-saving-tier minimal` — set tier directly
- `--token-saving-mode` — still works, maps to `medium` tier (backward compatible)
- `--token-saving-tier off` — disable (same as omitting the flag)

In the TUI, use `/settings` and navigate to the **Token Saving** row. Press `←`/`→` to cycle through tiers. A `↻ Takes effect next session` hint appears because the setting requires a restart.

**Deprecated:** `true`/`false` boolean values for `tokenSavingMode` are still accepted and mapped: `true` → `"medium"`, `false` → `"off"`.

All flags are independent. `--no-features` sets all to `false`.

---

## `plugins` — Plugin configuration

```jsonc
{
  "plugins": [
    "@wrongstack/telegram",
    "@wrongstack/plug-lsp",
    {
      "name": "@yourorg/custom-plugin",
      "enabled": true,
      "options": {
        "port": 9090
      }
    },
    {
      "name": "wstack-plugin-x",
      "path": "~/.wrongstack/plugins/node_modules/wstack-plugin-x"
    }
  ]
}
```

Each entry is either a string (package name, always enabled) or an object:

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | *(required)* | npm package name or local path. |
| `enabled` | `boolean` | `true` | Whether to load the plugin. |
| `options` | `Record<string, unknown>` | — | Plugin-specific configuration. Validated against `configSchema` if declared. |
| `path` | `string` | — | Load from an explicit location instead of npm resolution: a relative path (anchored to the project root), an absolute path, or a `file:` URL. The target may be an entry file or a directory with `package.json` / `index.js`. `wstack plugin add <spec> --install` writes this field for you. |

External (third-party) plugins are additionally subject to trust-on-first-use
pinning: the first load records a SHA-256 of the entry file in
`~/.wrongstack/plugin-trust.json`, and a later load with a changed hash is
refused until `wstack plugin trust <name>` re-pins it. Disable the whole
mechanism with `features.pluginsTrust: false`. Plugins discovered under
`~/.wrongstack/plugins/<name>/` run by default; plugins under
`<projectRoot>/.wrongstack/plugins/<name>/` stay inactive until enabled
(a cloned repo never auto-executes local plugin code). See
[plugin-third-party.md](./plugin-third-party.md) for the full model.

---

## `log` — Logging

```jsonc
{
  "log": {
    "level": "info",
    "file": "~/.wrongstack/logs/wrongstack.log"
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `level` | `string` | `"info"` | Log level: `error`, `warn`, `info`, `debug`, `trace`. |
| `file` | `string` | auto | Log file path. Defaults to `~/.wrongstack/logs/wrongstack.log`. |

Override with `--verbose` (`debug`), `--trace` (`trace`), or `--log-level <level>`.

---

## `session` — Session logging & audit trail

Controls what gets persisted to the per-project session JSONL file
(`~/.wrongstack/projects/<hash>/sessions/<date>/sess_<ULID>.jsonl`).

```jsonc
{
  "session": {
    "auditLevel": "standard",
    "sampling": {
      "toolProgress": {
        "sampleRate": 8
      }
    }
  }
}
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `auditLevel` | `"minimal"` \| `"standard"` \| `"full"` | `"standard"` | How much detail is written to the persistent session log. |
| `sampling.toolProgress.sampleRate` | `number` | `8` | Sampling rate for high-volume `tool_progress` events (`log` / `partial_output`). `1` = no sampling. Only applies when `auditLevel` is `"full"`. |

### `auditLevel` values

- **minimal** — Only the absolute minimum required for resume, rewind and crash recovery (`user_input`, `llm_response`, `tool_result`, checkpoints, in-flight markers).
- **standard** (recommended) — Adds high-value lightweight audit events: `llm_request` (light), `tool_call_start`/`tool_call_end`, `compaction`, `error`, etc.
- **full** — Enables high-volume events such as `tool_progress` (streaming tool output). These events are heavily sampled by default to avoid log bloat.

### Sampling

When `auditLevel` is `"full"`, certain events (especially `tool_progress`) can generate thousands of lines. WrongStack applies smart sampling:

- `warning`, `metric`, `file_changed` → always recorded.
- `log` and `partial_output` → first message is kept, then every Nth message (controlled by `sampleRate`).

You can increase verbosity for debugging:

```jsonc
{
  "session": {
    "auditLevel": "full",
    "sampling": {
      "toolProgress": {
        "sampleRate": 2   // very chatty
      }
    }
  }
}
```

---

## `fleet.budget` — Lifetime spawn / token / cost ceilings

```jsonc
{
  "fleet": {
    "budget": {
      "maxSpawns": 64,
      "maxTokens": 2_000_000,
      "maxCostUsd": 25
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxSpawns` | `number` | `64` | **Lifetime** subagent spawn cap for a director run (not concurrency). Scoped to the current director run: a resumed/restarted session starts with a fresh budget — the historical used count is NOT restored from the checkpoint. |
| `maxTokens` | `number` | unlimited | Fleet-wide input+output token ceiling; new spawns refuse at the cap. |
| `maxCostUsd` | `number` | unlimited | Fleet-wide cost ceiling (USD); new spawns refuse at the cap. |

### Overrides (highest wins)

| Ceiling | CLI flag | Environment | Config |
|---------|----------|-------------|--------|
| Concurrent agents | `--max-concurrent <n>` | `WRONGSTACK_MAX_CONCURRENT` | top-level `maxConcurrent` |
| Lifetime spawns | `--max-spawns <n>` | `WRONGSTACK_MAX_SPAWNS` | `fleet.budget.maxSpawns` |

Inspect the **live** used/remaining values with `/fleet status` (Budget block),
the WebUI Agents summary bar, or HQ cockpit when a client publishes
`fleet.snapshot`. Static configured values only: `system_config_view({ section: "fleet" })`.

**Security:** `fleet` is stripped from in-project config. Configure budgets under
the active profile or project-private `config.local.json`.

---

## `fleet.lifecycle` — Subagent cleanup

```jsonc
{
  "fleet": {
    "lifecycle": {
      "idleTimeoutMs": 30000,
      "retireOnTaskComplete": true
    }
  }
}
```

`retireOnTaskComplete` removes a subagent as soon as its final task result has
been delivered, unless queued work reused that worker in the same dispatch
cycle. `idleTimeoutMs` is the fallback for a spawned or between-task worker
that remains idle; it defaults to 30 seconds. This lifecycle timeout is
separate from the in-task activity watchdog (`SubagentConfig.idleTimeoutMs`),
which resets on iterations, tool calls, and streamed progress.

Removal releases the Director bridge/coordinator entry and is broadcast to the
session registry, TUI, WebUI, and agent monitor so a retired worker is not kept
as an idle/completed live agent. Set `retireOnTaskComplete` to `false` to keep a
worker reusable until `idleTimeoutMs` expires. A value of `0` retires idle
workers on the next event-loop turn.

**Security:** `fleet` is stripped from in-project config. Configure this under
the active profile config or the project-private `config.local.json`.

---

## `pluginManager` — LLM plugin-state policy

```jsonc
{
  "pluginManager": {
    "locked": ["secret-scanner", "branch-guard"]
  }
}
```

Entries in `locked` remain visible and usable to the model, but the
`plugin_manager` tool cannot enable or disable them. Use `"*"` to lock every
plugin. Manage the list with `/plugin manager lock <name|*>` and
`/plugin manager unlock <name|*>`.

This is a human-owned trust setting: it affects only the LLM-facing manager,
not ordinary `/plugin` commands, and is stripped from repository-committed
project config. Store it in the active profile or private `config.local.json`.

---

## `extensions` — Per-plugin config namespaces

```jsonc
{
  "extensions": {
    "wstack-auth": {
      "tokenUrl": "https://auth.example.com/token",
      "refreshBefore": 300
    },
    "wstack-metrics": {
      "sink": "prometheus",
      "port": 9090
    }
  }
}
```

Each key is a plugin name. The value is a free-form object validated by the plugin's `configSchema`. Plugins read their namespace via `configStore.getExtension(pluginName)`.

### `wstack-chimera` — post-session code review

See [`/chimera`](slash/chimera.md) for full usage. The Chimera plugin runs a read-only review subagent at session end over all changed files.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Master switch. |
| `provider` | string | session provider | LLM provider for the review subagent. |
| `model` | string | session model | LLM model for the review subagent. |
| `maxFiles` | number | `15` | Max changed files per review. |
| `autoFix` | `off` \| `ask` \| `auto` | `off` | Follow-up policy (reports are always advisory). |
| `cascadeOn` | `off` \| `critical` \| `high` | `high` | Severity threshold for cascade re-checks. |
| `maxCascadeDepth` | number | `2` | Max cascade depth. |
| `fallbackModels` | string[] | `[]` | Chimera-specific fallback chain (`provider/model` refs), tried before the session-level chain. |
| `fallbackProfile` | string | — | Named profile from `fallbackProfiles`; its chain is merged into the reviewer ladder ahead of the session-level profile. |

#### Graceful-finish lifecycle (built-in, not configurable)

Chimera reviewers and cascade agents are not killed outright when their
wall-clock budget runs out. They run under a **graceful-finish** lifecycle
that replaces the watchdog's silent deadline kill with a notification plus a
grace window, so a mid-review agent can complete its own turn:

1. **Deadline crossing → notification, not kill.** When the review subagent's
   wall-clock budget is exhausted, the coordinator emits an in-band
   `subagent.finish_requested` note that the agent reads *between tool calls*
   (folded in like a `/btw` note, never as an interrupt) and grants a grace
   window — 120 s by default — of legitimate working time.
2. **The agent finishes its report in its own turn**, and that report is what
   is parsed, persisted, and mailed.
3. **Terminal stop only after the grace window.** A run that ignored the
   notification is stopped once its maximum lifetime is spent, so shutdown can
   never hang on a stalled reviewer. Ladder retries are unaffected: a rung
   that exhausts its grace window counts as a timeout and the next model on
   the ladder takes over.

At session end, before waiting on review work, shutdown notifies every
running review subagent that the leader has finished (`requestFinish`), so a
review already in flight accelerates to deliver its report instead of being
reaped. Only agents that have actually started working are notified — a
freshly spawned reviewer is never told to skip its review.

The same lifecycle is available to any custom subagent spawn via the
`gracefulFinish` option (`true`, or `{ "graceMs": 60000 }` for a custom grace
window). Omitting it keeps the default watchdog behavior (preemptive budget
extension, then a hard stop at the deadline).

---

## `brain` — Decision layer (autonomy, rules, council, trace)

The Brain is the authority layer between the agents and you. Every autonomous
subsystem routes its blocking decisions through it. Questions descend a ladder,
cheapest tier first, and stop at the first tier that can answer:

```
rules → policy/heuristics → cache → council → single LLM → escalation
```

Everything above `council` is free. `/brain stats` reports how the traffic
actually split — that number, not the model choice, is what governs Brain cost.

```jsonc
{
  "brain": {
    "mode": "headless",          // headless (never blocks on a human) | interactive
    "maxAutoRisk": "high",       // off | low | medium | high | all
    "models": ["anthropic/claude-haiku-4-5"],  // pool; default = your fallbackModels
    "strategy": "fallback",      // fallback | round-robin
    "decisionTimeoutMs": 15000,
    "humanTimeoutMs": 120000,    // interactive only; 0 = wait forever
    "terminalPolicy": "conservative"  // headless escalation: conservative | deny-all | continue-on-recommended
  }
}
```

### `brain.rules` — deterministic rule table

Evaluated **before** anything that costs tokens. First match wins; `defer`
hands the request on to the next tier, which is how you carve an exception out
of a broader rule.

```jsonc
{
  "brain": {
    "rules": [
      {
        "id": "monitor-observe-low",
        "description": "Let the agent continue on its own for low-risk monitor signals",
        "when": {
          "source": "system",          // goal | director | tool | user | system
          "maxRisk": "medium",         // also: risk, minRisk, fallback, hasOptions
          "offersOption": "continue",
          "question": "failed \\d+ times",   // case-insensitive regex
          "notQuestion": "\\bor\\b"          // negative guard
        },
        "then": { "action": "answer", "optionId": "continue" }
      }
    ]
  }
}
```

Actions: `answer` (needs `optionId` or `text`), `deny`, `escalate`, `defer`.

#### Why an unconfigured rule table changes nothing

Run `pnpm brain:workload` to see it. The report replays the real Brain call
sites through a live tier chain and counts **attempted provider calls**:

```
Default configuration (no brain.rules)
  12 decisions: 0 free (0%), 12 reached a model
```

Every real call site — director budget extensions, goal-completion verdicts,
merge-conflict resolution, all four BrainMonitor signals, all four fleet
supervisor signals — carries options and is at `medium` risk or above. That
combination defeats both built-in fast paths by design: `quickDecide` refuses
option-bearing requests (options are a structured choice, not a keyword
guess), and the low-risk policy path requires `risk: "low"`, which nothing in
the catalogue uses.

So the deterministic tier is a MECHANISM, not a default saving. It pays off
only once you tell it which of your questions do not need a model:

```jsonc
{
  "brain": {
    "rules": [
      {
        "id": "monitor-steer-on-signal",
        "when": { "source": "system", "offersOption": "steer", "maxRisk": "medium" },
        "then": { "action": "answer", "optionId": "steer" }
      },
      {
        "id": "fleet-defer-to-recommended",
        "when": { "source": "system", "offersOption": "act", "maxRisk": "medium" },
        "then": { "action": "answer", "optionId": "act" }
      }
    ]
  }
}
```

```
With that rule pack
  12 decisions: 8 free (67%), 4 reached a model
```

The four that still reach a model are the ones that should: extending a
budget, declaring a goal complete (twice) and resolving merge conflicts are
judgement calls, not pattern matches.

This pack is deliberately NOT a built-in default — `monitor-steer-on-signal`
always steers and `fleet-defer-to-recommended` can spawn or terminate
subagents. Both are reasonable for an unattended fleet and wrong for a
supervised one, so the choice stays yours. `brain.monitor.policy: "steer"`
achieves the first one without a rule.
An `answer` naming an option the request does not offer fails **open** — it
defers instead of inventing an option id. A `context` pattern never matches
when there is no context to inspect. An invalid regex disables only its own
rule and is reported through `/brain rules`.

### `brain.heuristics` — the built-in patterns

All default `true`; each is independently switchable.

| Field | Fires when |
|---|---|
| `lowRiskAutoAnswer` | low-risk request carrying a recommended option |
| `blockedResolved` | question mentions "blocked" + context shows an explicit resolution marker |
| `deadlockSkip` | "deadlock" + failed work units in context |
| `retryExhausted` | "failed"/"retry" + demonstrably exhausted retries |
| `continuePing` | bare continue/proceed question with no competing alternative |

`blockedResolvedMarkers` replaces the resolution vocabulary
(`["resolved","fixed","merged",…]`). Entries are matched as whole words and are
regex-**escaped**, so it is a word list, not a pattern.

### `brain.llm` — quality gate for the single-model tier

```jsonc
{
  "brain": {
    "llm": {
      "maxTokens": 200,            // a decision + one-sentence rationale
      "rejectUncertain": true,     // "I don't know" / empty is NOT an answer
      "minConfidence": 0,          // 0 = off; reject self-reported confidence below this
      "denyIsTerminal": "never",   // never | when-decided | always
      "circuitBreaker": { "failureThreshold": 3, "cooldownMs": 60000 }
    }
  }
}
```

`denyIsTerminal` exists because the tier reports three different things as
`deny`: a dead pool, an unparseable response, and a model that genuinely
refused. `when-decided` makes only the real refusal terminal.

The circuit breaker matters more than it looks: without it a dead pool costs
`models.length × decisionTimeoutMs` on **every** decision, forever.

### `brain.council` — multi-LLM panel

Convened for questions at or above `minRisk` (default `high`). Quorum, veto and
weighted majority are pure deterministic maths; only ties reach a judge model.

```jsonc
{
  "brain": {
    "council": {
      "enabled": true,             // default: ≥2 voters/pool models
      "minRisk": "high",
      "voters": ["anthropic/claude-haiku-4-5", "openai/gpt-5"],
      "quorum": 0.5,
      "approval": 0.5,
      "judge": "anthropic/claude-opus-4-8",
      "perCallTimeoutMs": 15000,
      "maxConcurrency": 3,         // 1..8
      "distinctness": "none",      // none | model | provider — warn on a non-diverse panel
      "seats": [                   // replaces the executor/skeptic(veto)/auditor rotation
        { "persona": "security", "veto": true },
        { "persona": "maintainer" }
      ]
    }
  }
}
```

A same-model "council" agrees with itself; `distinctness` surfaces that.

**Decision lenses.** Six ship built in: `executor` (progress), `skeptic`
(risk, veto by default), `auditor` (cost/evidence), `security` (trust
boundaries, veto by default), `maintainer` (complexity/compatibility) and
`user-advocate` (usability/recovery). List them with `/brain council personas`.
Any *other* string is registered as an ad-hoc lens whose instruction is the
string itself — `{ "persona": "weigh tail latency above all else" }` is a valid
seat.

Every knob above is editable live from all three surfaces: `/brain council …`,
the TUI `/brain` panel, and the WebUI Brain settings section.

### `tools.council` — the agent-callable `council` tool

Distinct from `brain.council`: that panel is convened *by the Brain* on
high-risk questions, this one is invoked *by the agent* through the `council`
tool. It ships three profiles — `balanced`, `fast`, `risk-review` — and this
block extends them.

```jsonc
{
  "tools": {
    "council": {
      "defaultProfile": "balanced", // used when a call names no profile
      "maxConcurrency": 3,          // 1..8
      "personas": [
        {
          "id": "latency-hawk",
          "name": "Latency Hawk",
          "description": "Weighs tail latency above all else.",
          "instruction": "Judge every option by its effect on p99 latency.",
          "defaultVeto": false
        }
      ],
      "profiles": [
        {
          "id": "latency-panel",
          "seats": [{ "persona": "latency-hawk" }, { "persona": "skeptic" }],
          "judge": false,
          "distinctness": "provider"
        }
      ]
    }
  }
}
```

Seats route by **role** (`{ "target": { "role": "critic" } }`), resolved through
`modelMatrix`. Without a matrix entry the router falls back to capability
heuristics over your configured providers, and finally to the session model — so
a single-provider setup produces a single-model panel, which `distinctness`
reports.

> **Security.** `tools.council` is on the in-project deny list. A persona's
> `instruction` is rendered into the voter *system* prompt and a profile seat can
> pin a `providerId`/`model`, so a repo-committed `.wrongstack/config.json`
> could otherwise inject system instructions into every seat and reroute the
> calls. Only the active-profile config is honoured. A malformed block is
> reported and falls back to the built-ins rather than failing tool registration.

### `brain.cache` — replay repeated verdicts

```jsonc
{ "brain": { "cache": { "enabled": false, "ttlMs": 300000, "maxEntries": 200 } } }
```

Only `council`/`llm` verdicts are cached — deterministic tiers are already free
and `ask_human` is a request for input, not a verdict. A decision the ledger
later observes to have **failed** is evicted, so the cache cannot cement a bad
call.

### `brain.trace` — replayable decision log

```jsonc
{
  "brain": {
    "trace": {
      "enabled": false,            // opt-in: this writes decision content to disk
      "path": "<project>/.wrongstack/brain-trace.jsonl",
      "content": "full",           // none | redacted | full
      "maxOpenRecords": 200
    }
  }
}
```

One JSONL row per decision: every tier the ladder ran, every pool target it
called (**including the failures the fallback loop otherwise swallows**), every
council seat's vote, timings and token totals. Rows convert to replayable
evaluation fixtures via `brainTraceToEvaluationCase()`.

`content: "none"` still records models, timings, tokens, vote ids and
quorum/veto — enough to answer "what is the LLM doing" without storing any
production text.

### `brain.ledger` — outcome memory + deterministic guard

```jsonc
{
  "brain": {
    "ledger": {
      "enabled": true,
      "autoDenyAfterFailures": 3,      // 0 disables the guard
      "maxMemoryEntries": 500,
      "interventionRetryWindowMs": 600000
    }
  }
}
```

Records each decision and correlates it with its real-world outcome. Once the
last N approvals of a decision group all ended in observed failures, the guard
denies outright — no model call. A later success lifts it automatically.

### `brain.monitor` — self-activation

Watches the event bus for distress signals and consults the Brain proactively.

```jsonc
{
  "brain": {
    "monitor": {
      "enabled": true,
      "policy": "llm",               // llm | steer | observe
      "signals": { "toolFailureStreak": true, "errorStorm": true, "agentStall": true, "fileChurn": true },
      "toolFailureStreak": 3,
      "errorStormCount": 4,
      "errorStormWindowMs": 60000,
      "stallMs": 300000,             // 0 disables
      "stallCheckIntervalMs": 30000,
      "fileChurnThreshold": 5,
      "fileChurnWindowMs": 600000,
      "fileEditTools": ["edit", "write", "patch"],
      "cooldownMs": 120000
    }
  }
}
```

`policy: "steer"` / `"observe"` resolve signals with **no model call at all**.
Monitor engagements can also be made deterministic while staying on `"llm"` by
adding a `brain.rules` entry matching `source: "system"`.

`fileEditTools` **replaces** the built-in list — set it if your edit tools are
named differently, or the churn signal will never fire for them.

The monitor is constructed at boot, so `monitor` changes apply on the next
session; every other `brain` field applies live.

**Security:** `brain` is on the in-project config deny list — a repo-committed
`.wrongstack/config.json` cannot raise the autonomy ceiling, switch the Brain
to headless, enable the trace, or point decisions at an attacker-chosen
provider. Only the trusted active-profile config is honoured. Manage at runtime
with `/brain` (see `docs/slash/brain.md`).

---

## `git` — Agent git behavior

```jsonc
{
  "git": {
    "identity": {
      "name": "Alt Name",          // optional — falls back to git config
      "email": "alt@example.com"   // optional — falls back to git config
    }
  }
}
```

`git.identity` sets the commit author/committer for **every git command WrongStack runs** (the `git` tool, `bash`/`exec` shells, worktree operations, plugins). It is injected as `GIT_AUTHOR_NAME/EMAIL` + `GIT_COMMITTER_NAME/EMAIL` environment variables on child processes, so:

- your repo/global `git config` is never modified;
- commits you make yourself in a normal terminal are unaffected;
- push credentials (`gh` auth, credential helpers) are unaffected — only the identity written into the commit changes.

When unset, git's own configuration applies (default behavior). Manage at runtime with `/gitid`:

```
/gitid                          # show the identity in effect
/gitid set Alt Name alt@example.com
/gitid set alt@example.com      # email only
/gitid set ... --session        # apply without persisting
/gitid clear
```

**Security:** `git` is on the in-project config deny list — a repo-committed `.wrongstack/config.json` cannot set it (commit-identity spoofing). Only the trusted active profile config is honoured.

---

## Environment variables

| Variable | Description |
|---|---|
| `<PROVIDER>_API_KEY` | API key for the provider (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). |
| `WRONGSTACK_LOG_LEVEL` | Override log level (`error`, `warn`, `info`, `debug`, `trace`). |
| `WRONGSTACK_FETCH_ALLOW_PRIVATE` | Set `1` to allow localhost/private IPs in the `fetch` tool. |
| `WRONGSTACK_BASH_ENV_PASSTHROUGH` | Set `1` to disable the bash-tool env allowlist (legacy unsafe mode). |
| `WRONGSTACK_CHILD_ENV_PASSTHROUGH` | Set `1` to opt back to old child-process env behavior. |
| `WRONGSTACK_SHELL` | Windows only. Force the shell the `bash` tool uses: `cmd`/`cmd.exe`, `powershell`/`powershell.exe`, or `pwsh`/`pwsh.exe`. When unset, WrongStack pins one shell for the session at boot — **PowerShell by default** (pwsh 7+ if present, else Windows PowerShell 5.1) — and tells the model to write that shell's syntax. Set `WRONGSTACK_SHELL=cmd` to opt back into cmd.exe. See [Windows shell selection](#windows-shell-selection-wrongstack_shell). |
| `WRONGSTACK_INDEX_QUESTION_THRESHOLD` | File-count threshold for the "Run codebase indexing now?" pre-launch prompt. Default `500`. Set to a high number to suppress the question. |
| `WRONGSTACK_MAX_CONCURRENT` | Max concurrent subagents (default `4`). Overridden by `--max-concurrent`. Profile alternative: top-level `maxConcurrent`. |
| `WRONGSTACK_MAX_SPAWNS` | Lifetime director spawn cap (default `64`). Overridden by `--max-spawns`. Profile alternative: `fleet.budget.maxSpawns`. Live used/remaining: `/fleet status`. |
| `WRONGSTACK_HQ_URL` | HQ command center URL for telemetry publishing (e.g. `http://localhost:3499`). When set, CLI/REPL/TUI/WebUI/SimpleUI hosts connect to this HQ and publish mailbox events, fleet snapshots, and client lifecycle telemetry. See [HQ Command Center Plan](./plans/hq-command-center-2026-06.md). |
| `WRONGSTACK_HQ_TOKEN` | Client enrollment token for HQ authentication. Required for non-loopback HQ servers. Passed as `?token=` on the outbound `/ws/client` WebSocket. |
| `WRONGSTACK_HQ_ENABLED` | Set `1` to force HQ publishing even when `WRONGSTACK_HQ_URL` is unset (defaults to `http://localhost:3499`). Set `0` to explicitly disable when `WRONGSTACK_HQ_URL` is set. |
| `WRONGSTACK_HQ_RAW_CONTENT` | Raw prompt/tool/mailbox content publishing to HQ. **Defaults on for every HQ target** unless explicitly disabled. Set `0` to force raw-content redaction. |
| `WRONGSTACK_HQ_PROJECT_ALIAS` | Optional HQ display name and legacy identity fallback (config equivalent: `hq.projectAlias`). A committed `.wrongstack/project.json` takes precedence for identity. |
| `METRICS_HOST` | Prometheus metrics bind address (default `127.0.0.1`). |
| `NO_COLOR` | Disable ANSI color output. |

### HQ command center

The HQ command center (`wstack --hq`) is a project-independent observability and control layer. See the full architecture and deployment guide in [plans/hq-command-center-2026-06.md](./plans/hq-command-center-2026-06.md).

**Start HQ:**

```bash
wstack --hq                      # localhost:3499
wstack --hq --host 0.0.0.0       # LAN access
wstack --hq --port 8080 --open   # custom port + open browser
```

**Connect clients to HQ:**

```bash
# All clients (CLI/REPL, TUI, WebUI, SimpleUI) auto-publish telemetry when HQ_URL is set:
export WRONGSTACK_HQ_URL=http://localhost:3499
export WRONGSTACK_HQ_TOKEN=<enrollment-token>   # required for remote HQ
wstack

# Optional human-readable name. Project identity comes from the repository.
export WRONGSTACK_HQ_PROJECT_ALIAS=my-project
```

The config-file equivalent is:

```jsonc
{
  "hq": {
    "projectAlias": "my-project"
  }
}
```

WrongStack initializes a committed `.wrongstack/project.json` containing a stable `proj_<ULID>`. Commit that file once; every clone, worktree, and fork that retains it joins the same HQ project and synchronizes the same Kanban records. `hq.projectAlias` controls the display name when the committed identity exists.

Use `wstack project id` to inspect the identity, `wstack project init` to create a missing file, and `wstack project rekey --yes` only when a fork should become an independent HQ project. When the committed file is absent, WrongStack retains the legacy fallback: `hq.projectAlias` when configured, otherwise a hash of the absolute project path.

**Defaults:** when `WRONGSTACK_HQ_URL` is unset, clients attempt same-machine HQ discovery and remain dormant when no live HQ is advertised; set `WRONGSTACK_HQ_ENABLED=0` (or `hq.enabled: false`) to opt out. Mailbox send/ack/register/heartbeat events are the primary telemetry source. Raw content publishing defaults on for HQ targets; set `WRONGSTACK_HQ_RAW_CONTENT=0` (or `hq.rawContent: false`) to redact it. Secret scrubbing and sensitive-field masking still apply.

### Windows shell selection (`WRONGSTACK_SHELL`)

The `bash` tool historically ran everything through `cmd.exe` on Windows. That works for `echo`, `dir`, `set`, and other internal commands, but fails on PowerShell cmdlets (`Get-Content`, `Set-Location`, …) with "'Get-Content' is not recognized as an internal or external command." It also left a gap: the model was never told which shell it was writing for, so it would emit bash-isms (`2>/dev/null`, `rm -rf`, here-docs) that the heuristic then had to guess at.

WrongStack now **pins one shell for the whole session at boot** and tells the model exactly which shell + syntax to use (a guidance block in the system-prompt Environment section). One stable target replaces per-command guessing.

**Selection precedence** (Windows only):

1. **`WRONGSTACK_SHELL` override** — if you set it to `cmd`/`cmd.exe`, `powershell`/`powershell.exe`, or `pwsh`/`pwsh.exe` (case-insensitive), that shell is used unconditionally and left untouched. Unknown values (typos, other shells) are **silently ignored**.
2. **Session default (boot-time pin)** — when `WRONGSTACK_SHELL` is unset, boot resolves one shell and exports it: **PowerShell 7 (`pwsh`)** when `pwsh.exe` is on `PATH`, else **Windows PowerShell 5.1 (`powershell`)**, else `cmd.exe`. Because this is written back into `WRONGSTACK_SHELL`, every command in the session — and the system prompt's `Shell:` line and syntax guidance — agree on it.
3. **Per-command auto-detection (fallback)** — only reached when `WRONGSTACK_SHELL` is somehow still unset (e.g. an embedding that did not run boot). If the command "looks like" PowerShell (see below), it runs there; otherwise `cmd.exe`.

This is a deliberate behavior change: the Windows default is now **PowerShell**, not `cmd.exe`. To keep the old cmd.exe behavior, set `WRONGSTACK_SHELL=cmd`.

On non-Windows the picker is a no-op; the tool routes through `/bin/bash -c` and no session pin is applied (`WRONGSTACK_SHELL` there is treated by `bash.ts` as an explicit shell binary path, unchanged).

**Advisory bash-ism guard.** As a final safety net for models that ignore the prompt guidance, when a Windows `bash`-tool command **exits non-zero**, WrongStack scans it for POSIX idioms the resolved shell can't accept (`/dev/null`, `export`, heredocs, `&&` on PowerShell 5.1, `rm -rf`, `which`, …) and appends a short `[wrongstack]` hint with the correct replacement so the model can rewrite and retry. It is **advisory only** — never rewrites or blocks the command — and is **failure-coupled**, so it stays silent on success (PowerShell aliases like `ls`/`cat` work) and never fires on POSIX.

### `exec` tool command allowlist (`tools.exec`)

The `exec` tool — the safer, structured alternative to `bash` — only runs commands on a curated allowlist. The defaults cover the common dev/build toolchains:

- **JS/TS:** `node`, `npm`, `pnpm`, `yarn`, `npx`, `bun`, `deno`, `corepack`, `tsc`, `tsx`, `ts-node`, `vite`, `vitest`, `jest`, `biome`, `eslint`, `prettier`, `turbo`, `nx`, `webpack`, `rollup`, `parcel`, `next`, `astro`, `playwright`, `cypress`
- **Go:** `go` · **Rust:** `cargo`, `rustc` · **Python:** `python`, `python3`, `pip`, `pip3`, `pytest`, `ruff`, `mypy`, `uv`, `uvx`, `poetry`, `hatch`, `tox`
- **Ruby:** `ruby`, `gem`, `bundle` · **PHP:** `php`, `composer`, `phpunit` · **JVM:** `java`, `javac`, `mvn`, `gradle`, `gradlew` · **.NET:** `dotnet`
- **Native:** `make`, `cmake` · **VCS:** `git` · **Containers:** `docker`, `podman`, `kubectl`
- Common POSIX file/text utilities (`pwd`, `ls`, `cat`, `head`, `tail`, `grep`, `rg`, `find`, `sed`, `awk`, …)

Extend or trim the list in config:

```jsonc
// ~/.wrongstack/profiles/<name>/config.json
{
  "tools": {
    "exec": {
      "allow": ["terraform", "bazel"],  // add commands
      "deny":  ["docker", "rm"]          // remove commands
    }
  }
}
```

**Security:**
- `allow` **expands** what the agent may execute, so it is honored **only from trusted config** (the active profile or project-private config). The config loader strips `tools.exec.allow` from the untrusted, repo-committed `<project>/.wrongstack/config.json` (with a `config.in_project_unsafe_fields_ignored` warning naming `tools.exec.allow`).
- `deny` only ever **removes** commands, so it is honored from any source (in-project repo config included).
- Per-argument hard-blocking is deliberately narrow: clear destructive / project-escape patterns (`rm -rf /`, unsafe `rm` targets, `git --exec=`, `git -C`, `git -c`, `find -exec`, publishing/deploying subcommands, `docker push`, …) are blocked, but normal development commands such as `pnpm run test`, `pnpm dlx ...`, `npx ...`, `node -e ...`, `python -m ...`, and `docker build` are allowed. `cwd` is confined to the project, args are passed as a clean array (no shell parsing), and every `exec` call is still gated by the `confirm` permission. For anything outside the allowlist, the model falls back to `bash`.

**Autonomous goal.** The autonomous Goal verifier runs its verify command *without* per-call confirmation, so it keeps a narrower base allowlist (`pnpm`/`npm`/`yarn`/`bun`). It additionally honors your **explicit** `tools.exec.allow` opt-ins (not the broadened `exec` defaults), so a Go/Rust project can run e.g. `go test ./...` autonomously once you add `go` to `tools.exec.allow` and point `WRONGSTACK_GOAL_VERIFY_CMD` at it. Because `tools.exec.allow` is trusted-config-only, a repo still cannot widen what runs autonomously.

### `exec` tool heuristic danger detection (`tools.exec.danger`)

The `exec` tool classifies every call into one of three danger levels. Destructive and caution calls surface a level-based chip and the matched rule's reason in the TUI tool-result view, so a dangerous command is visible at a glance.

- **`safe`** — no rule fired. The output renders as a normal bash-style line.
- **`caution`** — the call matches a rule whose false-positive surface is too high to block (e.g. `python -c "..."`, `sudo`, `chmod 777`). TUI shows a `! CAUTION` chip + reason; the call still runs.
- **`destructive`** — the call matches a high-confidence destructive rule (e.g. `rm -rf`, `git push --force`, `mkfs`, `format`). TUI shows a `⚠ DESTRUCTIVE` chip + reason; the call still runs but is visibly flagged.

The current rule set is documented in `packages/tools/src/_danger-detect.ts`. Stable rule ids (each is a string you can reference in the bypass list):

| Rule id | Level | Pattern |
|---|---|---|
| `rm-recursive` | destructive | `rm -rf` (any short-flag combination) |
| `powershell-remove-item-recursive-force` | destructive | PowerShell `Remove-Item -Recurse -Force` |
| `find-exec` | destructive | `find -exec` / `-ok` / `-execdir` |
| `git-exec` | destructive | `git --exec=`, `--upload-pack=`, `--receive-pack=` |
| `win32-format` | destructive | Windows `format` |
| `win32-diskpart` | destructive | Windows `diskpart` |
| `win32-bcdedit` | destructive | Windows `bcdedit` |
| `mkfs` | destructive | `mkfs` family (any extension) / `mkswap` |
| `dd-to-block-device` | destructive | `dd of=/dev/{sd,hd,nvme,...}` |
| `shred`, `wipefs`, `sdelete` | destructive | secure-erase tools |
| `git-push-force` | destructive | `git push --force`, `-f`, `--force-with-lease` |
| `git-reset-hard` | destructive | `git reset --hard` |
| `git-clean-force` | destructive | `git clean -f` / `-fd` / `--force` |
| `npm-publish` | destructive | `npm`/`pnpm`/`yarn`/`bun` `publish`, `cargo publish` / `yank` |
| `kubectl-delete-namespace` | destructive | `kubectl delete namespace/ns` |
| `kubectl-drain` | destructive | `kubectl drain` |
| `inline-eval` | caution | `python`/`node`/`bash`/`sh`/`zsh`/`ruby`/`perl`/`lua` with `-c`, `-e`, `--eval` |
| `pipe-to-shell` | caution | `curl`/`wget` + `sh`/`bash`/`pwsh` in same argv |
| `sudo`, `runas` | caution | privilege escalation |
| `chmod-world-writable` | caution | `chmod` with octal mode containing `7` |

**Bypassing a rule:**

```jsonc
// ~/.wrongstack/profiles/<name>/config.json
{
  "tools": {
    "exec": {
      "danger": {
        "bypass": ["rm-recursive", "inline-eval"]
      }
    }
  }
}
```

Each entry is a stable rule id from the table above. A matched rule whose id is in this list is **skipped** — the call is treated as `safe` and no chip is rendered. Bypassing one rule does not affect any other rule; the same call may still trip a different rule and be reported under that rule's id.

**Use case:** a CI script that legitimately runs `rm -rf ./build` on every iteration can add `"rm-recursive"` to bypass so the detector stops emitting banners for that one rule. Bypassing a rule does not bypass per-arg hard-deny patterns (`BLOCKED_ARG_PATTERNS`) — a `rm -rf /` is still rejected by the hard-deny layer regardless of the bypass config.

**Security:**

- `tools.exec.danger` (and the whole object) is **stripped from in-project repo config** the same way `tools.exec.allow` is. The boot path that already strips `allow` was extended in PR 3 to also strip `danger`. A repo cannot silently disarm safety checks for anyone who clones it.
- Only trusted config sources (active profile, project-private config, system, CLI) can set bypass lists. The strip emits a `config.in_project_unsafe_fields_ignored` warning naming `tools.exec.danger`.
- **Unknown bypass ids are silently ignored** — forward-compat. If a future version adds a rule id, a config that references it before the upgrade simply has no effect for that id.

**Auto-detection signals.** A command is routed to PowerShell if it contains any of these unambiguous patterns:

- **Cmdlet verb-noun syntax** — `Get-Content`, `Set-Location`, `Invoke-WebRequest`, `Remove-Item`
- **Dollar-sign variables** — `$env:PATH`, `$foo`, `$_`, `$script:bar`
- **Subexpressions** — `$(Get-Date)`
- **Here-strings** — `@"..."@`, `@'...'@`
- **Splatting / call operator** — `@( ... )`, `& $script`
- **Comparison operators** — `-eq`, `-ne`, `-match`, `-like`, `-contains`, `-and`, `-replace`, `-split`
- **`.ps1` extension** — `.\build.ps1`
- **PS-only aliases** — `gci`, `gi`, `gp`, `gcm`, `gps`
- **Cmdlet flags** — `-WhatIf`, `-Confirm`, `-ErrorAction`
- **Pipeline cmdlets** — `Where-Object`, `ForEach-Object`, `Select-Object`, `Sort-Object`, `Group-Object`
- **Write-* output cmdlets** — `Write-Host`, `Write-Output`, `Write-Error`, `Write-Warning`
- **Registry provider paths** — `HKLM:\`, `HKCU:\`, `HKCR:\`
- **Bracketed type casts** — `[string]`, `[int]`, `[xml]`, `[System.IO.File]`
- **PS comment blocks** — `<# ... #>`
- **PS-only parameters** — `-AsPlainText`, `-PipelineVariable`, `-FilterHashtable`, `-OutVariable`

Deliberately **not** treated as PowerShell tells (both shells accept them): `C:\`-style paths, `cd`/`echo` (exist in cmd.exe too), lone `ls`/`where`/`select` (ambiguous with cmd.exe builtins and unix tools on `PATH`), and the unix-style names `rm`/`cat`/`cp`/`mv`/`sl` — these are Git-Bash/MSYS-normal on Windows dev machines, and their PowerShell alias semantics differ (PS `rm` is `Remove-Item`, which rejects `-rf`).

**Execution model.** PowerShell commands are piped to the shell's stdin rather than interpolated into a `-Command "..."` argument:

```
pwsh -NoLogo -NoProfile -NonInteractive -Command -
```

This sidesteps the entire class of quoting bugs from embedding multi-line, single-quoted, or dollar-laden scripts into an argument string.

**Script wrapping.** Every PowerShell command is wrapped with four reliability fixes before it reaches stdin:

1. **UTF-8 BOM** (`U+FEFF`) — so PowerShell 5.1 decodes non-ASCII characters correctly (PS 7+ already defaults to UTF-8; the BOM is harmless there).
2. **Console output encoding** — `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` ensures PS 5.1 emits UTF-8 on stdout, preventing mojibake of non-ASCII filenames and CJK output.
3. **Exit-code propagation** — the command runs inside `try { … } finally { exit $LASTEXITCODE }`, so native commands' exit codes (dotnet, npm, node) reach the parent. Without this, `pwsh -Command -` exits `0` even on failure.
4. **Confirmation suppression** — `$ConfirmPreference='None'` and `$WhatIfPreference=$false` so `-Confirm` cmdlets don't block waiting for interactive input.

**Forcing a shell.** To always use PowerShell regardless of detection:

```bash
# Windows (PowerShell 7 if available, else Windows PowerShell 5.1)
set WRONGSTACK_SHELL=powershell
# or explicitly
set WRONGSTACK_SHELL=pwsh
```

To always use cmd.exe (disables auto-detection entirely):

```bash
set WRONGSTACK_SHELL=cmd
```

**Provider paths (registry, certificates, etc.).** PowerShell provider paths such as `HKLM:\`, `HKCU:\`, `cert:\`, `wsman:\`, `env:\`, and `function:\` are not filesystem paths — they are PowerShell-specific abstractions that only exist inside the PowerShell provider system. Node.js's `fs` APIs cannot read them, and the `read`/`write`/`edit` tools will reject them as escaping the workspace. Access them through the `bash` tool instead, which routes to PowerShell:

```powershell
Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion" -Name "ProgramFilesDir"
Get-ChildItem -Path "cert:\LocalMachine\My"
```

---

## Secrets

API keys and auth tokens are encrypted with **AES-256-GCM** using a 32-byte key at `~/.wrongstack/.key` (mode `0600` on POSIX).

**Format**: `enc:v1:<iv>:<tag>:<ciphertext>`

Field detection is regex-based — any field matching `/apikey|authtoken|bearer|secret|password|refreshtoken|sessionkey|access[_-]?token|private[_-]?key/i` is auto-encrypted on write and decrypted on read. Plaintext keys in older configs are migrated transparently on boot.

### Adding a key

```bash
wrongstack auth anthropic       # interactive prompt
wrongstack auth groq            # same for any provider
```

Or set the environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

---

## Examples

### Minimal (offline, no network)

```jsonc
{
  "version": 1,
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "providers": {
    "anthropic": {
      "apiKey": "enc:v1:...",
      "family": "anthropic"
    }
  },
  "features": {
    "mcp": false,
    "plugins": false,
    "memory": false,
    "modelsRegistry": false,
    "skills": false
  }
}
```

### Multi-provider with Groq fast lane

```jsonc
{
  "version": 1,
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "providers": {
    "anthropic": { "apiKey": "enc:v1:..." },
    "groq": {
      "type": "openai-compatible",
      "apiKey": "enc:v1:...",
      "baseUrl": "https://api.groq.com/openai/v1"
    }
  }
}
```

### Token-saver

```jsonc
{
  "version": 1,
  "provider": "anthropic",
  "model": "anthropic-test-model",
  "context": {
    "mode": "frugal",
    "strategy": "intelligent"
  },
  "tools": {
    "maxIterations": 50,
    "autoExtendLimit": false
  }
}
```

---

## SAGE memory storage

SAGE memory stores project-scoped knowledge (facts, decisions, conventions, preferences) in `.wrongstack/memories/` using SQLite.

Indexed database (`memories.db`) using Node's built-in `node:sqlite`, with WAL mode for multi-process concurrency and FTS5 for full-text search.

- **Pros:** indexed lookups (O(log n)), FTS5 BM25-ranked search, dramatically faster at scale
- **Requirement:** Node >= 22.5 with built-in `node:sqlite`

SQLite is the only runtime backend and needs no engine configuration. On first open, legacy JSONL memories and their candidates, graph edges, and audit history are **auto-migrated** in one transaction. Legacy files are retained as a backup but are never written again by the runtime.

| Field | Type | Default | Description |
|---|---|---|---|
| `Sage.storage.directory` | `string` | `.wrongstack/memories` | Project-relative directory for memory files. |
| `Sage.storage.projectLocal` | `boolean` | `true` | Store memory inside the project (gitignored). |
| `Sage.hygiene.verifyDepth` | `'existence' \| 'content' \| 'git'` | `existence` | How deep session-end hygiene verifies anchors. `content`/`git` run deep checks (slower). |
| `Sage.capture.toolOutcomes` | `boolean` | `false` | Opt-in: auto-remember successful command tool outcomes. |
| `Sage.capture.errorPatterns` | `boolean` | `false` | Opt-in: auto-remember error signatures from failed tools. |
| `Sage.triage.dailyDryRun` | `boolean` | `false` | Hint for hosts to schedule a daily triage dry-run via cron when available. |

> **Migration is automatic.** Existing JSONL records migrate to SQLite on first launch. The original JSONL files remain unchanged as a recovery backup. Configs written before the SAGE rename keep working too: a legacy top-level `superMemory` key is migrated into `Sage` on load (explicit `Sage` values win on conflict).

### Retrieval tuning

By default, SAGE memory waits for a relevant tool call and appends a bounded
hint block to that tool result. It does not add memory to every ordinary turn.
The Memory Injector expands direct matches through file/symbol/package/command
relationships and measures current context pressure before choosing its budget.
Defaults are up to 8 diverse hints / 2800 characters at normal pressure,
shrinking safely near the context ceiling.

What actually earns an injection is **evidence about the thing the tool
touched**, not word overlap:

- the memory is anchored to that file, or to its immediate parent directory;
- the query names the memory's file, symbol, or command verbatim;
- two independent signals agree (two anchor terms, two tags), or the memory
  covers most of a deliberate search query.

A single coincidental token — `store`, `session`, `middleware` — is deliberately
below the bar. So is a memory whose importance is under
`Sage.inject.minImportance`: it stays fully searchable through `memory_*` and
`/memory search`, it just never arrives uninvited.

| Field | Type | Default | Description |
|---|---|---|---|
| `Sage.inject.minScore` | `number` | `0.72` | Composite score gate for an automatic hint. |
| `Sage.inject.minImportance` | `number` | `0.5` | Hard importance floor; below it a memory is never auto-injected. |
| `Sage.inject.repeatCooldownMs` | `number` | `0` | `0` = inject a given memory **once per session**. A positive value restores time-boxed repeats. |
| `Sage.inject.taskAware` | `boolean` | `false` | Fold live todo/Kanban text into the retrieval query. Opt-in: it searches for what you are doing rather than for the file the tool touched. |
Turn-level system-context injection is an explicit opt-in (default **off** in both
the CLI and WebUI). It appends a query-dependent block to the system prompt every
turn, which moves the provider's cache breakpoint and defeats prefix caching — so
the default retrieval path is the contextual tool-result injection plus the
on-demand `memory_*` tools, and turn-context is enabled only when you ask for it:

```jsonc
{
  "Sage": {
    "inject": {
      "turnContext": true
    }
  }
}
```

Deleted records are retained as audit/recovery tombstones but are never eligible
for automatic model context.

When turn-context injection is enabled, its middleware blends two scoring signals to decide which active memories to inject:

- **Metadata score** — weighted average of importance (×3), confidence (×2), and freshness (×1), always in [0, 1].
- **Relevance score** — overlap coefficient (Szymkiewicz–Simpson) between query tokens and memory text tokens, in [0, 1].

The final score is:

```
score = metadataScore * (metadataWeight + relevance * (1 - metadataWeight))
```

| Field | Type | Default | Description |
|---|---|---|---|
| `Sage.retrieval.metadataWeight` | `number` | `0.3` | Weight given to the metadata floor (0–1). At `0.0`, relevance fully gates injection. At `1.0`, metadata alone decides. |

> The default `0.3` was validated against 148 real query-memory pairs from session logs, producing F1 = 0.91 and 91.2% accuracy. The `0.3` floor ensures that even a zero-relevance critical memory can still surface for high-importance entries.
