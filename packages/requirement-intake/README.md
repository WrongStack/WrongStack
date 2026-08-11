# @wrongstack/requirement-intake

Requirements Intake — collect, preserve, validate, normalize, and submit
unstructured software development requests as structured intake records.

This module is **upstream of spec-driven development**. It only collects and
preserves the initial request and its supporting information. It does not
plan tasks, generate executable specifications, resolve contradictions,
produce architecture, or generate code — those concerns belong to separate
modules (`@wrongstack/sdd` and friends).

## Design goals

1. **The original request is sacred.** The exact user input is stored verbatim
   in `originalRequest` and is immutable after creation. No update path, no
   LLM suggestion, and no normalization step can overwrite it.
2. **Every derived value is separable and source-annotated.** Normalized,
   summarized, categorized, or LLM-generated content is stored separately and
   tagged with `fieldSources` / `source` (`user`, `llm`, `deterministic`).
3. **LLM output is always a proposal.** It is validated against a schema,
   stored with `source: 'llm'`, and only applied after an explicit user
   `acceptSuggestion`. It never controls persistence, authorization, or
   lifecycle state.
4. **Deterministic validation and lifecycle.** Enums are authoritative;
   unknown request types map to `other`/`unspecified`; status transitions are
   enforced by application logic.
5. **Safety first.** Authorization is enforced on every operation (fail
   closed), concurrent writes use optimistic concurrency + file locks,
   create/submit are idempotent, and no sensitive request content ever
   reaches logs, metrics, or events.

## Quick start

```ts
import {
  RequirementIntakeStore,
  RequirementIntakeService,
  AllowAllIntakeAuthorizer,
} from '@wrongstack/requirement-intake';

const store = new RequirementIntakeStore({ baseDir: '.wrongstack/requirement-intakes' });
const service = new RequirementIntakeService({
  store,
  authorizer: new AllowAllIntakeAuthorizer(), // wire your own policy in production
});

const ctx = { id: 'user-42', type: 'user', projectId: 'proj_01ABCDEF123456789' };

const { record } = await service.createIntake(
  {
    projectId: ctx.projectId,
    originalRequest: 'Add email-based password reset so users can recover access.',
    requestedBy: ctx.id,
  },
  ctx,
);

await service.addAnswer(record.id, { field: 'business_goal', answer: 'Reduce support tickets' }, ctx);
const { record: submitted } = await service.submitIntake(record.id, ctx);
```

## Operations

| Operation | Method |
|---|---|
| Create intake | `createIntake(input, ctx)` |
| Update draft | `updateIntake(id, patch, ctx, expectedVersion?)` |
| Get intake | `getIntake(id, ctx)` |
| Add answer | `addAnswer(id, { field, answer }, ctx)` |
| Update answer | `updateAnswer(id, answerId, { answer }, ctx)` |
| Attach resources | `attachResource(id, { attachment \| relatedResource }, ctx)` |
| LLM suggestions | `generateSuggestions(id, ctx, focus?)` |
| Accept suggestion | `acceptSuggestion(id, proposalId, ctx)` |
| Reject suggestion | `rejectSuggestion(id, proposalId, ctx)` |
| Submit | `submitIntake(id, ctx)` |
| Cancel | `cancelIntake(id, ctx, reason?)` |
| Archive | `archiveIntake(id, ctx)` |
| List project intakes | `listIntakes(projectId, ctx, filter?)` |
| Pending questions | `pendingQuestions(id, ctx)` |

Every mutation accepts an optional `expectedVersion` for optimistic
concurrency; a mismatch throws `IntakeConflictError`.

## Data model

The record adapts the spec's snake_case JSON to the codebase's camelCase
convention:

| Concept (spec) | Field |
|---|---|
| `id` | `id` — `reqi_<ulid>` |
| `project_id` | `projectId` |
| `original_request` | `originalRequest` — immutable |
| `normalized_summary` | `normalizedSummary` |
| `request_type` | `requestType` |
| `requested_by` | `requestedBy` |
| `business_goal` | `businessGoal` |
| `target_users` | `targetUsers` |
| `expected_outcome` | `expectedOutcome` |
| `scope_notes` | `scopeNotes` |
| `provided_context` | `providedContext` |
| `related_resources` | `relatedResources` |
| `created_at` / `updated_at` | `createdAt` / `updatedAt` (epoch ms) |

