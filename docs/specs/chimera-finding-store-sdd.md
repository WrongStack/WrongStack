# Chimera Finding Store — Software Design Document

**Spec ID:** `chimera-finding-store-v1`  
**Version:** `1.0.0-draft`  
**Created:** 2026-07-26  
**Status:** Draft  
**Template:** SDD feature  
**Owner:** Core Coordination + Chimera maintainers  
**Task graph:** (generated after spec approval)

---

## 1. Overview

### 1.1 Problem

Chimera reviews (auto-review, post-session, cascade) produce rich structured findings every session, but the output vanishes into the mailbox JSONL and the session transcript. There is no persistent record of:

- What findings were discovered, in which file, at which line, with what severity
- Whether a finding was fixed, ignored, triaged, or remains open
- Which session or agent was responsible for introducing the code flagged by a finding
- How finding volume and resolution rates trend over time

This means every session starts fresh — the same issue can be flagged, ignored, and forgotten across multiple sessions without anyone noticing.

### 1.2 Goal

Persist every Chimera review finding as a structured record with a tracked lifecycle from discovery through resolution, integrated into the existing mailbox delivery and Kanban task systems without disrupting the current review flow.

### 1.3 Non-goals

This spec does **not**:

- Replace the mailbox as the delivery channel for review reports — reports still reach the leader via `type=result` as they do today
- Build a full issue tracker — Kanban handles task tracking; this store tracks review findings specifically
- Automatically verify fixes — the cascade loop handles re-review; this store just records the outcome
- Add a new agent or subagent type — all work is done inline in existing chimera event handlers
- Parse findings from every possible LLM output format — only the canonical Chimera report format (`### Severity (N)` with numbered list items) is supported

### 1.4 Design principles

1. **Append-only event log.** Findings are immutable once written; status transitions are separate events. Same pattern as mailbox v1 ack records and v2 receipt records.
2. **Idempotent ingestion.** The same finding text from the same file at the same line produces the same fingerprint. Duplicate fingerprints are linked, not re-stored.
3. **Zero disruption to the existing pipeline.** The parser hooks into `chimera.review_complete` — the review dispatch, cascade, and mailbox delivery paths are unchanged.
4. **Lifecycle is explicit out-of-band.** A finding's status does NOT live on the finding record. It is derived from the latest lifecycle event. This avoids rewrite contention.
5. **SAGE integration optional.** Anchored findings should surface when the same file is later reviewed, but this is Phase 2 — not required for P0 value.

---

## 2. Requirements

### Critical

#### R1 — Structured finding extraction from Chimera reports

`[critical][functional]` The canonical Chimera report format is parsed into individual structured findings. Each finding captures file, line, severity, title, description, and any suggested fix.

**Acceptance criteria**

- Given a report with `### Critical (2)` heading and 2 numbered list items under it, the parser produces 2 `critical` findings.
- Given a report with `### High (1)` heading and 1 item, the parser produces 1 `high` finding.
- The parser handles both `(N)` inline counts and the fallback count-via-list-items for each severity level (mirrors existing `parseReviewSeverity()` behavior but per-finding, not aggregated).
- Each finding extracts `file:line` from the first line of the finding item (format: `**File:** \`path/to/file.ts:42\`` or `file/path.ts:42` or `[BUG] file/path.ts`).
- Each finding extracts the severity from the parent section header.
- Each finding extracts the description from the paragraph(s) after the file reference.
- When `(N)` count and actual item count disagree, the actual item count wins (LLMs sometimes miscount).
- When a finding item lacks a parseable file:line, it still produces a finding with `file: null` rather than being silently dropped.
- When the report has no findings at all (`all clear`), the parser produces an empty array — no false findings.

#### R2 — Persistent finding store with append-only lifecycle

`[critical][functional]` Findings are written to a project-local JSONL file. Status transitions (triaged, fixed, ignored, etc.) are appended as separate event records. The store survives process restarts, session boundaries, and compaction.

**Acceptance criteria**

- The store file lives at `~/.wrongstack/projects/<slug>/review-findings.jsonl`.
- Each write uses atomic temp-file + rename for crash safety (same pattern as `atomicWrite` in `packages/core/src/utils/atomic-write.js`).
- A finding is written exactly once. Duplicate fingerprints do not create duplicate records — they produce a `relinked` event on the existing finding.
- Status transitions are appended as event records referencing the finding ID and old/new status.
- A compaction operation folds events into materialized status on the finding record and prunes events older than a configurable TTL.
- The store is lock-protected for concurrent writers (same pattern as `withFileLock`).

