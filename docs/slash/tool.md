# /tool - Tool Description Detail

## What it does

Configures how much prose a specific tool exposes in its top-level description and usage hint.

Default mode is `extend` for every tool. Set a noisy tool to `simple` when you want the model-facing tool catalog to use a short 1-2 line description.

## Usage

```text
/tool
/tool list
/tool status
/tool status <name>
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

In sessions created with provider schema version 5 or later, Browser and E2E
also has a live control in Default, Lite, Pro and Scout.
Use `/tool group browser on` and `/tool group browser off`, or the Browser and
E2E setting in WebUI Tools. Auto follows the host's Browser setting, which is
off by default outside Quick. An enabled tool can be found using `tool_search`.
An exact lookup attaches its schema to the next provider request. The direct
tool declarations and stable prompt stay the same across group changes.
Earlier sessions and explicit launch allowlists retain their existing policy.

Provider schema version 6 also brings the Kanban and Codebase controls to
Default, Lite, Pro and Scout. Use `/tool group kanban on`,
`/tool group codebase off`, or the corresponding WebUI Tools controls. Auto
enables Kanban for a linked board and Codebase for a project with an index.
Use `/tool group codebase on` to make indexing available in a project that has
no index yet. Search `kanban:<action>` for one board operation or use the exact
name of a Codebase tool to load its schema for the next request. Kanban remains
required under governance. It can be called directly if the session has no
`tool_use` route and the board tool is available.

For MCP, `/tool group mcp:github on --project` enables one server while the
parent group is set to Auto. Setting the parent `mcp` to On enables servers
that inherit it, and a server-specific Off still takes precedence. An
explicit parent Off disables every server. In Quick, list tools with
`mcp_control`, activate an allowed server if needed, then use an exact
`tool_search` lookup for one schema.

Use `--project` or the **Save changes as project defaults** checkbox to apply a
choice to future sessions that support the group in this project. Existing
session overrides take precedence. Use `inherit` to return a session to its
project default.
Use `auto --project` to clear a saved project default. Defaults are stored in
the user's WrongStack project state. A repository cannot enable these groups
through a checked-in settings file.

Changes apply to the next request. Quick continues to send the same direct
schemas. Look up an exact tool name to load its input schema on demand.

Use `/tool status` to list the operator diagnostics offered by the active
plugins. For example, `/tool status secret_scanner_status` reads the scanner's
current counters and last event. New sessions omit these diagnostics from the
model's tools and discovery. WebUI Tools marks them as operator diagnostics.
Use `/tool status llm_cache_status` for cache statistics,
`/tool status model_router_status` for routing counts, and
`/tool status plugin_stack_status` for the provider wrapper order.

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
