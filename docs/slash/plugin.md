# /plugin — Plugin Manager

Alias: `/plugins`.

## What it does

Manages the lifecycle of installed plugins via the `onPlugin` callback. Delegates to the plugin management subsystem in `packages/cli/src/plugin-management.ts`.

## Subcommands

| Usage | Effect |
|---|---|
| `/plugin` | List configured plugins |
| `/plugin status` | Same as list |
| `/plugin menu` | Open the TUI plugin picker when available; otherwise show the audit report |
| `/plugin report` | Show effective state, risk, and lock/toggle policy for built-in plugin rows |
| `/plugin official` | List official bundled plugins and their aliases |
| `/plugin install <alias\|package>` | Add and enable a plugin |
| `/plugin add <alias\|package>` | Alias for install |
| `/plugin enable <alias\|package>` | Enable a configured plugin |
| `/plugin disable <alias\|package>` | Disable a configured plugin |
| `/plugin toggle <name>` | Toggle a safe audit-list plugin row |
| `/plugin reload [name\|--all] [--force]` | Hot-reload one or all external `.ts`/`.mts`/`.js` plugins in-place without restarting (`--force` bypasses the 5 s in-flight tool quiescence wait) |
| `/plugin trust [name\|--remove]` | List or re-pin external plugin closure trust and immediately hot-reload |
| `/plugin watch [name\|off]` | Watch a user-global (`~/.wrongstack/plugins/<name>`) plugin for live reload during the current session |
| `/plugin remove <alias\|package>` | Remove from config |

## Zero-build TypeScript plugins & closure trust

Drop-in single-file `.ts`/`.mts`/`.js` plugins and directory plugins (`<dir>/index.ts`) under `.wrongstack/plugins/` or `~/.wrongstack/plugins/` are executed natively by Bun without a build step, resolving `@wrongstack/plugin-sdk` and `@wrongstack/contracts` from the active WrongStack runtime.

Project-scoped plugins require Trust-On-First-Use (TOFU) pinning over the entire directory file closure (Merkle root SHA-256):

```bash
wstack plugin trust <plugin-name>
```

Running `/plugin reload [name]` re-verifies the closure digest, prompts interactively via `<PluginPromptModal>` / `<PluginUiModal>` to re-pin trust when a previously pinned TOFU plugin changed on disk (failing closed automatically on headless runs), waits up to 5 s for in-flight plugin tool calls to quiesce, drains all tools, slash commands, hooks, `api.ui` slots, and `api.signal` listeners owned by the previous generation, and swaps in the new instance atomically (rolling back to the previous generation if `setup()` throws).

## Official plugin aliases

| Alias | Plugin |
|---|---|
| `telegram` | `@wrongstack/telegram` — Telegram bridge |
| `lsp` | `@wrongstack/plug-lsp` — LSP-backed tools |

Install with: `wstack plugin install telegram`

## Code reference

- `packages/cli/src/slash-commands/plugin.ts` — slash command wrapper
- `packages/cli/src/plugin-management.ts` — actual logic
- `packages/core/src/plugin/loader.ts` — plugin loading
- `packages/contracts/src/types/plugin.ts` — Plugin interface
- `docs/plugin-management.md`
