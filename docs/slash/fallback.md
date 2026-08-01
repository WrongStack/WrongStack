# /fallback

View or change the provider-continuity bridge, explicit/named fallback chains,
favorite models, and smart-default policy used after retryable provider failure.

This makes 429 storms recoverable without babysitting: after the primary model's
per-model retry policy gives up, the chain engages and the agent stays on the
working fallback while the primary is cooling down. Once the cooldown expires,
the primary is tried as a half-open probe; a successful probe restores it, while
another overload backs off again. The switch applies to the leader **and** every
subagent.

## Usage

```
/fallback                        Show bridge, chain, profiles, and favorites
/fallback bridge set <provider/model>  Set the immediate continuity route
/fallback bridge clear          Disable the continuity route
/fallback add <provider/model>   Append a model to the explicit chain
/fallback add <model>            Append a model on the leader provider
/fallback remove <n|ref>         Remove by 1-based index or exact reference
/fallback clear                  Empty the explicit chain
/fallback auto on|off            Toggle the auto-derived smart default
/fallback profile set <name> <ref,ref,...>  Create or replace a named chain
/fallback profile use <name>     Copy a profile into the active chain
/fallback profile remove <name>  Delete a named chain
/fallback fav add <provider/model>  Add a favorite model
/fallback fav remove <n|ref>     Remove a favorite model
/fallback fav only on|off        Restrict smart defaults to favorites
```

Model references use the same syntax as `fallbackModels` in config: a bare
model id (same provider), `provider/model`, or `provider model`. The bridge is
stricter and must be a full `provider/model` reference.

## Smart default

When the explicit chain is **empty** and `auto` is **on** (the default), a chain
is derived automatically from your configured providers and models: favorites
first, then same-provider alternatives, then cross-provider targets. The normal
preview is capped at four and reserves a cross-provider escape hatch. Runtime
continuity appends an uncapped usable inventory only after the preferred chain
is exhausted.

Turn it off with `/fallback auto off` to disable auto derivation and the final
inventory tail. An explicitly configured bridge remains active.

## Persistence

The bridge, explicit chain, profiles, favorites, and toggles are written to the
active profile config. Changes take effect immediately through the shared live
fallback manager and config hot reload.

## Related

- `/setmodel` — change the leader model and the per-task model matrix.
- `/provider-status` — inspect or release shared waiting-room entries.
- `--fallback-model <list>` — set the chain at launch from the CLI.
- The `provider.fallback` event fires on each hop (surfaced in the REPL/TUI and
  available to WebUI event plumbing).
- [Provider continuity](../provider-continuity.md) — complete ordering, failure
  taxonomy, multi-agent behavior, and recovery semantics.
