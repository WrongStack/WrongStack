# Plugin Management

WrongStack plugins are regular npm/workspace packages that export a default
`Plugin` object. The CLI loads enabled entries from `config.plugins` when
`features.plugins` is true.

## Commands

```bash
wstack plugin list
wstack plugin status
wstack plugins list
wstack plugin report
wstack plugin menu
wstack plugin official
wstack plugin install telegram
wstack plugin add @wrongstack/telegram
wstack plugin toggle format-on-save
wstack plugin add @wrongstack/telegram --disabled
wstack plugin disable @wrongstack/telegram
wstack plugin enable @wrongstack/telegram
wstack plugin remove @wrongstack/telegram
```

`plugin` and `plugins` are aliases. `status` is an alias for `list`.
`install` is an alias for `add`. `report` prints the built-in plugin audit
table, including effective state, risk, and whether a row can be toggled.
`menu` opens the TUI picker when available and otherwise prints the same report.
`toggle <name>` flips a row in the built-in audit list — see
[Toggle policy](#toggle-policy--the-plugin-audit-table) below for the policy.
Official aliases currently include `telegram` -> `@wrongstack/telegram`
and `lsp` -> `@wrongstack/plug-lsp`. `add`, `install`, and `enable` also set
`features.plugins: true` in the global config.
Changes are written to `~/.wrongstack/config.json`.
Official plugins are bundled with the CLI package and published as regular
public packages, so `install telegram` means "add the official plugin to config
and enable plugin loading"; it does not shell out to npm.

## Toggle policy — the plugin audit table

Every built-in plugin row has a `canDisable` flag in `PLUGIN_AUDIT_ENTRIES`
(see `packages/cli/src/plugin-management.ts`):

- **Toggleable** (`canDisable: true`): can be flipped from `/plugin toggle`,
  `/settings plugin toggle`, or the interactive picker. All current bundled
  audit entries use this, including safety and guard plugins such as
  [`secret-scanner`](packages/plugins/src/secret-scanner) and
  [`branch-guard`](packages/plugins/src/branch-guard).
- **Locked** (`canDisable: false`): reserved for future rows that must be
  visible in the audit table but cannot be toggled from the picker.

UX behavior:

| Surface | UX |
|---|---|
| Interactive TUI picker | Current bundled rows toggle normally. If a future row sets `canDisable: false`, it renders in yellow with a 🔒 marker and Enter / ← / → shows `<name> is locked — see /plugin report`. |
| REPL `/plugin toggle <locked>` | Returns a locked-row error and does not change config. |
| `/plugin report` | One row per plugin, including the current toggle policy. |
| `/plugin menu` fallback (no TUI) | Prints the audit report (same shape as `/plugin report`) instead of opening an overlay. |

The picker lists **every** entry in `PLUGIN_AUDIT_ENTRIES`, not only the
default-active subset, so the model and the user both understand the effective
state and toggle policy from a single screen.

The same audit surface is reachable as `/settings plugins`,
`/settings plugin report`, and `/settings plugin toggle <name>` — they
delegate to `plugin-management.ts` and share the toggle policy. See
[`docs/slash/settings.md`](slash/settings.md#plugin-picker-settings-plugins)
for the full verb table.

The same management surface is available in an interactive session:

```text
/plugin list
/plugin status
/plugin menu
/plugin report
/plugin official
/plugin install telegram
/plugin toggle format-on-save
/plugin disable telegram
/plugin enable telegram
/plugin remove telegram
```

Slash commands update config immediately, but plugin code is loaded at boot.
Restart WrongStack after install/enable/disable/toggle/remove to change the
current session's loaded plugins.

## Per-plugin LLM routing

Plugins that call the LLM (via `api.llm`) follow the active session
provider/model — the chat leader — by default. Route an individual plugin
through a different provider and/or model:

```bash
wstack plugin llm error-lens                       # show the override
wstack plugin llm error-lens omniroute qwen3-30b   # provider + model
wstack plugin llm changelog-writer - haiku-x       # keep session provider, set model
wstack plugin llm error-lens --clear               # back to the session default
```

(Also available as `/plugin llm …` in a session.) The override is stored as
`extensions.<plugin>.llm = { provider, model }` in `~/.wrongstack/config.json`
and resolved on every `api.llm.complete()` call: per-call options win over the
per-plugin override, which wins over the session default. `provider` is any
key of `config.providers` or a catalog provider id. Unlike enable/disable,
LLM routing hot-reloads: `/plugin llm` changes apply to the very next
`api.llm` call in the running session — no restart needed.

## Config Shape

Plugin loading and plugin options are separate:

```jsonc
{
  "features": {
    "plugins": true
  },
  "plugins": [
    "@wrongstack/telegram",
    { "name": "@wrongstack/plug-lsp", "enabled": false }
  ],
  "extensions": {
    "telegram": {
      "botToken": "123456789:ABCdef...",
      "notifyChatId": "987654321"
    }
  }
}
```

- `plugins` controls which packages are loaded.
- A string entry is enabled by default.
- Object entries can be disabled with `enabled: false`.
- `extensions.<pluginName>` stores that plugin's options and is validated
  against the plugin's `configSchema` during boot.
- Object entries can also carry `options`; WrongStack merges
  `plugins[].options` with `extensions.<pluginName>`, with `extensions`
  taking precedence.

## Telegram

The Telegram bridge lives in this repository as `packages/telegram`, is
published as `@wrongstack/telegram`, and is bundled as the official `telegram`
alias.

```bash
wstack plugin install telegram
```

Then set Telegram-specific options under `extensions.telegram`.

```jsonc
{
  "extensions": {
    "telegram": {
      "botToken": "123456789:ABCdef...",
      "notifyChatId": "987654321",
      "allowedUsers": [987654321],
      "notifyOnSessionEnd": true
    }
  }
}
```

After restart, the plugin registers `telegram_read`, `telegram_send`, and the
`/telegram:*` slash commands declared by the plugin.
