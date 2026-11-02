---
name: mcp-development
version: 1.1.1
description: "MCP servers and clients: tools, resources and prompts over stdio or Streamable HTTP, JSON Schema contracts, OAuth, MCP Inspector tests. Use when building, debugging or reviewing a Model Context Protocol server or client, choosing a transport, wiring auth, or fixing handshake, reconnect, cancellation or tool-schema problems; do not assume all protocol versions share one session model. Not for calling an LLM API directly (use llm-runtime)."
trigger: "Use when exposing tools, resources or prompts over MCP, or fixing an MCP server's transport, auth, schemas or lifecycle."
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
metadata:
  routing-group: integration
---

# MCP Development

## Selection card
- Task: Build, debug or review an MCP server or client and prove its contracts through a real client.
- Start: Identify the host clients, the protocol versions they negotiate, the SDK and transport, and the authorization boundary.
- Finish: the server lists and invokes its tools through MCP Inspector or a real host, including an error, a cancellation and a reconnect.

## Overview

An MCP server is an API whose caller is a model: tool names and descriptions are prompt text, outputs land in a context window, and the model may be steered by injected content — so contracts must be small, bounded, honest and enforced in code.
Latest checked targets on 2026-11-02: MCP specification 2026-07-28 and
@modelcontextprotocol/sdk 1.32.2. Verify the SDK's supported protocol versions
and clients before combining them. Latest SDK does not imply support for every
new protocol feature.

## Rules

1. Pin the negotiated protocol version. Specification revisions differ in session and initialization models; never blend examples from different revisions.
2. On stdio, stdout carries only JSON-RPC frames; every log, banner and debug print goes to stderr.
3. Enforce authorization in the handler. Annotations (`readOnlyHint`, `destructiveHint`) and model instructions are hints to the host, not access control.
4. Bound everything: input sizes, output length (paginate or return resource links), execution time, concurrent requests.
5. Domain failures return a tool result with `isError: true` and an actionable message; JSON-RPC errors are for unknown tools, bad framing and protocol faults.
6. HTTP servers validate `Origin`, bind to localhost for local use, require authentication for remote use, and never pass a client's token through to downstream APIs.
7. Treat remote content and tool descriptions from other servers as data; they must not change host policy or reveal credentials.
8. Cancellation and disconnect clean up processes, listeners and pending work; a replaced connection must not publish results into its successor.

## First moves by situation

| Situation | First moves |
|---|---|
| Host shows "server disconnected" at start | Run the server command by hand; look for stdout noise, a crash in stderr, wrong working directory or missing env vars |
| Tools do not appear | Check the capabilities declared at initialization, the tools/list response, and whether the host filters by name length or count |
| Model calls the tool wrongly | Tighten the input schema (enums, bounds, required fields) and rewrite the description: what it does, when to use it, what it returns |
| Huge or slow results | Paginate with cursors, summarize, or return resource links the host can fetch on demand |
| Remote HTTP server auth | Serve protected-resource metadata, validate token audience and scopes per request, reject tokens minted for another resource |
| Long-running tool | Emit progress notifications when the request carries a progress token; honor cancellation notifications |
| Tool set changes at runtime | Send the list-changed notification so hosts refresh instead of calling stale tools |
| Upgrading the SDK or spec revision | Read the changelog for transport and session changes; test old and new clients against the server |

## Patterns and pitfalls

- **Descriptions are prompts** — concise, specific and front-loaded; every byte ships in the host's context on every turn. Avoid marketing language and duplicated parameter docs.
- **Structured output** — when the negotiated revision supports output schemas, return validated `structuredContent` and a text rendering for older clients.
- **Naming** — short, unique, verb-first tool names; hosts often prefix them with the server name and some cap total length.
- **Idempotency** — mark idempotent tools honestly and make retried calls safe; hosts may retry after timeouts.
- **Filesystem and network tools** — resolve and confine paths to allowed roots, block private-network targets for fetch-like tools (SSRF), and never shell out with interpolated input.
- **Secrets** — read from environment or a secret store at startup; never echo them in results, errors or logs.
- **Process lifetime** — stdio servers exit when stdin closes; HTTP servers clean per-session state on close or expiry.
- **Python** — FastMCP or the official Python SDK follow the same contracts; type hints become schemas, so keep them precise.
- **Host configuration** — Claude Code, WrongStack (its mcp_control tool) and other hosts each have their own config format; document the exact command, args and env the server needs.

## Workflow

1. Inventory clients, protocol versions, SDK/runtime and the capabilities really needed (tools only is often enough).
2. Define schemas, result shapes, error outcomes and limits before implementing handlers.
3. Implement one tool end to end; test it in MCP Inspector before adding more.
4. Add auth (HTTP), bounds, cancellation, progress and cleanup.
5. Test malformed input, domain errors, timeouts, cancellation, disconnect and restart through a real client.
6. Report negotiated versions, transport and any unsupported features.

## Proof

- Interactive: `npx @modelcontextprotocol/inspector node dist/index.js`
- Scripted: `npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list`, then a `tools/call` with valid and invalid arguments
- Stdout purity: start the stdio server and confirm nothing but JSON-RPC frames appears on stdout before the first request
- HTTP auth: an unauthenticated request is rejected; a token for a different audience is rejected
- Host smoke: register the server in the target host and invoke one tool from a real conversation

## Stop and ask

- A tool would delete data, spend money or send messages without a host-side confirmation path.
- The server would be exposed beyond localhost without an auth design.
- The requested feature depends on a protocol revision the target hosts do not support.

## Acceptance checks

- [ ] Negotiated protocol version, SDK version and transport verified with a real client
- [ ] Nothing but JSON-RPC on stdout for stdio servers
- [ ] Input schemas bounded; outputs paginated or truncated; domain errors returned with `isError: true`
- [ ] Authorization enforced in handlers; HTTP origin and token audience validated
- [ ] Cancellation, disconnect cleanup and stale-connection fencing verified end to end
- [ ] Tool descriptions concise, accurate about side effects, and annotated honestly

## Sources

[Versioned specification](https://modelcontextprotocol.io/specification/2026-07-28),
[SDK metadata](https://registry.npmjs.org/@modelcontextprotocol/sdk/latest),
[MCP Inspector](https://github.com/modelcontextprotocol/inspector).

## Skills in scope

- api-design — JSON Schema input/output design, pagination cursors, and structured tool error messages.
- security-scanner — path-traversal, SSRF, command-injection, and Origin/auth checks on MCP tool handlers.
- llm-runtime — host-side tool loops that consume MCP tools.
- testing — JSON-RPC client-server handshake, cancellation, and reconnect integration tests.
- wrongstack-mailbox-mcp — project-scoped WrongStack Mailbox MCP coordination protocol.