#### R3 — Fingerprint deduplication

`[critical][functional]` The same finding across multiple reviews of the same file resolves to the same logical record.

**Acceptance criteria**

- Fingerprint = `SHA256(file + ":" + line + ":" + normalizedTitle)`.
- Title normalization: strip trailing punctuation, collapse whitespace, lowercase.
- When an incoming finding matches an existing active finding's fingerprint, a `relinked` event is appended (the same issue was found again).
- When an incoming finding matches an existing resolved finding's fingerprint, a `reopened` event is appended (a previously fixed issue has returned).
- Deduplication is at finding-write time, not at parse time — the store rejects the duplicate and emits the appropriate event.

### High

#### R4 — Finding lifecycle state machine

`[high][functional]` Every finding progresses through a documented state machine with required authorization for transitions.

**Acceptance criteria**

- The state machine is:

```
found → triaged → in_progress → resolved
  │         │          │
  │         ├─→ wontfix ──→ resolved (terminal)
  │         │
  ├─→ ignored ──→ found (reopen)
  │
  └─→ resolved (via duplicate/false_positive merge)
```

- `found` is the initial state, assigned at parse time.
- `triaged` means a human or automated triage has acknowledged the finding.
- `in_progress` means someone is actively working on a fix.
- `resolved` is terminal and carries an `outcome` field.
- `ignored` means the finding was deliberately skipped; it can be reopened to `found`.
- `wontfix` is a permanent resolution subtype — the team decided not to fix this specific issue.
- Status transitions require either `agentId` (automated) or `operatorId` (human) attribution.
- Unknown or impossible transitions (e.g. `resolved → found` or `ignored → resolved`) are rejected with a structured error.

#### R5 — Mailbox integration

`[high][functional]` Every Chimera mailbox message (`type=result`) carries a reference to the stored finding report.

**Acceptance criteria**

- The review's `taskContext` field in the mailbox message includes a `findingReportId` key.
- A `/review findings` slash command lists all findings for the current session or project, with filter options by severity and status.
- A `/review finding <id>` command shows the full finding record including lifecycle history.

#### R6 — Finding report aggregation

`[high][ux]` The `/review` slash command and an optional WebUI view aggregate findings across sessions.

**Acceptance criteria**

- `/review` without arguments shows a summary: count by severity, count by status, oldest unresolved.
- `/review findings --severity critical --status open` lists matching findings.
- `/review finding <fingerprint>` shows the full lifecycle of a specific finding including every relinked/reopened event.
- The finding list is sorted by severity (critical first), then by age (oldest first).

### Medium

#### R7 — Compaction and retention

`[medium][non-functional]` The store has bounded size through configurable retention and compaction.

**Acceptance criteria**

- Default retention: `resolved` findings older than 30 days are eligible for compaction.
- Default retention: `ignored`/`wontfix` findings older than 14 days are eligible.
- Compaction rewrites the JSONL, folding event history into each finding's final state.
- Compaction preserves all findings with `active` status regardless of age.
- Compaction is idempotent and produces a valid, parseable JSONL output.
- A `/review findings --include-compacted` flag surfaces compacted records.

#### R8 — Forensic event trace

`[medium][functional]` Every event in a finding's lifecycle records who did what, when, and why.

**Acceptance criteria**

- Every event record carries: `eventType`, `actorId`, `actorKind` (`agent` | `operator` | `system`), `timestamp`, `reason` (free text).
- The `resolved` event carries `outcome` and `committedAt` / `commitSha` when applicable.
- The `relinked` event carries the source session ID and review ID that re-identified the finding.

---

## 3. Data Model

### 3.1 Core types

