# /tool - Tool Description Detail

## What it does

Configures how much prose a specific tool exposes in its top-level description and usage hint.

Default mode is `extend` for every tool. Set a noisy tool to `simple` when you want the model-facing tool catalog to use a short 1-2 line description.

## Usage

```text
/tool
/tool list
/tool <name>
/tool <name> simple
/tool <name> extend
/tool group
/tool group <name> <auto|on|off|inherit>
/tool group <name> <auto|on|off> --project
```

In a Quick session, `/tool group kanban on` makes the board available on demand.
`/tool group codebase off` removes Codebase tools from discovery and execution
for the current session. Auto enables Codebase when an index exists and enables
Kanban for a board-linked session. Kanban is required when governance is active.
The same controls are in the WebUI Tools settings for the active Quick session.
The other Quick groups are Browser and E2E, Automation, Fleet and collaboration,
Language servers, Design and media, ToolFlow, Vector memory, Model utilities,
MCP integrations and Telegram. They are off in Auto. Run `/tool group` for
their command names and effective state.

Use `--project` or the **Save changes as project defaults** checkbox to apply a
choice to future Quick sessions in this project. Existing session overrides
take precedence. Use `inherit` to return a session to its project default.
Use `auto --project` to clear a saved project default. Defaults are stored in
the user's WrongStack project state. A repository cannot enable these groups
through a checked-in settings file.

Changes apply to the next request. Quick continues to send the same direct
schemas. Look up an exact tool name to load its input schema on demand.

Examples:

```text
/tool read simple
/tool bash extend
```

Description settings are persisted under `tools.descriptionMode` and apply immediately.

## Code Reference

- `packages/cli/src/slash-commands/tool.ts`
- `packages/core/src/registry/tool-registry.ts`
- `packages/core/src/utils/tool-description-mode.ts`
