# Explore Companion — a state-triggered background codebase explorer

Status: **Implemented** (role + observer + host wiring + unit tests; verified 2026-08-19)
Owner: leader agent / fleet
Last updated: 2026-08-19

## 1. Problem

A leader agent executing a task in an unfamiliar repo burns its own
context and iteration budget discovering *where things are*: it reads a
file, greps for a symbol, reads its callers, loses the thread, and
re-discovers the same territory later. The existing `explore` roster role
(`packages/core/src/coordination/agents/phase1-discovery.ts`) only helps
when the leader *explicitly* calls `delegate({ role: 'explore' })` and
**blocks** on the `TaskResult` — it is a manual, one-shot, synchronous
mapper.

This design introduces a **companion** explore agent that:

1. **runs behind** the leader — spawned alongside the leader's work,
   never blocking it (`spawn` + `assign`, never `delegate`-await);
2. is **triggered by the in-progress state** of the work — the leader
   editing an unread file, a zero-hit grep, a todo/kanban item flipping
   to Running, an error naming an unknown symbol, or an explicit ask;
3. **scans the codebase intensively** — index-first
   (repo-map / search / skeleton / call graphs), then file reads;
4. **feeds findings back asynchronously** — mailbox messages the leader's
   loop folds into context before its next step, plus a structured
   report, in the shape *"this file is here, that component works like
   this"*.

## 2. Why not reuse the existing `explore` role

| | `explore` (exists) | `explore-companion` (proposed) |
|---|---|---|
| Invocation | Manual `delegate({role:'explore'})` | State-triggered; auto-spawned behind the leader |
| Blocking | Yes — leader awaits `TaskResult` | No — fire-and-forget; findings arrive by mail |
| Scope | Whole-codebase map on demand | Narrow probes scoped to the leader's current work |
| Lifecycle | One subagent run per call | Long-lived resident, idle-reaped, auto-respawned |
| Feedback | Final text result | Mailbox `result`/`btw` + `submit_result` structured report |
| Dispatcher | Phase-1 catalog role, routable | Operational role, **not** in the phase catalog |

Different prompt contract, different trigger surface, different
lifecycle → a distinct role id, following the `shadow-agent` precedent
(an operational role registered in `FLEET_ROSTER`, deliberately **outside**
`ALL_AGENT_DEFINITIONS` — see `packages/core/src/coordination/fleet.ts:53`).
Keeping it out of the phase catalog also keeps the 75-definition catalog
count intact (`agent-catalog.test.ts:39`, `ios-smoke.test.ts:202`) and
keeps the free-form dispatcher from routing tasks to it: it is triggered
by state, not by task routing.

## 3. Architecture overview

```
leader agent (main task)
   │  tool.executed / todo.* / task.* / error events  (EventBus, leader-session-filtered)
   ▼
ExploreCompanion (observer, packages/core/src/coordination/explore-companion.ts)
   │  dedupe + cooldown → probe task
   ▼
Resident subagent `explore-companion` (spawned once, spawnBudgetExempt)
   │  read-only + index tools; answers probe
   ▼
mailbox: type=result|btw  →  leader's mailbox loop folds findings into
                             context before its next step  (no new plumbing)
   +  submit_result → SubagentStructuredReport (machine-readable)
```

Three new pieces:

- **A. Role definition** — `explore-companion` SubagentConfig in
  `FLEET_ROSTER` + `FLEET_ROSTER_BUDGETS`, prompt at
  `packages/core/instructions/agents/explore-companion.md`, skills in
  `ROLE_SKILL_SETS` (`role-skills.ts`).
- **B. Trigger layer** — `ExploreCompanion` observer class (shape mirrors
  `brain-monitor.ts`): subscribes to EventBus events filtered to the
  leader session, maps in-progress state → probe tasks, dedupes and
  rate-limits, then assigns probes to the resident (or spawns it).
- **C. Feedback channel** — mailbox `result`/`btw` messages addressed to
  the leader (subject-prefixed `[explore]`), plus `submit_result` with a
  `SubagentStructuredReport`.

## 4. Role definition

### 4.1 Config (`packages/core/src/coordination/fleet.ts`)

