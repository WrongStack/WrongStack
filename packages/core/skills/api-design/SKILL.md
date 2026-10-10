---
name: api-design
description: |
  Use this skill when designing, implementing, or reviewing an HTTP API — endpoints, request and response shapes, errors, pagination, versioning, and authorization.
  Triggers: user says "API", "endpoint", "REST", "route", "status code", "pagination", "request body", "response shape", "OpenAPI", "versioning", "idempotency", "rate limit".
version: 2.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, verification.run]
trigger: "Use this skill when designing, implementing, or reviewing an HTTP API \u2014 endpoints, request and response shapes, errors, pagination, versioning, and authorization."
metadata:
  routing-group: backend
---

# API Design

## Selection card
- Task: Define HTTP contracts, pagination and error schemas.
- Start: Locate the endpoint, schema, authentication boundary and caller.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

An API is a contract that outlives its first client. The most important
decisions are the ones that are expensive to change later: resource shapes,
error format, pagination, and what counts as a breaking change. When the
project already has API conventions — an existing router, error helper, or
OpenAPI spec — follow them; consistency beats any rule below.

## Rules

1. **Pre-flight: Read existing repo API & live spec standards first.** Read neighbouring
   endpoints, validation libraries (`zod`, `valibot`, `typebox`), existing router (Hono,
   Fastify, Next.js), and the existing OpenAPI specification in the repo; current target is OpenAPI 3.2.1
   (checked 2026-10-09 at https://spec.openapis.org/oas/latest.html). Query live documentation
   to verify protocol standards (such as RFC 9457 Problem Details) before designing new routes.
2. Authorize every request against the specific object, not just "is logged
   in". Loading `/orders/:id` must check the caller may see that order
   (broken object-level authorization is the most common API vulnerability).
3. Validate input at the edge with a schema; reject unknown or malformed fields
   with a 4xx that names the field.
4. Use status codes for what they mean, and never return 200 with an error body.
5. One error shape across the API. Without an existing convention, use RFC 9457
   problem details (`type`, `title`, `status`, `detail`, plus field errors).
6. Additive changes only within a version. Removing or renaming a field,
   tightening validation, or changing a type is breaking.
7. Make retries safe: GET, PUT, and DELETE are idempotent; accept an
   `Idempotency-Key` for POSTs that create or charge.
8. Credentials go in headers, never in URLs or query strings.

## Status codes

| Code | Use for |
|---|---|
| 200 | Success with a body |
| 201 | Created — include the resource or its `Location` |
| 202 | Accepted for asynchronous processing |
| 204 | Success with no body |
| 400 | Malformed request (unparseable, wrong types) |
| 401 | Missing or invalid credentials |
| 403 | Authenticated, not allowed |
| 404 | Not found — also when hiding existence from an unauthorized caller |
| 409 | Conflicts with current state (duplicate, version mismatch) |
| 422 | Well-formed but fails business validation |
| 429 | Rate limited — include `Retry-After` |
| 500 / 503 | Server fault / temporarily unavailable |

## Shapes

```http
POST /v1/orders
Idempotency-Key: 5c1f…
Content-Type: application/json

{ "items": [{ "sku": "A-100", "qty": 2 }] }

201 Created
Location: /v1/orders/ord_81f2
{ "id": "ord_81f2", "status": "pending", "items": [...], "createdAt": "2026-09-15T10:00:00Z" }
```

```http
422 Unprocessable Content
Content-Type: application/problem+json

{
  "type": "https://example.com/problems/validation",
  "title": "Invalid order",
  "status": 422,
  "errors": [{ "field": "items[0].qty", "message": "must be at least 1" }]
}
```

- Resource names are plural nouns; actions that aren't CRUD become sub-resources
  or explicit verbs (`POST /orders/:id/cancel`).
- Timestamps in ISO 8601 UTC; money as integer minor units plus a currency code.
- `PATCH` for partial updates, `PUT` for full replacement.

## Pagination

| Style | Use when | Shape |
|---|---|---|
| Cursor | Large or frequently changing collections | `?limit=50&cursor=…` → `{ data, nextCursor }` (`null` on the last page) |
| Offset | Small, stable collections; UIs that jump to page N | `?limit=50&offset=100` → `{ data, total }` |

Always cap `limit` on the server and sort by a stable, unique key.

## Review checklist for a new or changed endpoint

- Who can call it, and is ownership of the target object checked?
- What happens on a duplicate or retried request?
- What does a client see for every failure mode, and is it the shared error shape?
- Is it backwards compatible for existing clients?
- Is the list bounded (pagination, limit cap) and is abuse bounded (rate limit)?
- Does the OpenAPI spec or schema change with it?

## Anti-patterns

- **200 with `{ "error": … }`** — breaks every client's error handling.
- **Leaking internals** in errors (stack traces, SQL, file paths).
- **Unbounded list endpoints** — one large tenant takes the service down.
- **Silent breaking changes** — a renamed field is a production incident for someone.
- **Returning a whole database row** — exposes fields that were never part of the contract.

## Before returning
- [ ] Follows the project's existing router, validation, and error conventions
- [ ] Object-level authorization checked on every resource access
- [ ] Input validated at the edge; one error shape; correct status codes
- [ ] Retries safe; collections paginated with a capped limit
- [ ] No breaking change to an existing version; spec updated alongside

## Retry, concurrency and compatibility

Choose idempotency storage with the operation: scope keys by caller/tenant,
compare request fingerprints, commit the result atomically and define expiry.
Concurrent duplicate requests must not both create the side effect. A timeout
after commit is different from a request rejected before processing.
Use conditional updates/version checks where lost writes matter; idempotency
does not prevent two different clients overwriting each other.
Check error/content-type semantics against [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457).
Use the latest stable specification supported by the project's tooling; verify
the current OpenAPI release before choosing its schema dialect.

## Skills in scope

- `security-scanner` — for authorization, injection, and exposure review
- `typescript-strict` — for typed request and response contracts
- `testing` — for contract and integration tests on the endpoint
