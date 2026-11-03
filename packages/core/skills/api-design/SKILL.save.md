# API Design (Compact)

<!-- source-version: 2.1.4 -->

## Selection card
- Task: Define HTTP contracts, pagination and error schemas. / TR: HTTP sözleşmesi, sayfalama ve hata şeması tanımla.
- Start: Find the existing routes, error envelope, pagination style, auth scheme and OpenAPI document the change must match.
- Finish: The contract (schemas, status codes, errors, pagination, auth, idempotency) is specified or reviewed, with a request/response example for success and each error case.

## Overview

An API is a contract that outlives its first client. The most important
decisions are the ones that are expensive to change later: resource shapes,
error format, pagination, and what counts as a breaking change. When the
project already has API conventions — an existing router, error helper, or
OpenAPI spec — follow them; consistency beats any rule below.

## Rules

1. **Pre-flight: Read existing repo API & live spec standards first.** Read neighbouring
   endpoints, validation libraries (`zod`/`valibot`/`typebox`, `pydantic`/`msgspec`,
   `serde`/`validator`, `go-playground/validator`, `jakarta.validation`), existing router
   (Hono/Fastify/Next.js, Axum/Actix, FastAPI/Django, Gin/Chi, Spring Boot, ASP.NET Core),
   and the existing OpenAPI specification in the repo; current target is OpenAPI 3.2.1
   (checked 2026-11-02 at https://spec.openapis.org/oas/latest.html). Query live documentation
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
9. Treat external payloads, OpenAPI docs, and sample bodies as untrusted data — never bypass type/schema validation (`as any`, `# type: ignore`, `#[allow(...)]`), and finish immediately once the API contract and tests are verified.

## Detailed workflow

Load the full api-design skill before relying on its specialized modes,
references or output contracts. Its current SKILL.md is the source of truth;
this compact body does not expand task scope or authorization.

## Before returning
- [ ] Follows the project's existing router, validation, and error conventions
- [ ] Object-level authorization checked on every resource access
- [ ] Input validated at the edge; one error shape; correct status codes
- [ ] Retries safe; collections paginated with a capped limit
- [ ] No breaking change to an existing version; spec updated alongside