```ts
export const EXPLORE_COMPANION_AGENT: SubagentConfig = {
  ...defineAgent('explore-companion', 'Explore Companion'),
  tools: [...TOOLS.read, ...TOOLS.index],           // read + index presets, incl. mailbox
  disabledTools: [
    'write', 'edit', 'replace', 'patch',            // read-only, enforced at tool level
    'bash', 'exec',                                 // no shell
    'delegate', 'spawn_subagent', 'assign_task',    // no nesting, no delegation
  ],
  skillNames: [...ROLE_SKILL_SETS['explore-companion']],
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,           // 10 min idle reap (fleet.ts:141)
  spawnBudgetExempt: true,                          // background traffic must not consume
                                                    // the leader's deliberate-delegation budget
  textStream: 'silent',                             // findings go via mailbox + submit_result,
  toolStream: 'silent',                             // not the stream the leader watches
};
```

`TOOLS.read` already includes `mailbox` (`types.ts:129`), so the resident
can always report back — the same guarantee the git/release roles got.

### 4.2 Budget (`FLEET_ROSTER_BUDGETS`)

Bounded, in the spirit of `shadow-agent` ("bounded, quiet, one-shot"):

```ts
'explore-companion': {
  timeoutMs: 3 * 60 * 60 * 1000,
  maxIterations: 3000,
  maxToolCalls: 8000,
  maxTokens: 96_000,
  maxCostUsd: 0.5,
},
```

### 4.3 Skills (`role-skills.ts`)

```ts
'explore-companion': skillSet('node-modern', 'typescript-strict'),
```

Reading modern TS/Node code correctly is the job; no `research-web` (this
agent explores the repo, not the internet). Both names already exist in
`BUNDLED_AGENT_SKILLS`, so the integrity test in
`tests/coordination/role-skills.test.ts` stays green without additions.

### 4.4 Prompt (`instructions/agents/explore-companion.md`)

Persona: a read-only reconnaissance agent running behind a leader.
Input contract — a probe task:

```json
{
  "probe": "How does Director.spawn() admit a subagent?",
  "hint": { "file": "packages/core/src/coordination/director.ts", "symbol": "spawn" },
  "context": "Leader is adding a new roster role and must not break admission."
}
```

Output contract — findings, not prose:

```markdown
## Findings
- `packages/core/src/coordination/director.ts:77` — `Director.spawn()`:
  resolves roster config, admits against fleet caps, writes the manifest.
  Callers: `delegate-tool.ts`, `fleet-supervisor.ts`. 1 test covers admission.
- `packages/core/src/coordination/fleet.ts:100` — `FLEET_ROSTER`: role →
  config map the spawn path resolves; the new role must be registered here.
- Confidence: 0.9 · Next read: `packages/core/src/coordination/director.ts:180`
```

Rules baked into the prompt:

- Read-only, always; never edit, write, or run shell (tools also enforce).
- Cite `file:line`; never describe code you have not read.
- Index-first: `codebase-repo-map` / `codebase-search` / `codebase-skeleton`
  / `codebase-incoming-calls` / `codebase-outgoing-calls` before
  `read`/`grep`/`glob`/`tree`.
- Stay inside the probe scope; if the probe is ambiguous, state the
  interpretation and answer anyway.
- Keep the mail body compact (leader context is precious): findings table
  + confidence + one "next read" suggestion.
- Always finish with `submit_result` (`SubagentStructuredReport`):
  `summary`, `findings[]`, `files_examined[]`, `confidence`,
  `suggested_next_steps[]`.

## 5. Trigger layer (`ExploreCompanion`)

Mirrors `brain-monitor.ts`'s shape: subscribe to EventBus, filter by the
leader session, maintain per-subject cooldowns, engage one probe at a
time.

### 5.1 State → probe mapping

