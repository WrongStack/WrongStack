# `wstack plugin` — Plugin Manager

## What it does

Manages WrongStack plugins: inspect, install, remove, enable, disable, and toggle. Plugins extend WrongStack's capabilities via the plugin API.

## Subcommands

| Usage | Effect |
|---|---|
| `wstack plugin` / `list` / `status` | List configured plugins with status |
| `wstack plugins` | Exact top-level alias for `wstack plugin` |
| `wstack plugin official` | List official aliases; `officials` is accepted too |
| `wstack plugin report` | Show effective state, risk, and lock/toggle policy for built-in plugin rows (`audit` and `menu` aliases) |
| `wstack plugin install <name\|alias>` | Install and enable a plugin (`add` alias; add `--disabled` to keep it off) |
| `wstack plugin remove <name>` | Remove from config (`rm`, `uninstall` aliases) |
| `wstack plugin enable <name>` | Enable a configured plugin |
| `wstack plugin disable <name>` | Disable a configured plugin |
| `wstack plugin toggle <name>` | Toggle a safe audit-list plugin row |
| `wstack plugin trust [--list]` | List external plugins pinned in `plugin-trust.json` |
| `wstack plugin trust <name>` | Re-pin an external `.ts`/`.mts`/`.js` plugin's file or directory closure digest |
| `wstack plugin trust <name> --remove` | Drop a saved trust pin (`--unpin` alias) so the plugin re-trusts on next load |
| `wstack plugin manager [list]` | List plugins locked against LLM `plugin_manager` state changes |
| `wstack plugin manager lock <plugin\|*>` | Prevent `plugin_manager` from enabling or disabling the plugin |
| `wstack plugin manager unlock <plugin\|*>` | Restore `plugin_manager` enable/disable access |
| `wstack plugin llm [list]` | List per-plugin provider/model overrides |
| `wstack plugin llm <plugin>` | Show one override |
| `wstack plugin llm <plugin> <provider> [model]` | Set routing; use `-` as provider to override only the model |
| `wstack plugin llm <plugin> --clear` | Return the plugin to session-default routing |

## Official plugins

| Alias | Plugin package |
|---|---|
| `telegram` | `@wrongstack/telegram` — Telegram bridge |
| `lsp` | `@wrongstack/plug-lsp` — LSP-backed tools |

Install with: `wstack plugin install telegram`

## Config

Plugins are stored in `config.json`:

```jsonc
{
  "plugins": [
    { "name": "@wrongstack/telegram", "enabled": true }
  ]
}
```

## Code reference

- `packages/cli/src/subcommands/handlers/plugin-usage.ts`
- `packages/cli/src/plugin-management.ts` — actual logic
- `packages/core/src/plugin/loader.ts` — plugin loading
- `docs/plugin-author-guide.md`
- `docs/plugin-management.md`