```typescript
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingStatus = 'active' | 'triaged' | 'in_progress' | 'resolved' | 'ignored';
export type ResolutionOutcome =
  | 'fixed'
  | 'wontfix'
  | 'duplicate'
  | 'false_positive'
  | 'stale'
  | 'merged';

export interface ChimeraFinding {
  /** Immutable UUID assigned at first write. */
  id: string;
  /** Content fingerprint for deduplication. */
  fingerprint: string;
  /** Severity from the report heading. */
  severity: FindingSeverity;
  /** Review type that produced this finding. */
  source: 'auto' | 'chimera' | 'cascade' | 'security-scanner';
  /** Where the issue was found. */
  location?: {
    file: string;
    line?: number | undefined;
  } | undefined;
  /** Finding title (from the numbered list item). */
  title: string;
  /** Full description (from the paragraphs under the list item). */
  description: string;
  /** Suggested fix, if any. */
  suggestedFix?: string | undefined;
  /** ISO8601 — when the finding was created. */
  createdAt: string;
  /** Materialized current status. */
  status: FindingStatus;
  /** Set only when status === 'resolved'. */
  resolution?: {
    outcome: ResolutionOutcome;
    resolvedAt: string;
    resolvedBy: string;
    commitSha?: string | undefined;
    committedAt?: string | undefined;
    notes?: string | undefined;
  } | undefined;
  /** Original review report this finding came from. */
  originReport: {
    reportId: string;
    sessionId: string;
    agentId: string;
    reviewerModel: string;
  };
}

export interface FindingLifecycleEvent {
  id: string;
  findingId: string;
  eventType:
    | 'created'    // Initial creation
    | 'relinked'   // Same fingerprint found again (duplicate, not stored)
    | 'reopened'   // Previously resolved finding found again
    | 'triaged'
    | 'started'
    | 'resolved'
    | 'ignored'
    | 'compacted'; // Historical event folded during compaction
  fromStatus: FindingStatus | null;
  toStatus: FindingStatus;
  actorId: string;
  actorKind: 'agent' | 'operator' | 'system';
  timestamp: string;
  reason?: string | undefined;
}

export interface FindingStoreEntry {
  version: 1;
  /** The finding itself (written once). */
  finding: ChimeraFinding;
  /** Lifecycle events, append-only. */
  events: FindingLifecycleEvent[];
  /** Last write timestamp (server-side, not from input). */
  updatedAt: string;
}
```

### 3.2 Fingerprint generation

```
fingerprint = SHA256(concat(
  normalize(path.to/file.ts),
  ':',
  string(line ?? 0),
  ':',
  normalize(title.trim().replace(/[^\w\s]/g, '').toLowerCase())
))
```

### 3.3 JSONL record types

The store file uses discriminator-keyed JSONL lines, same pattern as mailbox:

```typescript
// A finding record (written once per unique finding)
{ "__finding": 1, "id": "uuid", "fingerprint": "sha256...", ... }

// A lifecycle event (appended on transition)
{ "__findingEvent": 1, "findingId": "uuid", "eventType": "resolved", ... }

// A compaction marker (written after compaction)
{ "__findingCompact": 1, "compactedAt": "ISO8601", "removedEvents": 12 }
```

---

## 4. Architecture

### 4.1 Module layout

```
packages/core/src/plugins/
├── review-finding-parser.ts     # R1: Parse Chimera reports → Finding[]
├── review-finding-store.ts      # R2: JSONL store with lifecycle
├── review-finding-types.ts      # Shared types for the finding system
├── review-finding-commands.ts   # R5/R6: Slash commands

packages/core/tests/plugins/
├── review-finding-parser.test.ts
├── review-finding-store.test.ts
└── review-finding-commands.test.ts
```

### 4.2 Integration points

```
chimera.review_complete
│
├─→ mailbox.send (unchanged — existing delivery path)
│
└─→ FindingParser.parse(reviewText, bundle) → Finding[]
    │
    └─→ FindingStore.upsert(findings) (deduplicates via fingerprint)
         │
         ├─→ JSONL append for new findings
         └─→ JSONL append for relinked/reopened events
```

The finding store is called AFTER the mailbox message is sent, so there is zero latency added to the leader's delivery path.

### 4.3 Lifecycle transitions

Only the following commands are allowed:

| Current status | Allowed next status | Authorized actors |
|---|---|---|
| `active` | `triaged`, `ignored` | operator, system (auto-triager) |
| `triaged` | `in_progress`, `ignored`, `resolved` (wontfix/duplicate) | operator |
| `in_progress` | `resolved`, `active` (backlog) | operator, agent (via cascade) |
| `ignored` | `active` | operator |
| `resolved` | `active` (reopen) | operator, system (relinked) |

---

## 5. Parser Contract

The canonical Chimera report format is:

```
## 🦂 Chimera Review

### Critical (2)
1. [BUG] path/to/file.ts:42 — null deref on user.name
   → Add guard: if (!user) throw new NotFoundError()
   **File:** `path/to/file.ts:42`
   **Category:** bug

2. [SECURITY] path/auth.ts:15 — hardcoded API key
   **File:** `path/auth.ts:15`
   **Remediation:** Move to environment variable.

### High (0)

No findings at this severity.

### Medium (0)
```

