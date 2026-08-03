# Requirements Intake Module — SDD

> Status: implemented (v0.298.3) · Package: `packages/requirement-intake` ·
> Consumed by: future spec-driven modules (`@wrongstack/sdd`)

## 1. Purpose

Receive a user's unstructured software development request, preserve the
original input verbatim, collect essential high-level project information, and
produce a validated, source-annotated requirement intake record that
downstream modules (spec building, task decomposition, execution) can consume.

This module is **limited to intake and data collection**. Task planning,
executable-spec generation, contradiction resolution, architecture/code/test
generation, risk scoring, and implementation-readiness decisions are out of
scope by design.

## 2. Scope

- New package `@wrongstack/requirement-intake` with a service API, a
  file-backed store, deterministic validation and lifecycle, LLM-suggestion
  proposals, authorization, events, metrics, and logging.
- No changes to existing packages' behavior. No REST/CLI/WebUI wiring in this
  iteration — hosts consume the service API directly (see Limitations).

## 3. Requirements (acceptance criteria)

| # | Requirement | Verified by |
|---|---|---|
| R1 | Create an intake record from an unstructured request | `service.test.ts` — creation suite |
| R2 | Exact original request preserved forever; never overwritten | `service.test.ts` + `security.test.ts` (updates, submissions, LLM acceptance) |
| R3 | Request associated with project + requester | creation suite; submit-ready validation |
| R4 | Structured high-level information collected (answers, attachments, resources) | answers/attachments suites |
| R5 | Optional LLM suggestions generated safely | suggestions suite |
| R6 | LLM content distinguishable from user content | `fieldSources` / `source` tests |
| R7 | All authoritative fields pass deterministic validation | `validation.test.ts` |
| R8 | Valid lifecycle transitions enforced | `lifecycle.test.ts` + service lifecycle suite |
| R9 | Unauthorized access prevented (incl. cross-project) | `security.test.ts` |
| R10 | Duplicate + concurrent operations handled safely | idempotency + CAS + race tests |
| R11 | Automated tests pass | 147 tests, package + root vitest config |
| R12 | Module follows existing system architecture | file-store conventions, pnpm package, vitest, strict TS, Biome |

## 4. Design decisions

1. **Location**: standalone package `packages/requirement-intake` mirroring
   `@wrongstack/sdd` / `@wrongstack/kanban` (self-contained module, pnpm
   workspace glob `packages/*` picks it up).
2. **Naming**: camelCase adaptation of the spec's snake_case JSON
   (`original_request` → `originalRequest`, …). Documented in the README.
3. **IDs**: `reqi_<ulid>` matching the platform's `proj_<ulid>` convention.
4. **Persistence**: JSON files + `_index.json` + `_idempotency.json` under a
   host-chosen base dir, using `atomicWrite` / `withFileLock` from
   `@wrongstack/core/utils` (same primitives as SpecStore and Kanban).
5. **Concurrency**: per-file exclusive locks serialize writers; `version`
   counter + `expectedVersion` provide optimistic concurrency; submit uses a
   compare-and-swap retry so concurrent duplicate submissions resolve to one
   winner + one idempotent result.
6. **Authorization**: injected `IntakeAuthorizer`, awaited on every operation,
   fail-closed. Hosts choose the policy; cross-project access is denied.
7. **LLM integration**: `LlmSuggestionGenerator` adapter returns structured
   JSON; zod validation rejects malformed output; accepted suggestions are
   applied with `source: 'llm'`; the LLM never changes status directly
   (generating suggestions moves `draft → collecting_information` as
   application logic).
8. **Idempotent submit**: `submit` on an already-submitted record returns the
   record with `idempotent: true` (no error, no duplicate history entry) —
   the documented exception to the strict transition table, required by
   "duplicate submission protection".

## 5. Data model

`RequirementIntakeRecord` (camelCase) with: `id`, `projectId`, `title`,
`originalRequest` (immutable), `normalizedSummary`, `requestType`, `status`,
`priority`, `requestedBy`, `businessGoal`, `targetUsers`, `expectedOutcome`,
`scopeNotes`, `constraints`, `providedContext`, `attachments`,
`relatedResources`, `answers`, `questions`, `llmSuggestions`, `metadata`,
`fieldSources`, `idempotencyKey`, `version`, `history`, timestamps, and
submission/cancellation/archival stamps.

Enums: 14 request types; 5 statuses; 5 priorities; question/answer/suggestion
lifecycles. Unknown request types normalize to `other`; blank/missing to
`unspecified`.

## 6. Testing

- **Unit** (34 validation, 5 lifecycle, 10 questions, 13 suggestions, 14
  store): empty/oversized input, enum normalization, strict-schema
  immutability, transition table, question selection, LLM output validation,
  CAS conflicts, idempotent create.
- **Service** (51): full operation surface, source tracking, events, metrics,
  status locks, suggestion accept/reject, lifecycle, authorization.
- **Integration** (5): end-to-end create→answer→attach→suggest→submit,
  cross-instance persistence, concurrent updates, racing duplicate submits,
  parallel creation.
- **Security** (15): prompt injection treated as data, oversized input,
  cross-project access, malformed metadata, unauthorized attempts, owner-only
  submission, and log/event leakage.

Run: `pnpm --filter @wrongstack/requirement-intake test` or from root
`pnpm exec vitest run packages/requirement-intake/tests`.

## 7. Assumptions

- `requestedBy`/`projectId` are validated for non-blank, bounded shape only;
  the host validates against its user/project registries (the platform's
  canonical ids are `proj_<ulid>` but the module stays format-agnostic).
- Attachment payloads carry host-resolved paths/URLs; the module persists
  descriptors, not file bytes.
- Service API is the integration surface for now; REST/CLI wiring is a
  follow-up (see Limitations).
- The platform has no user model in this module's layer; authorization is
  delegated to the injected authorizer.

## 8. Limitations / follow-ups

- The intake REST API responds 503 until a host wires the service; the CLI's
  `/intake` command and the WebUI server's `startHttpServer` both wire it by
  default, and the standalone `@wrongstack/requirement-intake-mcp` server
  (`wstack-requirement-intake-mcp`) exposes list + submit tools over MCP.
- Answer values for `target_users`/`constraints`/`provided_context` append
  (multi-line answers become multiple items) rather than replace.
- LLM question suggestions only add to the question list; they do not
  auto-populate answers.
- No migration tooling for the store layout (version 1 JSON; stable by
  construction).
