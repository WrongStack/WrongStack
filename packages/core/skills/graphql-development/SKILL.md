---
name: graphql-development
description: "GraphQL APIs and clients: SDL schemas, resolvers, DataLoader, Apollo Server, Yoga, codegen, subscriptions, federation, query limits. Use when adding or changing types, fields, resolvers or mutations, fixing N+1 or authorization gaps, evolving a schema without breaking clients, or upgrading GraphQL.js or the server. Not for REST or HTTP contract design (use api-design) or WebSocket transport tuning (use realtime-systems)."
trigger: "Use when a change touches .graphql or .gql files, resolvers, DataLoaders, GraphQL server config, generated client operations or subscriptions."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: backend
  domain: "backend"
paths: ["*.{graphql,gql}"]
---

# Graphql Development

## Selection card
- Task: Implement or evolve GraphQL schema, resolvers and client operations with authorization, batching and bounded cost.
- Start: Read the schema (SDL or code-first builder), the server and context factory, the resolvers and loaders for the touched types, and the client operations or persisted documents that use them.
- Finish: the schema diff shows no unintended breaking change, codegen and operation tests pass, a second user cannot reach the data through any path, and query cost stays bounded.

## Overview

GraphQL hands the query plan to the client, so every resolver must assume it can be reached through any path, any number of times, in parallel, inside an aliased batch of a thousand copies.
Checked GraphQL.js stable target: 17.0.2 on 2026-10-23. Verify current published specification and server/plugin compatibility before upgrading; a draft specification is not automatically the deployed contract.
GraphQL.js 17 is a major release; servers, plugins and codegen presets declare their supported `graphql` peer range, so check each before upgrading the core package.

## Rules

1. Authorize in the data or loader layer, per object and per sensitive field. A check on the root field does not protect the same node reached through `node(id:)`, nested edges, interfaces, or federation `_entities`.
2. Create one DataLoader set per request in the context factory. Batch functions return one result per key, in key order, with `null` or an `Error` for misses; module-level loaders leak cached data across users.
3. Bound work per operation: depth, cost or complexity, alias and root-field counts, a server-side cap on every list argument (`first`), and no unbounded list fields.
4. For first-party clients, accept only persisted or trusted documents in production; that removes the arbitrary-query surface that depth and cost limits only narrow.
5. Model nullability on purpose: an error in a non-null field nulls its parent up to the nearest nullable ancestor, and one bad item in `[Item!]!` loses the whole list. Expected domain failures are typed results (unions or payloads with user errors), not thrown exceptions.
6. Evolve additively: add fields, mark old ones `@deprecated(reason: "...")`, and remove only after usage data or persisted documents prove nobody calls them. Never change a field's type in place; loosening output nullability or tightening argument nullability also breaks generated clients.
7. Mask unexpected errors: clients get a generic message and `extensions.code`; stack traces, SQL and internal messages stay in logs.
8. Mutations that clients retry carry an idempotency key, each mutation is its own transaction, and subscriptions re-check authorization per event, not only at connect.

## First moves by situation

| Situation | First moves |
|---|---|
| New field or type | Change the schema first; resolve through a loader; authorize in the service; regenerate types; test with a real operation document |
| N+1 or slow operation | Count SQL statements per operation; add a loader per relation; look for loaders constructed inside resolvers, which defeats batching |
| Data leak report | Walk every path to the type: root fields, `node`, nested edges, unions, interfaces, federation entities; reproduce as a second user |
| Breaking-change check | `graphql-inspector diff` between the base and new schema, or `rover subgraph check`; re-run codegen so client documents are validated against the new schema |
| Abuse or DoS | Aliased batching (hundreds of login mutations in one request bypasses per-request rate limits); array batching multiplies cost; enforce alias and cost limits and rate-limit by cost |
| Subscriptions | The `graphql-ws` library speaks the `graphql-transport-ws` subprotocol, while legacy `subscriptions-transport-ws` speaks one confusingly named `graphql-ws`; client and server must match. Authenticate in `connection_init` and close on token expiry |
| GraphQL.js or server upgrade | Read the upgrade guide; `npm ls graphql` must show a single copy (two copies cause "Cannot use GraphQLSchema ... from another module or realm"); Apollo Server 4 is end-of-life, so follow the v5 migration guide |
| Federation | Entity `__resolveReference` authorizes like any resolver; subgraphs accept traffic only from the router; keep `@key` fields stable |

## Patterns and pitfalls

