---
name: graphql-development
description: "Build and evolve GraphQL schemas/resolvers with typed contracts, authorization and bounded query work. Use when implementing GraphQL APIs or client operations; use api-design for HTTP transport and preserve the chosen server/client framework."
trigger: "Build and evolve GraphQL schemas/resolvers with typed contracts, authorization and bounded query work. Use when implementing GraphQL APIs or client operations; use api-design for HTTP transport and preserve the chosen server/client framework."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: backend
  domain: "backend"
---

# Graphql Development

## Selection card
- Task: Implement GraphQL schema and resolver contracts.
- Start: Locate the endpoint, schema, authentication boundary and caller.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Build and evolve GraphQL schemas/resolvers with typed contracts, authorization and bounded query work.

Checked GraphQL.js stable target: 17.0.2 on 2026-10-09. Verify current published specification and server/plugin compatibility before upgrading; a draft specification is not automatically the deployed contract.

## Rules

1. Model schema nullability and errors from real domain invariants, including how a null bubbles to clients.
2. Authorize object/field operations at their data boundary; one authenticated HTTP request cannot authorize all selected objects.
3. Bound depth/complexity/result size and batching according to the actual workload.
4. Scope loaders/caches by request and identity; shared loaders can leak private values.
5. Make mutations atomic/idempotent as needed and subscriptions explicit about auth/reconnect.
6. Evolve fields and enums with actual consumer compatibility; schema validation alone does not prove existing operations still work.

## Workflow

1. Inspect schema, resolvers, server version and registered client operations.
2. Resolve latest stable supported targets and define the contract change.
3. Implement validation/auth/data loading and public error semantics.
4. Test null/error paths, two-user isolation, query limits and representative operations.
5. Verify generated clients and actual transport/subscription behavior where applicable.

## Before returning

Schema and consumer contracts checked; request auth/cache boundaries preserved; work bounded; generated and runtime evidence recorded.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[GraphQL specifications](https://spec.graphql.org/), [GraphQL.js](https://www.graphql-js.org/docs/).

## Skills in scope

- api-design — api design contracts and verification.
- authentication-sessions — implement application sign-in, sessions and identity integration with explicit account/tenant authorization.
- database-development — implement database access, models and queries with explicit consistency, transactions and bounded results.
- realtime-systems — implement WebSocket, SSE or established realtime transports with explicit authentication, ordering and reconnect behavior.
