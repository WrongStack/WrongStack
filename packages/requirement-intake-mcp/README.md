# @wrongstack/requirement-intake-mcp

WrongStack Requirements Intake as a project-scoped MCP server. Agents (Claude
Code, Codex, Cursor, custom MCP clients) can list intake records and file +
submit new requirement intakes directly into the project's intake store.

Mirrors the `@wrongstack/kanban-mcp` pattern: a standalone server with a
read-only default and an explicit `--writable` tier.

## Tools

| Tool | Tier | Purpose |
|---|---|---|
| `requirement_intake_list` | read (always) | List intake records for the project, newest first, optional `statuses` filter |
| `requirement_intake_submit` | writable (`--writable`) | File + submit an intake record from the `request` text (preserved verbatim) |

`requirement_intake_submit` arguments: `request` (required), `title`,
`requestType` (feature/bug_fix/refactor/… — unknown values normalize to
`other`/`unspecified`), `priority`, `idempotencyKey` (safe retries).

Records are stored under the project state dir
(`~/.wrongstack/projects/<slug>/requirement-intakes`) and are the same records
served by the WebUI REST API and the CLI `/intake` command. The MCP transport
is the authorization boundary; the service runs with an allow-all authorizer
inside it.

## Usage

```bash
# stdio (default) — read-only
wstack-requirement-intake-mcp --project-root /path/to/project

# expose intake filing
wstack-requirement-intake-mcp --project-root /path/to/project --writable

# HTTP transport with token auth
WRONGSTACK_MCP_TOKEN=secret wstack-requirement-intake-mcp \
  --project-root /path/to/project --http --writable
```

Project identity comes from `.wrongstack/project.json`
(`readProjectIdentity`). `requirement_intake_submit` creates it when missing;
`requirement_intake_list` requires it (run `wstack init` first).

## Development

```bash
pnpm exec vitest run packages/requirement-intake-mcp/tests
pnpm --filter @wrongstack/requirement-intake-mcp build
```

## Code references

- `src/adapter.ts` — `createRequirementIntakeMcpToolHost` / `...Server`
- `src/policy.ts` — read/writable capability tiers
- `src/cli.ts` — `wstack-requirement-intake-mcp` entry