- **Parallel sibling resolvers** — query fields resolve concurrently (only top-level mutation fields run serially); siblings sharing one transaction or connection object interleave and fail. Give loaders the pool, or serialize deliberately.
- **Stale loader cache** — after a mutation in the same request, call `loader.clear(id)` or `prime` with the new value, or the payload returns pre-mutation data.
- **Global IDs** — opaque, type-prefixed IDs are decoded, type-checked, then authorized; accepting a raw database ID for any type invites cross-type lookups.
- **Hidden is not secure** — disabling introspection still leaves "Did you mean" field suggestions exposing names; persisted documents are the real control.
- **Status codes lie** — with `application/json`, partial results with `errors[]` usually return 200; alert on `errors` and `extensions.code`, not HTTP status alone.
- **CSRF on GraphQL** — GET requests and `text/plain` or multipart POSTs are simple requests; never execute mutations over GET, and require a non-simple content type or a preflight-forcing header for cookie-authenticated endpoints.
- **Uploads** — the multipart upload convention adds CSRF and memory risk; prefer a mutation that returns a presigned upload URL.
- **Int is 32-bit** — GraphQL `Int` is signed 32-bit; large IDs, money and counters need a custom scalar or `String`.
- **"Exactly one of" inputs** — `@oneOf` input objects express it where the server's GraphQL.js version supports them; otherwise validate in the resolver.
- **Pagination costs** — cursor connections need stable opaque cursors and a capped `first`; `totalCount` on large tables is a full count, so make it optional or estimated.
- **Code-first drift** — with Pothos, Nexus, TypeGraphQL, gqlgen, Strawberry or Hot Chocolate, print the generated SDL in CI and diff it; the code diff alone hides schema changes.

## Workflow

1. Identify server library and version, `graphql` version, schema approach (SDL or code-first), codegen setup and whether persisted documents or a registry exist.
2. Trace the touched type: every field that returns it, its resolvers and loaders, the service and authorization call, and the client operations using it.
3. Write failing operation tests first: owner versus second user, missing node, invalid input returning a typed error, and the nested list that would N+1.
4. Change schema, then resolvers and loaders; keep authorization below the resolver.
5. Diff the schema against the base branch and regenerate client types.
6. Run the proof, start the server and execute representative operations through the real HTTP or WebSocket transport.

## Proof

- Schema diff: `npx graphql-inspector diff schema.base.graphql schema.graphql` (non-zero on breaking changes), or `rover subgraph check <graph-ref> --schema ./schema.graphql --name <subgraph>`
- Codegen: `npx graphql-codegen --config codegen.ts` fails on documents invalid against the new schema
- Operations: in-process execution (`graphql({ schema, source, contextValue })` or Apollo's `server.executeOperation`) for owner, second user and invalid input
- Batching: a nested-list test asserting the SQL statement count stays constant as list size grows
- Limits: an over-deep or alias-heavy operation is rejected with a clear error code
- Smoke: `curl -fsS -H 'content-type: application/json' --data '{"query":"{ __typename }"}' localhost:4000/graphql`, then the changed operation
- Project checks: typecheck, lint and tests through the project's scripts

## Stop and ask

- Removing or renaming fields, enum values or types, or changing nullability of existing fields.
- Disabling persisted documents, cost limits or error masking, even temporarily.
- Federation composition changes that affect other teams' subgraphs, or publishing to a production schema registry.
- Proof needs production traffic data or registry credentials you do not have.

## Before returning

- [ ] Schema diff reviewed; no unintended breaking change; deprecations carry reasons
- [ ] Authorization enforced below resolvers; second-user access via root, `node` and nested paths denied
- [ ] Loaders per request, order-preserving, and query count bounded for nested lists
- [ ] Depth, cost, alias and page-size limits in place for the changed fields
- [ ] Unexpected errors masked; expected failures returned as typed results
- [ ] Codegen, operation tests and project checks pass; real transport exercised

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[GraphQL specifications](https://spec.graphql.org/), [GraphQL.js](https://www.graphql-js.org/docs/), [GraphQL over HTTP](https://graphql.github.io/graphql-over-http/), [DataLoader](https://github.com/graphql/dataloader).

## Skills in scope

- api-design — HTTP transport status codes, batching and persisted-query policy, rate limiting.
- authentication-sessions — sign-in, sessions and tenant authorization feeding the GraphQL context.
- database-development — loader-backed queries, transactions and bounded results.
- realtime-systems — WebSocket or SSE transport for subscriptions, reconnect and ordering.
- storage-uploads — presigned upload flows instead of multipart GraphQL uploads.
- testing — operation-level tests, two-user isolation and query-count assertions.