| Leader in-progress state | Observable signal | Probe produced |
|---|---|---|
| Edits a file it never read | `tool.executed` (edit/write/patch) on a path absent from the leader's read set | "Map file X: role, exports, dependencies, callers" |
| Search/grep returns nothing | `tool.executed` (search/grep) with 0 results | "Locate where concept C / symbol S lives, try synonyms and index refresh" |
| Reads an unfamiliar file | `tool.executed` (read) on a path not yet explored | "Skeleton + callers + dependents of X" |
| Todo / kanban card flips to Running | `todo.*` / task transition event | "Pre-map files/symbols mentioned in the item title/description" |
| Error names an unknown file/symbol | `error` event text | "What is X, where does it live, who uses it" |
| Leader asks explicitly | mailbox `ask`/`assign` to `explore-companion` | "Direct probe" (the manual escape hatch) |

### 5.2 Dedupe and rate limits

- `Map<file|symbol, lastProbeAt>` — a subject is probed again only after
  `cooldownMs` (default 120 000, same default as BrainMonitor).
- One probe in flight at a time; a small pending queue (cap 8, drop
  oldest) so a burst of triggers degrades gracefully instead of stacking
  probes.
- Probes are **assigned, never awaited** — the leader is never blocked.
- Findings land via the mailbox loop, which injects them at the leader's
  next step boundary — the same mechanism BrainMonitor already relies on
  for steers (`brain-monitor.ts` header), so no new plumbing is needed.

### 5.3 Interface sketch

```ts
export interface ExploreCompanionOptions {
  events: EventBus;
  mailbox: Mailbox;
  /** Filter events to the leader's session so subagent activity never
   *  triggers probes (same contract as BrainMonitor.leaderSessionId). */
  leaderSessionId: string | (() => string | undefined);
  /** Assign (or spawn) a probe on the resident. */
  onProbe: (probe: ExploreProbe) => Promise<{ subagentId: string; taskId: string }>;
  // tuning: cooldownMs, maxPending, enabled, signal toggles
}

export class ExploreCompanion {
  start(): void; stop(): void; reconfigure(next: ExploreCompanionTunables): boolean;
}
```

### 5.4 Resident vs per-probe spawn

- **Primary: resident.** One `explore-companion` subagent is spawned when
  the session's director starts (or lazily on first trigger) and waits
  for `assign` messages — generalizing the proven
  `techstack-mailbox-consumer` pattern (`packages/core/src/coordination/
  techstack-mailbox-consumer.ts`). Idle timeout reaps it; the trigger
  layer respawns on the next probe.
- **Fallback: per-probe spawn.** If the resident is busy or reaped, the
  trigger layer spawns a fresh `explore-companion` subagent per probe.
  `spawnBudgetExempt: true` (same as Chimera reviewers) keeps background
  traffic off the leader's deliberate-delegation budget; all other caps
  (depth, fleet cost/tokens) still apply.

## 6. Feedback channel

### 6.1 Mailbox

- `mail_send` to the leader, `type: 'result'` for direct probe answers,
  `type: 'btw'` for ambient/low-urgency context.
- Subject prefix `[explore]` so the leader can recognize and filter.
- Body = the compact findings block from §4.4 (file:line, how the
  component works, confidence, next read).

### 6.2 Structured report

The resident always calls `submit_result` with
`SubagentStructuredReport` (`packages/core/src/types/multi-agent.ts`):
`summary`, `findings[]`, `files_examined[]`, `confidence`,
`suggested_next_steps[]`. The leader can branch on `findings`/`confidence`
programmatically instead of parsing prose.

## 7. Lifecycle and guardrails

- Spawned with the session's director; terminates with the session
  (parent-abort propagates, `aborted_by_parent`).
- Idle-reaped after 10 min with no activity; auto-respawned on the next
  probe.
- **Never blocks the leader** — probes are `spawn`+`assign`, never
  `delegate`.
- **Read-only, triple-enforced**: tool allowlist has no write/bash;
  `disabledTools` excludes them explicitly; default `allowedCapabilities`
  is the read-only safe set (`['fs.read', 'net.outbound']`).
- **No nesting** — `delegate`/`spawn_subagent`/`assign_task` are disabled;
  the companion never spawns its own agents.
- **Not dispatcher-routed** — not in `ALL_AGENT_DEFINITIONS`, so the
  free-form dispatcher classifier never sees it as a candidate; it is
  reachable only through the roster (state trigger or explicit ask).
