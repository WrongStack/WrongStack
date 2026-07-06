# /modelcaps — Model Capacity Browser

Lists available models with their capabilities: context window, max output
tokens, and input/output pricing. Reads from the models cache
(`~/.wrongstack/cache/models.dev.json`).

## Usage

| Usage | Effect |
|---|---|
| `/modelcaps` | List all models grouped by provider |
| `/modelcaps <provider>` | Filter to one provider (e.g. `anthropic`) |
| `/modelcaps <fragment>` | Filter by model id fragment (e.g. `claude`) |
| `/modelcaps summary` | Show agent-type → model mapping matrix |

## Output

Each provider shows a list of models with:
- **Context bar**: 🟢 >200k · 🟡 >128k · 🔴 ≤128k
- **Max output** tokens
- **Input/output pricing** per million tokens
- **●** = API key present (usable) · **○** = no key (listed but not usable)

```
Available Models — capacities + pricing

  ● anthropic        (Anthropic)
    anthropic-test-model  🟢 200k out 8k  in $3.00/M tok  out $15.00/M tok
    claude-3-opus-20240229      🟢 200k out 4k  in $15.00/M tok out $75.00/M tok

  ● openai            (OpenAI)
    gpt-4o                      🟡 128k out 16k in $2.50/M tok  out $10.00/M tok

  ○ google            (Google)
    gemini-2.5-pro              🟢 1.0M out 64k in $1.25/M tok  out $5.00/M tok

364 model(s). ● = key present · ○ = no key.
```

## Agent-type mapping

`/modelcaps summary` redirects to `/setmodel` for the model resolution matrix:

```
Agent-Type → Model Mapping — use /setmodel

  /setmodel         — show leader + matrix + resolution summary
  /setmodel resolve <role> — walk the resolution chain for one role
```

Each agent role resolves its model via: **role → phase → \* → leader**.

## Cache

The models list is cached from [models.dev](https://models.dev). Run
`wstack sync-models` to refresh, or wait for the next auto-sync.

## Related

- `/setmodel` — configure leader model and per-role overrides
- `/models` — manage custom model definitions
- `wstack sync-models` — refresh the models cache

## Code reference

- `packages/cli/src/slash-commands/modelcaps.ts`
- `packages/cli/src/slash-commands/setmodel.ts`
- `packages/core/src/models/` — models registry
