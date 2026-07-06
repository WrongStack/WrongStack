# /setmodel — Leader Model + Per-Task Model Matrix

## What it does

Views or changes two things, both persisted to `~/.wrongstack/config.json`:

1. **Leader model** — the model the main agent runs (`config.provider` / `config.model`).
2. **Model matrix** (`config.modelMatrix`) — a map from a **catalog role**, a **phase**, or the `*` default to a specific model/runtime override. Subagents spawned for those tasks run the matched model instead of the leader's, and may also use their own reasoning settings.

This is how you run, say, `security-scanner` on `minimax/minimax-m3` while `documentation` uses `zai/glm-5-turbo` and the leader stays on Claude.
It can also keep the leader model but give one role a different reasoning budget, such as low-effort `bug-hunter` scans and high-effort `critic` reviews.

## Resolution precedence

At subagent spawn, the matrix is resolved most-specific first:

```
exact role  →  the role's phase  →  *  →  leader model
```

An explicit per-spawn model (`/spawn --model=…`, `spawn_subagent` with `model`) always wins over the matrix.

Changes apply **live** — a `/setmodel` mid-session takes effect on the next subagent spawn, no restart needed (the director re-reads the matrix from config on every spawn).

## Keys

- **Role** — any catalog role (see `/setmodel list`), e.g. `security-scanner`.
- **Phase** — one of `discovery, planning, build, verify, review, domain, knowledge, delivery, meta`.
- **`*`** — fleet-wide default for everything else.

## Targets

Only providers that have an API key (stored key, key list, or a populated env var) — plus the active leader provider — can be targeted. `/setmodel list` shows them.

## Usage

```
/setmodel                              show leader model + the matrix
/setmodel list                         keyed providers, their models, valid keys
/setmodel leader <provider> <model>    set the main (leader) model
/setmodel set <key> <provider>/<model> pin a role/phase/* to a model
/setmodel set <key> <model>            pin to a model on the leader provider
/setmodel reasoning <key> auto|on|off [effort]
/setmodel reasoning-effort <key> none|minimal|low|medium|high|xhigh|max
/setmodel reasoning-preserve <key> on|off
/setmodel clear <key>                  remove a matrix entry
```

### Examples

```
/setmodel set security-scanner minimax/minimax-m3
/setmodel set documentation zai/glm-5-turbo
/setmodel set review minimax/minimax-m3      # whole review phase
/setmodel set * anthropic/claude-haiku-4-5   # default for the rest
/setmodel reasoning bug-hunter on low        # keep its model, lower reasoning
/setmodel reasoning-effort critic high       # override only reasoning effort
/setmodel reasoning-preserve planner on      # preserve provider thinking state
/setmodel leader anthropic anthropic-test-model
/setmodel clear security-scanner
```

Reasoning overrides are stored inside the matrix entry as
`modelRuntime.reasoning`. They can exist without a model override, so a role can
inherit the leader model while still using its own reasoning mode, effort, or
preserve setting.

The WebUI Settings panel exposes the same matrix under Model Routing. A WebUI
route target may be blank when you only want to set per-route reasoning fields.

## Where it shows up

The resolved model appears live in both fleet monitors:

- **Ctrl+G / F3 (Agents · Live)** — on each agent's identity line: `icon · name · provider:model · … · ctx`.
- **Ctrl+F / F2 (Fleet · Orchestration)** — a `model` column plus `L/t·ctx` in the table.

(F2/F3/F4 are terminal-safe aliases for the Ctrl+F/G/T chords — some terminals, e.g. Windows Terminal, intercept Ctrl+F for "Find" before it reaches the app.)

## Code reference

- `packages/cli/src/slash-commands/setmodel.ts` — the command + persistence
- `packages/core/src/coordination/model-matrix.ts` — `resolveModelMatrix`, key validation
- `packages/core/src/coordination/director.ts` — `Director.spawn` applies the matrix before the spawn event/manifest
- `packages/runtime/src/fleet/light-subagent-factory.ts` — runtime subagent factory applies role-specific model/runtime
- `packages/cli/src/fleet/host.ts` — CLI fleet host applies the same model/runtime path
- `packages/webui/src/components/SettingsPanel/index.tsx` — WebUI Model Routing editor
- `packages/core/src/types/config.ts` — `ModelMatrixEntry`, `Config.modelMatrix`
