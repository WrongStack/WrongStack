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
wstack plugin manager lock secret-scanner
wstack plugin manager unlock secret-scanner
```

`plugin` and `plugins` are aliases. `status` is an alias for `list`.
`install` is an alias for `add`. `report` prints the built-in plugin audit
table, including effective state, risk, and whether a row can be toggled.
`menu` opens the TUI picker when available and otherwise prints the same report.
`toggle <name>` flips a row in the built-in audit list — see
[Toggle policy](#toggle-policy--the-plugin-audit-table) below for the policy.
Official aliases currently include `telegram` -> `@wrongstack/telegram`
and `lsp` -> `@wrongstack/plug-lsp`. `add`, `install`, and `enable` also set
`features.plugins: true` in the active profile config.
Changes are written to the active profile config.
Official plugins are bundled with the CLI package and published as regular
public packages, so `install telegram` means "add the official plugin to config
and enable plugin loading" — no npm involved.

For **third-party** packages, `add <spec> --install` DOES shell out to a
package manager (npm by default; `--pm pnpm|yarn|bun` overrides) and installs
into `~/.wrongstack/plugins/`, registering the explicit install path in
config. Lifecycle scripts are disabled by default (`--ignore-scripts`);
pass `--run-scripts` only for packages you have reason to trust. Plain
`add <spec>` (without `--install`) still only writes the config entry.

`trust <name>` manages the external-plugin TOFU pin store:
`wstack plugin trust` lists pins, `trust <name>` re-pins a plugin whose code
changed (required after every external plugin update), and
`trust <name> --remove` drops the pin so the plugin re-trusts on next load.

## Toggle policy — the plugin audit table

Every built-in plugin row has a `canDisable` flag in `PLUGIN_AUDIT_ENTRIES`
(see `packages/cli/src/plugin-management.ts`):

- **Toggleable** (`canDisable: true`): can be flipped from `/plugin toggle`,
  `/settings plugin toggle`, or the interactive picker. All current bundled
  audit entries use this, including safety and guard plugins such as
  [`secret-scanner`](../packages/plugins/src/secret-scanner/) and
  [`branch-guard`](../packages/plugins/src/branch-guard/).
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

## LLM tool-calling management

The leader model receives a built-in `plugin_manager` tool with these actions:

| Action | Required input | Purpose |
|---|---|---|
| `list` | — | Return the catalog and configured custom plugins. Optionally filter with `state: "enabled" | "disabled"`. |
| `search` | `query` | Search plugin names, aliases, descriptions, and live tool metadata by capability or need. |
| `describe` | `plugin` | Return effective state, LLM control policy, current-session callability, and complete tool input schemas. |
| `enable` | `plugin` | Persist an enabled state when `managerControl` is `allowed`. Usually requires a restart before use. |
| `disable` | `plugin` | Persist a disabled state when allowed. Usually affects the next boot; it does not promise hot-unload. |
| `use` | `plugin`; optionally `tool` + `input` | Without `tool`, inspect callable schemas. With `tool`, invoke an already-loaded plugin tool. |

Important result fields:

- `enabled` is the effective configured boot state.
- `managerControl: "locked"` means the LLM must not attempt enable/disable workarounds.
- `callableNow` means at least one enabled tool from that plugin is registered in the current session.
- `restartRequired: true` means the config changed, but plugin code cannot be used in this process yet.
- `needs_direct_call` means the selected plugin tool has its own confirmation,
  deny, or destructive policy. Call the returned tool directly so the normal
  permission path remains in control.

`use` validates nested input against the selected plugin tool schema. It cannot
install arbitrary packages and cannot invoke a plugin that is merely configured
but not loaded.

### Restricting LLM plugin control

Human plugin commands and LLM plugin control use separate policies. Lock a
plugin when the model may still discover/use it but must not change its enabled
state:

```text
/plugin manager lock secret-scanner
/plugin manager unlock secret-scanner
/plugin manager lock *
```

The equivalent active-profile config is:

```jsonc
{
  "pluginManager": {
    "locked": ["secret-scanner", "branch-guard"]
  }
}
```

`"*"` blocks all `plugin_manager` enable/disable mutations. Locks are applied
live and do not require a restart. They do not block the human-facing
`/plugin enable`, `/plugin disable`, or `/plugin toggle` commands. This policy
is ignored in repository-committed `.wrongstack/config.json`; configure it in
the trusted active profile (the command default) or private `config.local.json`.

### Recommended model workflow

Start from the task need, not a guessed plugin name:

```jsonc
plugin_manager({ "action": "search", "query": "release notes" })
plugin_manager({ "action": "describe", "plugin": "release-notes-generator" })
```

If it is disabled and `managerControl` is `allowed`:

```jsonc
plugin_manager({ "action": "enable", "plugin": "release-notes-generator" })
```

When that result contains `restartRequired: true`, stop the plugin flow and
tell the user to restart WrongStack. Enabling changes config; it does not
retroactively run the plugin's setup in the current process.

After restart—or when `describe` already reports `callableNow: true`—inspect
the current tool schemas:

```jsonc
plugin_manager({ "action": "use", "plugin": "release-notes-generator" })
```

Then invoke the exact returned tool with schema-valid input:

```jsonc
plugin_manager({
  "action": "use",
  "plugin": "release-notes-generator",
  "tool": "generate_release_notes",
  "input": { "from": "v1.4.0", "to": "HEAD" }
})
```

If this returns `needs_direct_call`, use the returned `directCall.tool` and
`directCall.input` as a normal tool call instead of retrying through
`plugin_manager`.

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
`extensions.<plugin>.llm = { provider, model }` in the active profile config
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
- `PLUGIN_AUDIT_ENTRIES.defaultState` is the canonical default for bundled plugins.
- A string entry or `{ name, enabled: true }` explicitly enables an opt-in bundled plugin.
- Object entries can disable a default-active plugin with `enabled: false`.
- `extensions.<pluginName>` stores that plugin's options and is validated
  against the plugin's `configSchema` during boot.
- Object entries can also carry `options`; WrongStack merges
  `plugins[].options` with `extensions.<pluginName>`, with `extensions`
  taking precedence.

Bundled plugins are default-off when they automatically mutate files, enforce
project-specific policy, publish data, start background work, run expensive
subprocesses, or change provider-call semantics. Use `wstack plugin report` to
see the effective state and `wstack plugin enable <name>` to opt in.

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

After restart, the plugin registers `telegram_read`, `telegram_send`, `telegram_approve`, and the
`/telegram:*` slash commands declared by the plugin.