Plus: `status`, `priority`, `constraints`, `attachments`, `answers`,
`questions`, `llmSuggestions`, `metadata`, `fieldSources`, `version`,
`history`, submission/cancellation/archival stamps, and the create
`idempotencyKey`.

Request types: `feature`, `bug_fix`, `refactor`, `performance`, `security`,
`ui_change`, `api_change`, `infrastructure`, `migration`, `testing`,
`documentation`, `maintenance`, `other`, `unspecified`.

Lifecycle: `draft → collecting_information → submitted`, `draft → cancelled`,
`collecting_information → cancelled`, `submitted/cancelled → archived`.
Invalid transitions throw `IntakeStateTransitionError`. Duplicate submission
is idempotent (returns the submitted record).

## LLM suggestions

Wire an adapter that implements `LlmSuggestionGenerator` and returns
structured output:

```ts
const service = new RequirementIntakeService({
  store,
  authorizer,
  generator: {
    async generate({ record, focus }) {
      // call your LLM; return structured JSON only
      return {
        suggested_title: 'Add email-based password reset',
        normalized_summary: 'Allow users to reset forgotten passwords through an email link.',
        suggested_request_type: 'feature',
        extracted_constraints: ['Rate-limit reset emails'],
        suggested_questions: [{ field: 'target_users', question: 'Which users?' }],
      };
    },
  },
});
```

Output is validated with zod (`llmSuggestionOutputSchema`); malformed output
throws `IntakeSuggestionError` and is never persisted. Generating suggestions
moves a `draft` to `collecting_information` (application logic, not the LLM).

## Authorization

Pass an `IntakeAuthorizer` to the service. The module fails closed: without a
permissive authorizer, every operation throws `IntakeAuthorizationError`.

- `AllowAllIntakeAuthorizer` — embedded/single-user hosts.
- `DenyAllIntakeAuthorizer` — fail-closed default.
- `ProjectMembershipIntakeAuthorizer` — membership-based policy with optional
  owner-only operations and built-in cross-project denial.

The service always verifies `record.projectId === ctx.projectId` through the
authorizer and rejects `listIntakes` for a project different from the
context's project.

## Persistence & concurrency

File-backed JSON store (mirrors `SpecStore` conventions):

```
baseDir/<id>.json           — one record per file
baseDir/_index.json         — listing index
baseDir/_idempotency.json   — create-idempotency key map
```

- Every write goes through `atomicWrite` (temp + rename) under a per-file
  exclusive lock (`withFileLock`), serializing concurrent writers within and
  across processes.
- `version` is a per-write mutation counter; passing a stale `expectedVersion`
  throws `IntakeConflictError` instead of silently overwriting.
- Create is idempotent via `idempotencyKey` (hashed in `_idempotency.json`).
- Change history is appended per write (`history`, capped at 200 entries).
- Records are never hard-deleted; `archived` is the soft-delete path.

Default location: `~/.wrongstack/projects/<slug>/requirement-intakes`
(`resolveWstackPaths(...).projectRequirementIntakes` — the `baseDir` option is
optional and falls back to this when omitted).

## Integrations

- **REST** — the WebUI server exposes the intake API under
  `/api/projects/:projectId/requirement-intakes` (create/list) and
  `/api/requirement-intakes/:intakeId` (get/patch/answers/suggestions/
  submit/cancel/archive), token-gated like every other `/api` route. The
  service is constructed per project in `startHttpServer` with an
  `AllowAllIntakeAuthorizer` (the HTTP token gate is the authorization
  boundary); hosts may inject their own via `intakeService`.
- **CLI** — `/intake [text]` creates and submits an intake record from the
  given text or the most recent session prompt (see `docs/slash/intake.md`).
- **MCP** — `@wrongstack/requirement-intake-mcp` provides
  `wstack-requirement-intake-mcp`, a project-scoped MCP server with
  `requirement_intake_list` (read tier) and `requirement_intake_submit`
  (writable tier) tools, mirroring the kanban-mcp pattern.