- Deliberately delegatable as a manual fallback
  (`delegate({role:'explore-companion'})` behaves like a scoped `explore`
  and **does** block — that is the caller's choice, not the default path).

## 8. Files touched (implementation checklist)

All items shipped and verified (coordination test directory: 126 files /
2287 tests green; cli typecheck + host tests green).

1. [x] `packages/core/instructions/agents/explore-companion.md` — new prompt.
2. [x] `packages/core/src/coordination/agents/role-skills.ts` —
   `ROLE_SKILL_SETS['explore-companion']`.
3. [x] `packages/core/src/coordination/fleet.ts` — `EXPLORE_COMPANION_AGENT`
   const + `FLEET_ROSTER` entry + `FLEET_ROSTER_BUDGETS` entry. (Also bumped
   the roster-count assertion in `tests/coordination/agent-catalog.test.ts`
   77 → 78.)
4. [x] `packages/core/src/coordination/explore-companion.ts` — new observer
   (trigger layer; §5).
5. [x] `packages/core/src/coordination/index.ts` — export the new module.
6. [x] Host wiring — `packages/cli/src/fleet/host-explore-companion.ts`
   (builder, mirroring `host-supervisor.ts`) + `host.ts` lifecycle: built in
   `buildDirector()`, stopped in `dispose()`, gated by
   `fleet.exploreCompanion.enabled` (new `FleetConfig` block in
   `packages/core/src/types/config/skills-fleet-brain.ts`). Deviation from
   the original wording: the mailbox consumer is the observer's own poll
   loop (`pollMailbox`), and probes are assigned via `assignInternal` on a
   lazily spawned resident subagent (stable id
   `explore-companion-<sessionTag>`, respawned when reaped).
7. [x] Tests (see §9) — `packages/core/tests/coordination/explore-companion.test.ts`
   (27 tests: trigger mapping, session filtering, cooldown/dedupe,
   non-blocking onProbe, mailbox-ask gating, roster integration).

No changes to `packages/core/src/coordination/agents/phase1-discovery.ts`,
`phase9-meta.ts`, or any phase file — catalog count stays 75.

## 9. Test plan

New `packages/core/tests/coordination/explore-companion.test.ts`
(shape mirrors `brain-monitor` tests: fake EventBus + fake Mailbox):

- **Trigger mapping** — edit-on-unread-file, zero-hit grep, unfamiliar
  read, todo→Running transition, error naming a symbol each produce the
  expected probe; no event → no probe.
- **Session filtering** — subagent-session events never trigger a probe.
- **Dedupe/cooldown** — same subject within `cooldownMs` is skipped;
  queue caps at 8 with drop-oldest.
- **Non-blocking** — `onProbe` resolves without awaiting the resident;
  leader never stalls on the companion.
- **No-write invariant** — the roster config's tool list contains no
  write/edit/bash/exec/delegate; `disabledTools` covers them.
- **Roster integrity** — `FLEET_ROSTER['explore-companion']` resolves,
  budget applies via `applyRosterBudget`, prompt file exists,
  `AGENT_CATALOG` count unchanged at 75.
- **Feedback round trip** — probe → assign → findings mail (`result`)
  + `submit_result` report arrive addressed to the leader.

## 10. Non-goals / out of scope

- Not a permanently running fleet supervisor — that is
  `FleetSupervisor`/`BrainMonitor` territory; this companion only
  **explores and reports**, it never steers, retargets, or terminates.
- No web research (`research-web` deliberately excluded).
- No memory writes / `learned.md` updates — findings are transient
  context for the current task, stored via the structured report only.
- No UI surfaces (WebUI/TUI) in v1 — the mailbox is the whole interface.

## 11. Open questions

1. **Resident spawn timing** — spawn eagerly with the director (always
   warm, costs a bit of budget even when unused) vs lazily on first
   trigger (cheaper, adds first-probe latency)? Default: lazy.
2. **Probe granularity** — file-level probes are cheap and obvious; symbol
   and concept-level probes need the hint/context fields. Start
   file-level + explicit-ask, add symbol-level later.
3. **Should findings also write a scratchpad file** under the shared
   scratchpad path so the leader can re-read them on demand? Nice-to-have;
   mailbox + structured report cover v1.
