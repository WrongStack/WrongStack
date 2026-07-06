---
name: api-design
description: |
  Use this skill when designing, reviewing, or refactoring REST APIs in WrongStack.
  Triggers: user says "API", "endpoint", "REST", "request", "response", "JSON",
  "HTTP", "status code", "pagination", "query params", "request body".
version: 1.0.0
---

# API Design — WrongStack

## Overview

Designs and reviews REST APIs for WrongStack services. WrongStack uses JSON over HTTPS, conventional HTTP status codes, and cursor-based pagination. APIs are consumed by the TUI, webui, and external integrations.

## Rules

1. Use conventional HTTP status codes: `200` (ok), `201` (created), `400` (bad request), `401` (unauthorized), `403` (forbidden), `404` (not found), `500` (server error).
2. Always return consistent error shape: `{ "error": { "code": "ERROR_CODE", "message": "Human readable" } }`.
3. Use plural nouns for resource names: `/sessions` not `/session`.
4. Pagination: cursor-based for large datasets, not offset-based.
5. Request validation: validate on server, return `400` with field-level errors.
6. Idempotency: `POST` to `/resources` creates; `PUT` to `/resources/:id` replaces.
7. No secrets in URLs — put auth in headers, not query params.
8. Versioning: prefix with `/v1/` when breaking changes are inevitable.

## Patterns

### Do

```typescript
// ✅ Consistent error shape
interface ErrorResponse {
  error: {
    code: string; // machine-readable: "VALIDATION_ERROR"
    message: string;    // human-readable: "name is required"
    details?: unknown;  // optional field-level errors
  };
}

// ✅ Cursor-based pagination
interface PaginatedResponse<T> {
  data: T[];
  nextCursor: string | null;  // null = last page
  hasMore: boolean;
}

// GET /sessions?cursor=abc123&limit=20

// ✅ Proper status codes
if (!resource) return Response.json({ error: { code: 'NOT_FOUND', message: '...' } }, { status: 404 });
if (!auth) return Response.json({ error: { code: 'UNAUTHORIZED', message: '...' } }, { status: 401 });
```

### Don't

```typescript
// ❌ Inconsistent error shape
Response.json({ message: 'Not found' }); // no code, no standard shape

// ❌ Secrets in URL
GET /api/data?apiKey=sk-xxx  // ❌ put in Authorization header

// ❌ Offset pagination (fragile on mutations)
GET /users?offset=100&limit=20  // ❌ gaps after insert/delete

// ❌ 200 for errors
Response.json({ error: '...' }, { status: 200 }); // lies about outcome
```

## Request/response patterns

### Create resource (POST)

```
POST /sessions
Body: { "provider": "anthropic", "model": "<model-id>" }
201: { "id": "sess_abc", "provider": "anthropic", ... }
400: { "error": { "code": "VALIDATION_ERROR", "message": "model is required" } }
```

### Get resource (GET)

```
GET /sessions/sess_abc
200: { "id": "sess_abc", "status": "running", ... }
404: { "error": { "code": "NOT_FOUND", "message": "Session not found" } }
```

### List with pagination

```
GET /sessions?cursor=sess_xyz&limit=20
200: {
  "data": [...],
  "nextCursor": "sess_aaa",
  "hasMore": true
}
```

### Update resource (PUT)

```
PUT /sessions/sess_abc
Body: { "status": "paused" }
200: { "id": "sess_abc", "status": "paused", ... }
400: { "error": { "code": "INVALID_STATUS", "message": "Must be running or paused" } }
```

## Error codes

| Code | HTTP | When |
|------|------|------|
| `VALIDATION_ERROR` | 400 | Request body/params invalid |
| `UNAUTHORIZED` | 401 | Missing or invalid auth |
| `FORBIDDEN` | 403 | Auth valid but no permission |
| `NOT_FOUND` | 404 | Resource doesn't exist |
| `CONFLICT` | 409 | Duplicate resource |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Server-side failure |

## Authentication

- Bearer token in `Authorization` header: `Authorization: Bearer <token>`
- API key in `X-API-Key` header for machine-to-machine
- Never use query params for auth credentials

## WrongStack-specific notes

- **WrongStack CLI**: Most API calls go through the CLI's internal tool wrappers, not raw HTTP.
- **Session management**: Sessions are created/managed via the CLI, not a public REST API.
- **MCP tools**: MCP servers expose tools, not REST endpoints — this skill is for any HTTP APIs WrongStack exposes.

## Skills in scope

- `sdd` — for spec-driven API design with acceptance criteria
- `typescript-strict` — for type-safe request/response types
- `security-scanner` — for scanning API implementations for injection, auth, and secrets
- `testing` — for writing integration tests against API endpoints
- `output-standards` — for standardized `<nextsteps>` formatting