- **SDD** — `startInterviewFromIntake(driver, record)` /
  `intakeToInterviewKickoff(record)` in `@wrongstack/sdd` seed a spec-builder
  interview from a submitted intake record, using the original request as the
  interview intent and the collected facts as project context.

## WebUI scope: minimal-by-design

The WebUI activity-bar panel (`packages/webui/src/components/RequirementIntakeView.tsx`,
icon: `ClipboardList`, label: "Requirements") is intentionally **minimal**:
list project intake records + file a new one. Its i18n keys
(`activity.reqIntake.*`) cover only the create form and the list — there are
no keys for answers, attachments, suggestions, accept/reject, or cancel.
This is the deliberate boundary.

**What the panel does today**

- Lists records for the resolved project via `GET /api/requirement-intakes`
  (server returns `{ projectId, intakes }`).
- Files a new record with `POST /api/projects/:projectId/requirement-intakes`
  then submits it with `POST /api/requirement-intakes/:id/submit`. The body
  carries `projectId` (server-resolved) and `requestedBy: 'webui'` (matching
  the `techstack-handlers` sentinel; swap to a real user id when WebUI
  exposes one).
- Surfaces success (`Intake recorded and submitted (<id>).`) and server
  errors (HTTP status + parsed `error.message`).
- Refreshes the list after a successful submit.

**What the panel does not do (by design)**

- **Inline answer / question editor.** Adding a `DEFAULT_INTAKE_QUESTIONS`
  flow with `addAnswer` / `updateAnswer` / `pendingQuestions` is a full
  questionnaire UI — comparable to `SddInterviewView`. Belongs in a
  dedicated intake-detail view or in SDD itself, not in the activity-bar
  panel.
- **LLM suggestion UI.** `generateSuggestions` requires a real
  `LlmSuggestionGenerator` adapter to be wired into the webui-server; the
  server runs without one. Adding UI for a non-existent path is misleading,
  and exposing `acceptSuggestion` / `rejectSuggestion` would commit the view
  to a generator contract that is currently pluggable.
- **Attachment upload.** The `attachResource` schema requires exactly one of
  `path` or `url` plus a `kind` enum and a non-blank name. File-picker,
  size limits, MIME detection, and storage strategy are out of scope for a
  single-purpose panel.
- **Field editing after draft.** `PATCH /api/requirement-intakes/:id` exists
  and is used by programmatic callers; the panel's job is filing, not
  editing.

**Three small exceptions the panel will add next**

Even while staying minimal, three additions pay for themselves quickly.
All three are gated on lifecycle (`MUTABLE_STATUSES = ['draft',
'collecting_information']`) so the panel never mutates a submitted,
cancelled, or archived record.

1. **Read-only detail panel.** Clicking a record opens a side panel showing
   the full record body: `originalRequest` (verbatim, monospace),
   `normalizedSummary`, `businessGoal`, `expectedOutcome`, `scopeNotes`,
   `targetUsers`, `constraints`, `providedContext`, `attachments`,
   `relatedResources`, `answers`, `questions`, and `llmSuggestions`
   (read-only, source-tagged). Makes the list clickable without adding any
   mutation surface. One new component, no service changes.
2. **Cancel button on draft records.** Single button, single endpoint
   (`POST /api/requirement-intakes/:id/cancel`). Visible only when the
   record's `status` is in `MUTABLE_STATUSES`; cancel transitions
   `draft → cancelled` or `collecting_information → cancelled`
   (`lifecycle.ALLOWED_TRANSITIONS`). Submitted/cancelled/archived records
   surface an **Archive** action instead, gated behind a confirm dialog
   because archive is irreversible.
3. **Status-locked error surfacing.** When the panel POSTs an action
   against a record that is no longer mutable (e.g. another tab
   `submitIntake`ed a draft the moment the user clicked Cancel), the
   server returns 409 with `INTAKE_STATUS_LOCKED`. The view should detect
   that code, refresh the list, and surface a non-alarming "this record
   was finalized elsewhere — reloaded" notice rather than a generic error.

