# `/subagent-models` — per-session model lanes for subagents

Pins the provider/model that spawned subagents run on, for **this session only**.

`/setmodel` answers a different question. Its matrix routes by ROLE and lives in
`config.json`, so it applies to every session in the project. This command routes
by LANE: each live subagent holds one lane and releases it the moment it retires,
so a fan-out of 8 workers runs on 8 different provider/model pairs — "agent 1 on
Opus, agent 2 on GPT-5, agent 3 on GLM…".

```
/subagent-models                              Show this session's lane plan
/subagent-models set <n> <provider>/<model>   Pin lane n (1-based)
/subagent-models set <n> tier:<id>            Pin lane n to a cost tier
/subagent-models set <n> profile:<name>       Pin lane n to a fallback profile
/subagent-models clear <n|all>                Unpin a lane (or every lane)
/subagent-models role <role> <target>         Session-scoped role override
/subagent-models role <role> clear            Drop that role override
/subagent-models lanes <count>                Resize the lane list (1–16)
/subagent-models lock on|off                  Whether lanes outrank the leader
/subagent-models session on|off               Run every plain subagent on YOUR model
/subagent-models on|off                       Enable / disable the whole plan
/subagent-models reset                        Drop the plan for this session
/subagent-models resolve [role]               Preview what the next spawn gets
```

Bare `/subagent-models` opens the interactive lane panel in the TUI (↑↓ move,
Enter picks a model through the shared `/model` overlay, `c` clears, `l` toggles
the lock, `s` toggles "use my model", space toggles the plan, Esc closes). On
surfaces without a panel it prints the same table.

## "Use my model for all subagents"

`session on` is the coarse version of the same idea: every plain subagent runs
on the model this session is using, whatever that is at spawn time. It outranks
the lanes (they go inactive in the UIs while it is on) and, like them, it leaves
`/setmodel` routing alone.

"At spawn time" is literal: the session target is read live, so a `/model`
switch mid-conversation reaches the next worker. (The same getter fixed the
final session fallback, which had been pinned to whatever the leader ran on
when the fleet was first built.)

## Lane assignment

Lanes are handed out by **occupancy**, not by a counter: a spawn takes the first
configured lane nobody is holding, and `Director.remove` gives it back on every
retirement path (idle reap, retire-on-complete, session terminate, shutdown).
When every configured lane is busy, the least-loaded one wins, lowest index
first. Unconfigured lanes are skipped entirely — they never "use up" a worker.

A **role override** is a more specific statement than a lane, so it wins and
consumes no lane. Use it for the one role you care about (`reviewer`) while the
lanes spread everything else.

## The lock

With `lock on` (the default) a lane also overrides the `provider`/`model` the
**leader** passed to `spawn_subagent` / `delegate`. This is the point of the
feature: the leader picks models on its own judgement, and the lock is how you
take that decision back for a session.

It only overrides the LEADER. A model a person typed for one spawn —
`/spawn --model=…`, an ACP flag — is a more specific statement than a standing
lane, so the plan steps aside for that spawn **entirely**: it does not even
claim a lane, which leaves the lane free for the next spawn it does route. The
step-aside is wholesale on purpose — filling only the missing half (a human
`model` beside a lane `provider`) would name a pair that exists in neither
place; the matrix, tier and session layers fill the gap as they always did.

The two leader tools stamp `modelChosenByLeader` on the config; that stamp is
what separates the two cases.

When a lane wins, the leader's pins are discarded **wholesale** rather than
merged. A leader `model` sitting beside a lane `provider` would name a pair that
exists in neither place and resolve to nothing; the layers below fill whatever
the lane left unset instead.

With `lock off` the plan behaves like the matrix — it only fills fields the
leader left empty.

## Precedence at spawn

```
session role override            ← /subagent-models role <role> …
  → config.modelMatrix role/phase route     ← /setmodel (routing stays routing)
    → "use my model" / lane                 ← this command, for PLAIN spawns
      → the leader's spawn_subagent({provider, model})
        → config.modelMatrix `*` default
          → config.modelTiers               ← /tier
            → the session's own model
```

The middle rule is the important one: a role (or phase) you deliberately routed
with `/setmodel` keeps that route — lanes and "use my model" are for the spawns
routing does not name. The `*` wildcard is not such a route; it is the fallback
for everything, so a lane still takes precedence over it.

Only the session role override outranks routing, because it names both the role
and this session. A model typed by a person on one spawn sits above the lane
too, for the same reason: it is the narrower statement.

Each field resolves independently, so a lane that names only a provider still
takes its model from the layers below.

One thing outranks even a lane: a role whose catalog entry carries a
`modelPolicy` (an allow-list of models it may run on). That is a capability
constraint rather than a preference — the role cannot do its job elsewhere — so
the factory still clamps to an allowed model.

## What else counts as a human pin

Anything that reaches `Director.spawn` without the leader's stamp:

- `/spawn --provider=… --model=…` and the ACP `--bg` flags,
- a Kanban task's persisted `provider`/`model` route (`claim_and_dispatch`
  passes it through, and a person authored it),
- a role whose catalog entry carries a `modelPolicy` allow-list — a capability
  constraint rather than a preference, clamped by the subagent factory.

All of them outrank a lane. The lane is the default for spawns nobody pinned.

## Scope and persistence

The plan belongs to one conversation. It lives in an in-memory registry keyed by
session id and is written to the session journal as a `subagent_model_plan`
event, so `/resume` brings it back. It is never written to `config.json` — use
`/setmodel` for a project-wide default.

## Other surfaces

- **TUI** — the lane panel (bare `/subagent-models`).
- **WebUI** — the *Subagents* button in the composer toolbar (next to the model
  chip and the effort select) opens a popover with the switch and the lanes; the
  full editor, role overrides included, is in Settings → Routing → *Subagent
  models*. Per tab, because each tab is its own session.
- **SimpleUI** — Settings → SESSION → *Subagent models*.

## Code reference

- `packages/core/src/coordination/session-subagent-models.ts` — the plan, the lane
  accounting, journal + resume
- `packages/core/src/coordination/director-spawn-model.ts` — the single resolver
  that owns the precedence order above
- `packages/core/src/coordination/director.ts` — claims a lane before resolution,
  releases it in `remove()`
- `packages/cli/src/slash-commands/subagent-models.ts` — this command
- `packages/cli/src/subagent-models/panel-service.ts` — TUI panel host bridge
- `packages/tui/src/components/subagent-models-panel.tsx` — the lane panel
- `packages/webui/src/components/ChatInput/subagent-models-button.tsx` — composer popover
- `packages/webui/src/components/SettingsPanel/SubagentModelsSection.tsx` — browser editor
- `packages/core/tests/coordination/spawn-model-single-resolver.test.ts` — guard
  proving no second resolver can bypass the plan
