# `wstack init` — Interactive Project Setup

## What it does

Interactive setup wizard that configures the provider, model, and API key, then writes `~/.wrongstack/config.json` (encrypted secrets) and `.wrongstack/AGENTS.md` (project auto-detection).

## Flow

```
Provider catalog loaded from models.dev (cached)
  ↓
Detect API keys in env vars
  ↓
Prompt: Provider [<default>]:
  ↓
Prompt: Model [<suggested>]:
  ↓
Prompt: API key (stored encrypted; empty = expect env var):
  ↓
Write ~/.wrongstack/config.json  (encrypted)
Write .wrongstack/AGENTS.md     (auto-detected project facts)
```

## Provider selection

- Detected providers (from env vars) are ranked first
- Falls back to `anthropic` / `openai` / `google` if nothing detected
- Invalid provider → error and abort
- `unsupported` family (no built-in transport) → error with "install a plugin" message

## API key handling

1. **Env var found** — shown as "Found API key in env", no prompt
2. **No env var** — prompt for key, stored encrypted in `config.json`
3. **Empty enter** — no key stored, expects `ANTHROPIC_API_KEY` (or provider's env var) at runtime

## Config file

Written to `deps.paths.globalConfig` (`~/.wrongstack/config.json`):

```json
{
  "version": 1,
  "provider": "anthropic",
  "model": "anthropic-test-model",
  "apiKey": "<encrypted>"
}
```

Secrets are encrypted with `DefaultSecretVault` using `~/.wrongstack/.key` before writing.

## AGENTS.md generation

Uses the same `detectProjectFacts()` + `renderAgentsTemplate()` from `slash-commands/helpers.ts` — identical to the `/init` slash command output. Detection runs three tiers (manifests → `.github/workflows` CI parse → source-tree scan); see [docs/slash/init.md](../slash/init.md#auto-detection) for the full matrix. Only writes if the file doesn't already exist.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Error (provider not found, catalog load failed) |

## Cancel

Enter `q` at any prompt → returns `0` silently, no files written.

## Code reference

- `packages/cli/src/subcommands/handlers/init.ts` — handler
- `packages/cli/src/slash-commands/helpers.ts` — `detectProjectFacts()` + `renderAgentsTemplate()`
- `packages/cli/src/slash-commands/init.ts` — `/init` slash command (uses same helpers)