The parser extracts per-finding data by:

1. Finding section headers (`### Severity (N)` or `### Severity`)
2. Counting list items (`1. `, `2. `) under each section
3. For each list item:
   - First line after the number = title (extract up to ` — ` or newline)
   - Extract `**File:** \`path:line\`` pattern, or `[BUG/SECURITY/PERF] path:line` pattern
   - Lines starting with `→` or `**Remediation:**` = suggested fix
   - Everything else = description

Report sections that start with `No findings`, `No issues`, `all clear`, or contain zero list items produce zero findings for that severity.

---

## 6. Store Interface

```typescript
export interface FindingStore {
  /** Insert or relink findings. Returns upserted + relinked counts. */
  upsert(
    findings: ChimeraFinding[],
    context: { sessionId: string; reportId: string; agentId: string; model: string },
  ): Promise<{ created: number; relinked: number; reopened: number }>;

  /** Transition a finding's status. Appends a lifecycle event. */
  transition(
    findingId: string,
    to: FindingStatus,
    actor: { id: string; kind: 'agent' | 'operator' | 'system' },
    opts?: { reason?: string; outcome?: ResolutionOutcome; commitSha?: string },
  ): Promise<ChimeraFinding>;

  /** List findings with optional filters. */
  list(opts?: {
    severities?: FindingSeverity[];
    statuses?: FindingStatus[];
    file?: string;
    limit?: number;
  }): Promise<ChimeraFinding[]>;

  /** Get a single finding by ID or fingerprint. */
  get(idOrFingerprint: string): Promise<ChimeraFinding | null>;

  /** Get full lifecycle history for a finding. */
  getEvents(findingId: string): Promise<FindingLifecycleEvent[]>;

  /** Compact old resolved/ignored findings. */
  compact(opts?: { maxAgeMs?: number }): Promise<{ removed: number; eventsFolded: number }>;
}
```

---

## 7. Security Considerations

| Risk | Mitigation |
|---|---|
| Finding content exposes sensitive code/snippets | Findings are stored in project-local JSONL with the same file permissions as other project artifacts (0600) |
| Fingerprinting collisions (different issues, same hash) | Include line number AND normalized title in the hash; collision probability is negligible for same-file same-line same-title |
| Actor spoofing in lifecycle transitions | `actorKind` distinguishes agent vs operator; operator transitions require explicit `actorKind: 'operator'` and SHOULD come from a resolved operator principal in the future |
| Store corruption from concurrent compaction + write | File lock (same `withFileLock` pattern as mailbox) serializes all mutation operations |
| Retention too aggressive (lost forensic history) | Default retention is conservative (30/14 days); compaction folds events into the finding record rather than deleting them — no forensic data is permanently lost |

---

## 8. Testing Strategy

### 8.1 Parser tests (unit)

- Parse a complete report with all 4 severities and mixed finding counts.
- Parse a report with `(N)` count that disagrees with actual item count — item count wins.
- Parse an `all clear` report → empty array.
- Parse a report with a finding item that has no parseable file:line → finding with `location: null`.
- Parse a report with `→` fix suggestions and `**Remediation:**` sections.
- Parse a malformed report (missing severity headers, empty body, binary). 

### 8.2 Store tests (unit)

- `upsert` with new findings → `created: N`.
- `upsert` with duplicate fingerprints → `relinked: N`, no new finding records.
- `upsert` with fingerprint matching a previously `resolved` finding → `reopened: 1`.
- `transition` follows the state machine; invalid transitions are rejected.
- `transition` with unknown findingId → gracefully returns null/error.
- `list` with severity and status filters.
- `list` with file filter (substring match on normalized path).
- `compact` removes old resolved findings and folds events.
- Concurrent `upsert` + `compact` under file lock — no data loss.

### 8.3 Integration tests

- `chimera.review_complete` event → findings written to store.
- Mailbox message carries `taskContext.findingReportId`.
- `/review findings` slash command returns findings for the project.
- `/review finding <id>` returns the finding with lifecycle history.

---

## 9. Rollout Plan