**Power-user path:** Everything the panel omits is reachable via the
REST API, the `/intake` slash command, the `@wrongstack/requirement-intake-mcp`
server, and the `@wrongstack/sdd` interview bridge. The panel exposes the
`id` and status so a user can copy the id and run CLI/REST against it.

**Rationale.** The activity bar's panels are *varied* in surface area —
each is sized to its domain's natural complexity, not to a single shared
shape. Concretely (line counts from `packages/webui/src/components`):

| Activity-bar panel | Backing component(s) | Surface |
|---|---|---|
| `intake` (Requirements) | `RequirementIntakeView.tsx` | 366 lines — single form + list |
| `sddhub` (SDD) | `SddHub.tsx` | 117 lines — thin entry, defers to other views |
| `goal` (Goal) | `GoalView.tsx` | 526 lines — focused |
| `roster` (Agent Roster) | `AgentRosterView.tsx` | 569 lines — focused |
| `kanban` (Kanban) | `KanbanView.tsx` | 646 lines — focused |
| `techstack` (TechStack) | `TechStackView/index.tsx` + 5 sub-components | 757 lines + 1,034 lines of sub-panels (1,791 total) |
| `codemap` (CodeMap) | `CodeMap.tsx` | 889 lines — full explorer |
| `memory` (Memory) | `MemoryManager/index.tsx` + 14 sub-components | 1,096 lines + 3,508 lines of sub-components (4,604 total) |

(Line counts measured with `(Get-Content -Path | Measure-Object -Line).Lines` on `*.tsx`/`*.ts` files under `packages/webui/src/components/`, excluding `node_modules` and `dist`. Re-measure any time; the source files keep moving.)

The right question for the Requirements panel is not "match the smallest
panel" — it's *does the panel reflect the domain's natural surface, without
bloat?* The intake domain has a wide surface (answers, attachments,
suggestions, lifecycle transitions) but a narrow *entry point*: the
verbatim original request. The minimal panel correctly captures that entry
point; the full surface is reachable via REST/CLI/MCP/SDD.

A full feature-CRUD view would (a) obscure the module's core invariants —
original request sacred, source-tagging, LLM output is proposal,
deterministic validation, fail-closed auth — by spreading them across
mutation paths; (b) couple WebUI to the LLM-suggestion generator contract
before a real adapter exists; (c) force a multi-pane questionnaire layout
that breaks on mobile; and (d) leave the LLM-suggestion path shipped-but-
broken at the UI level. The minimal surface keeps the entry point obvious,
leaves the LLM path unimplemented at the UI level until a real generator
is wired in, and pushes the structured-questioning UX to `SddInterviewView`
where it already lives.

## Observability

- **Events** — `RequirementIntakeCreated`, `RequirementIntakeUpdated`,
  `RequirementIntakeInformationRequested`, `RequirementIntakeSubmitted`,
  `RequirementIntakeCancelled`, `RequirementIntakeArchived`. Payloads carry
  identifiers and safe metadata only — never request content.
- **Metrics** (`IntakeMetrics`) — created/submitted/cancelled/archived counts,
  duplicate create/submit, validation failures, suggestion
  requested/succeeded/failed, unauthorized attempts, and
  `intake.time_to_submit` duration.
- **Logging** (`IntakeLogger`) — structured, scope-tagged, identifiers only.

All three are injectable; defaults are silent. Request content, answers, and
metadata values are never passed to the logger, metrics, or events.

## Security

- Prompt-injection text is ordinary data: preserved verbatim, never executed.
- Oversized input, blank fields, malformed metadata, and unknown enums are
  rejected/normalized deterministically.
- Cross-project access is denied; automation identities receive only what the
  authorizer grants.
- Sensitive content does not leak into logs/events (covered by tests).

## Development

```bash
pnpm --filter @wrongstack/requirement-intake typecheck
pnpm --filter @wrongstack/requirement-intake test
pnpm --filter @wrongstack/requirement-intake build
```

Tests: 147 unit/integration/security tests in `tests/` (run under both the
package config and the workspace root config).
