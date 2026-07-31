# @wrongstack/codebase-index-mcp

Expose WrongStack's project-scoped Codebase Index daemon to any MCP client.
The MCP process is only a protocol adapter: search, stats, graphs, and index
updates still go through the existing named-pipe/Unix-socket IPC service, so
the detached project daemon remains the single SQLite owner.

## Usage

```sh
wstack-codebase-index-mcp --project-root /absolute/path/to/project
```

The default stdio surface is read-only:

- `codebase_search`
- `codebase_stats`
- `codebase_package_graph`
- `codebase_file_graph`
- `codebase_symbol_graph`

Add `--writable` to expose `codebase_index`, which can incrementally refresh
or fully rebuild the index:

```sh
wstack-codebase-index-mcp --project-root /absolute/path/to/project --writable
```

Loopback HTTP is also available:

```sh
wstack-codebase-index-mcp --project-root /absolute/path/to/project --http --port 8767
```

Non-loopback HTTP binds require `--token`; the shared MCP HTTP transport
rejects an unauthenticated public bind.

## MCP client configuration

```json
{
  "mcpServers": {
    "wrongstack-codebase-index": {
      "command": "wstack-codebase-index-mcp",
      "args": ["--project-root", "/absolute/path/to/project", "--writable"]
    }
  }
}
```