| Phase | Scope | Deliverable | Tests |
|---|---|---|---|
| **P1** | Parser + JSONL store + `/review findings` CLI command | Finding types, parser, store, slash commands | ≥30 unit tests |
| **P2** | Mailbox `findingReportId` linkage + auto-integration | Hook into `chimera.review_complete` event | ≥5 integration tests |
| **P3** | WebUI ReviewFindingsView with filter/resolve | React component + WebSocket handler | ≥10 component tests |
| **P4** | HQ cross-project aggregation + analytics | HQ dashboard modules | ≥5 E2E tests |

---

## 10. Acceptance Criteria

1. Every Chimera review that produces a truthy `reviewText` also produces a persisted finding record.
2. Running `pnpm exec vitest run packages/core/tests/plugins/review-finding-parser.test.ts` passes with ≥90% parser line coverage on canonical report fixtures.
3. Running `pnpm exec vitest run packages/core/tests/plugins/review-finding-store.test.ts` passes with ≥85% store line coverage covering upsert, transition, list, get, compact, and concurrent-write scenarios.
4. `/review findings --severity critical --status active` returns only active critical findings.
5. `/review finding <id>` shows the full lifecycle history with timestamps and actors.
6. Two identical findings from the same file:line produce one store record and a `relinked` event.
7. A finding from a resolved report can be reopened by a subsequent review of the same file:line.
8. Compaction removes findings older than the configured TTL without affecting active findings.
9. `tsc --noEmit` passes on `@wrongstack/core`.

---

## 11. Maintainer Decisions (Resolved)

All five decisions have been resolved. Rationale is recorded so implementation can proceed.

### D1 — Store file location: alongside `_mailbox.jsonl` ✅

**Decision:** Store `review-findings.jsonl` at the project root (`~/.wrongstack/projects/<slug>/review-findings.jsonl`), alongside `_mailbox.jsonl`.

**Rationale:** Reuses the same lock, atomic-write, and compaction infrastructure that the mailbox already provides. A subdirectory adds path overhead with no benefit — the mailbox and finding store share the same lifecycle (process, session, cross-process concurrency) and can share the same lock directory.

**Impact on graph:** Task FS-P0.1 implements the store path resolution. No new infrastructure needed.

### D2 — Fingerprint scope: file + line + normalized title only ✅

**Decision:** Fingerprint = `SHA256(file + ":" + line + ":" + normalizedTitle)`. Snippet, suggested fix, and description are excluded.

**Rationale:** Including the suggested fix or snippet would make the fingerprint unstable across reviewer models (which phrase fixes differently) and prompt versions. Title normalization (lowercase, strip punctuation, collapse whitespace) provides sufficient deduplication — the same bug on the same line produces the same title regardless of phrasing variations.

**Impact on graph:** Task FS-P0.2 implements fingerprint generation. The hash function is deterministic and testable.

### D3 — Auto-triager agent: not in P0 ✅

**Decision:** No periodic auto-triager. The `/review findings` backlog is surfaced manually; triage is explicit.

**Rationale:** Until finding volume reaches a level where manual triage is impractical, an auto-triager adds complexity without proven value. P0 measures volume naturally — if it becomes a problem, an auto-triager can be added in P2/P3 with real data to guide its design.

**Impact on graph:** No task for auto-triager. FS-P0.5 (slash commands) provides the manual triage interface.

### D4 — WebUI view: CLI-only for P1, WebUI deferred to P3 ✅

**Decision:** `/review findings` and `/review finding <id>` slash commands are the P1 interface. WebUI ReviewFindingsView is deferred to P3.

**Rationale:** The CLI slash commands reach every surface (TUI, REPL, WebUI chat input) immediately without a separate view implementation. P1 focuses on store, parser, and slash commands. The WebUI view in P3 can build on proven store/CLI patterns.

**Impact on graph:** Task FS-P0.5 covers CLI commands. P3 WebUI is tracked by the rollout plan but not in the P0/P1 task graph.

### D5 — SAGE integration: Phase 2, after P1 ✅

**Decision:** The finding store feeds SAGE injection context for anchored file surfaces, implemented in Phase 2 after P1 store + parser are stable.

**Rationale:** The `review-context-builder.ts` already collects context for review subagents — anchoring active findings to the files being reviewed is a natural extension. But Phase 2 depends on P1 being stable (the store must work before we can query it). Deferring to Phase 2 avoids coupling the store's schema to SAGE's injection pipeline before either is proven.

**Impact on graph:** No P1 task for SAGE integration. The rollout plan tracks it as Phase 2.
