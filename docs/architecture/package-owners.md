# Package ownership and integration entry points

Use the [generated package inventory](../current-catalog.md#workspace-packages)
for exact membership. Package ownership and a browser-safe import surface are
different concerns; importing a product host package is not a way to obtain
its wire types.

| Owner | Responsibility | Integration entry |
|---|---|---|
| `primitives`, `persistence` | Dependency-leaf helpers and SQLite/file/lifecycle primitives | Package exports; [persistence contract](../../packages/persistence/README.md) |
| `kanban` | Durable boards, task contracts, readiness and workflow state | [Kanban architecture](../kanban-architecture.md) |
| `contracts` | Shared type vocabulary and the DI kernel every package builds against | [types](../../packages/contracts/src/types/index.ts), [kernel](../../packages/contracts/src/kernel/index.ts) |
| `core` | Agent runtime: context, agent loop, tool execution, permissions, hooks and state | Focused public subpaths; [architecture](../architecture.md) |
| `coordination` | Director, fleet and supervisor, delegation and the project mailbox | [fleet architecture](../director-architecture.md), [mailbox](../mailbox-architecture.md) |
| `runtime` | Host composition of services and domain ports | [runtime exports](../../packages/runtime/src/index.ts) |
| `providers`, `tools` | Provider wires/catalog and built-in capabilities | [provider authoring](../provider-author-guide.md), [tool workflows](../tools/README.md) |
| `webui-protocol` | Browser wire and HTTP contract types/generated schemas | [protocol exports](../../packages/webui-protocol/src/index.ts) |
| `client` | Typed external WebUI connection and HTTP client | [client API](../client-api.md) |
| `plugin-sdk` | Third-party plugin contracts and authoring/runtime helpers | [SDK reference](../../packages/plugin-sdk/README.md) |
| `plugins` | Official plugin implementations and metadata projections | [plugin management](../plugin-management.md), [value/cost](../plugin-value-cost.md) |
| `sage`, `vector-memory` | Structured memory versus host-side semantic retrieval/fusion | [retrieval ownership](../sage/retrieval.md) |
| `sdd`, `requirement-intake`, `techstack`, `governance` | Spec workflow, input contracts, project/dependency analysis and policy domain | Their package exports and maintained command references |
| `mcp`, `acp`, `plug-lsp`, `telegram`, `wrongtrace` | External protocols/services and adapters | Dedicated protocol/operations guides |
| `*-mcp` packages | Capability-limited MCP facades over domains | [MCP server](../mcp-server.md), package-owned facade contracts |
| `cli`, `tui`, `webui-server` | Composition/terminal/browser-server hosts | Command registries and explicit injected dependencies |
| `webui`, `vibeui`, `hq-next` | Browser views over shared contracts and state | Shared protocol, clients and host messages |
| `bench`, `security-scanner` | Standalone evaluation/scanning domains | [bench command](../subcommands/bench.md), package exports |
| `apps/wrongstack` | Distribution entry point | [release process](../release-process.md) |

Third-party plugins depend on `@wrongstack/plugin-sdk`; optional model helpers
and resource cleanup live in its `/runtime` subpath. A plugin capability
declaration does not supersede the host's permission policy. Follow
[authoring](../plugin-author-guide.md) and [packaging/trust](../plugin-third-party.md).

Domain tools, WebUI views, TUI panels and MCP facades should reach the same state
owner. For cross-process state, use project service ports rather than opening
a second database writer. See [project daemons](../project-daemons.md),
[Session Catalog](session-catalog.md) and [architecture rules](../architecture-rules.md).
