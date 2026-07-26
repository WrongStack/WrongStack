---
name: multi-agent
description: |
  Use this skill whenever work can be split across multiple AI agents running in
  parallel, or when orchestrating leader/worker patterns in WrongStack. Trigger
  on the explicit vocabulary — "fan out", "parallel", "delegate", "subagent",
  "fleet", "coordinator", "collab_debug", "swarm", "workers" — but more
  importantly trigger on the SHAPE of the task, because users rarely name the
  pattern: "audit these 40 files", "check every package for X", "run the tests
  across the monorepo", "review this PR and the tests and the docs", "refactor
  these three modules", "scan the codebase for security issues", "find all the
  places that do Y". Any request with a plural target set and repeatable
  per-target work is a fan-out candidate. Also use this skill when a delegated
  run came back with `budget_exhausted`, when worker results need to be
  synthesized into one report, or when deciding whether parallelism is worth it
  at all — talking someone out of fanning out is a valid use of this skill.
version: 2.0.0
---

# Multi-Agent Coordination — WrongStack

## What this is

A leader delegates narrow subtasks to workers, collects structured results, and
synthesizes one unified output. Parallelism buys wall-clock time on work that is
genuinely independent. It costs a multiple of the tokens and it costs
coherence — every worker starts blind, and anything the leader forgets to put in
the brief simply does not exist for that worker.

So the bar is not "could this run in parallel". The bar is "will this finish
meaningfully faster or better in parallel, given that I have to write N briefs
and reconcile N results".

**"It won't fit in one context" is no longer a reason to fan out.** With windows
running from 200K to 1M, work that used to require splitting now loads
comfortably into a single agent — and a single agent that sees everything
produces better cross-cutting analysis than five that each see a fifth. Fan out
for wall-clock time and for genuinely independent attention. Do not fan out
because of a size limit you last measured on a smaller model; check whether the
whole thing simply fits first.

---

## The decision gate

Walk these in order. A single **no** means do the work in one agent.

1. **Plural targets?** More than one file, package, module, or question. A single
   atomic task is not a fleet.
2. **Independent?** Can target B be worked on without target A's output? If there
   is a sequential dependency, either chain it inside one agent or use the fleet
   pattern with explicit hand-off — do not one-shot fan it out.
3. **≥5 tool calls per subtask?** Below that, spawn overhead exceeds the benefit.
   Read three small files yourself.
4. **No shared mutable state?** Subagents share nothing — no memory, no session
   state, no variable scope. Work that needs a common scratchpad stays local.
5. **Can each subtask be described in a paragraph?** If a target needs three
   pages of context to explain, the leader is the one who understands it. Keep it.

✅ Good fits
- "Audit these 50 files for X" — one worker per chunk of 5–10 files
- "Run tests in all 12 packages" — parallel `pnpm test` per package
- "Refactor 3 independent modules" — one worker each
- "Review this PR + check the tests + check the docs" — three parallel workers

❌ Avoid
- Single atomic task under 5 tool calls — overhead exceeds benefit
- Tasks requiring shared state — subagents have isolated contexts
- Long sequential dependencies — chain within one agent, don't fan out
- Exploratory work where the next step depends on what the last step found

---

## Sizing the fleet

- **Chunk by target, not by worker count.** 50 files → 5–10 workers of 5–10 files
  each. Not 50 workers, and not 2 workers of 25.
- **Practical ceiling per turn scales with the leader's window** — roughly 10
  workers at 200K, up to ~25 at 1M. The limit is not whether the results fit; it
  is that synthesis quality falls off well before the context does. Twenty-five
  reports is already more than one pass can reconcile carefully. For larger sets,
  run sequential waves and synthesize incrementally between them.
- **Uniform chunks.** One worker with 30 files and four with 2 means the fleet
  finishes when the slow one does, and the big one is the one that exhausts.
- **Same role per wave where possible.** Mixed roles in one batch are fine, but
  mixed *scopes* make the results hard to reconcile.

---

## Writing the task brief

This is where fan-outs succeed or fail. The worker sees the brief and nothing
else — not the conversation, not the leader's plan, not what sibling workers are
doing. Assume total amnesia.

Every brief carries five things:

1. **Exact scope** — literal paths or globs, never "the auth code"
2. **The specific question** — what to look for, not "review this"
3. **Definition of done** — what makes the subtask complete
4. **Return format** — what fields the leader needs back for aggregation
5. **Boundaries** — what NOT to touch, especially whether to edit or only report

```typescript
// ✅ Good — narrow, focused, self-contained
batch_tool_use([
  { tool: "delegate", input: { task: "Audit auth/session.ts for null-deref bugs. Report each as file:line + severity (critical/high/medium/low) + one-line fix. Do not edit files.", role: "bug-hunter" }},
  { tool: "delegate", input: { task: "Audit auth/token.ts for null-deref bugs. Report each as file:line + severity + one-line fix. Do not edit files.", role: "bug-hunter" }},
  { tool: "delegate", input: { task: "Audit auth/refresh.ts for null-deref bugs. Report each as file:line + severity + one-line fix. Do not edit files.", role: "bug-hunter" }},
])

// ❌ Too broad — will exhaust budget
{ task: "Audit all packages for bugs" }

// ❌ No scope, no format — results won't aggregate
{ task: "Look at the auth stuff and tell me if it's ok", role: "bug-hunter" }

// ❌ Role mismatch
{ task: "Write documentation for the API", role: "bug-hunter" }
```

Asking every worker for the **same** result shape is what makes deduplication
and prioritization possible later. Decide the shape before dispatching.

### Passing artifacts between workers

Subagents share nothing, so if worker B needs worker A's output the leader must
move it: either inline it in B's task description, or have A write to a file and
give B the path. There is no third option — no implicit inheritance, no shared
scope.

---

## Roles

| Role | Responsibility | Tools |
|------|---------------|-------|
| **Leader** | Coordinates, delegates, synthesizes | `delegate`, `plan`, `read` |
| **Worker** | Executes a narrow subtask | Any needed tools |
| **Reviewer** | Validates worker output, approves/rejects | `grep`, `test`, `read` |
| **Architect** | Makes design decisions when workers hit ambiguity | `read`, `glob`, `grep` |

Match the role to the task. A `bug-hunter` writing docs, or a `refactor-planner`
running a security audit, produces confident output shaped by the wrong
priorities — which is worse than no output, because it reads as authoritative.

---

## Execution patterns

### One-shot fan-out — all workers in one turn

Use when subtasks are fully independent.

```typescript
batch_tool_use([
  { tool: "delegate", input: { task: "...", role: "bug-hunter" }},
  { tool: "delegate", input: { task: "...", role: "bug-hunter" }},
  { tool: "delegate", input: { task: "...", role: "bug-hunter" }},
])
```

Dispatch the whole batch in a single turn. Firing them one at a time serializes
the fleet and throws away the only thing parallelism was for.

### Fleet pattern — stateful, multiple turns

Use when there are dependencies: worker 2 needs worker 1's artifact.

```
delegate → spawn N subagents → assign_task per subagent → await_tasks
```

Keep the dependency chain shallow. A four-deep chain of workers is a sequential
program with extra failure modes; write it as one agent instead.

---

## Reading results

Check `stopReason` on **every** result — never assume a worker finished.

| `stopReason` | Meaning | Leader's move |
|---|---|---|
| `end_turn` | Clean finish | Read `result`, fold into synthesis |
| `budget_exhausted` | Task too broad | Keep partial output, re-split, retry |
| `error` | Infrastructure issue | Surface to the user — don't silently absorb |
| `aborted` | User cancelled | Do not retry |

### Retry policy for `budget_exhausted`

Re-running the identical task produces the identical exhaustion. Split it:

1. Salvage whatever partial findings came back — partial results are still results.
2. Halve the scope (10 files → two workers of 5) and re-dispatch.
3. Cap at one re-split per subtask. If a half-sized chunk also exhausts, the task
   shape is wrong — stop, and tell the user what is not getting covered and why.

### Trust but verify

Workers report their own success. Before folding a result into the synthesis,
sanity-check it: does a claimed `file:line` exist, did the test command actually
run, does a "no issues found" on a 400-line file look plausible? Spot-check a
sample rather than every claim — but never zero.

---

## Aggregation and synthesis

Raw worker output pasted end-to-end is not a report; it is a pile. The leader's
whole value is what happens next:

```
For each worker result:
  - Extract key findings (don't just paste raw output)
  - Deduplicate (multiple workers may find the same issue)
  - Prioritize: critical > high > medium > low
  - Present as unified report
```

Then two things the pile can't tell you:

- **Cross-target patterns.** The same bug in six files is one systemic finding,
  not six tickets. Say so — that's the insight only the leader is positioned to have.
- **Coverage.** Report what was *not* covered. A synthesis built on 7 of 10
  workers is a partial audit, and presenting it as complete is the single most
  damaging failure mode in this skill — the user stops looking at the files
  nobody actually read.

### Leader output format

```
## Synthesis Report — <task>

### Coverage
<N>/<M> targets completed. Failed/skipped: <list with reason, or "none">

### Summary
[Unified summary of all findings]

### Unified Next Steps
[Deduplicated and prioritized action items]

<nextsteps>
1. Fix critical issue in <file:line>
2. Fix high-priority issue in <file:line>
3. Fix remaining issue in <file:line>
</nextsteps>
```

Omit the Coverage block only when every worker returned `end_turn`.

---

## Anti-patterns

- **Over-delegation** — 50 subagents in one turn; leader context explodes, nothing lands
- **Under-delegation** — one agent doing everything; defeats the purpose, burns budget
- **Role mismatch** — `bug-hunter` writing docs, `refactor-planner` doing security
- **Result loss** — workers return useful data, leader never aggregates `result`
- **Silent failure** — `budget_exhausted` output ignored; partial results are still results
- **Phantom coverage** — reporting a clean audit when a third of the fleet died
- **Serialized fan-out** — dispatching independent workers one turn at a time
- **Brief-by-reference** — "audit the file we discussed"; the worker has no idea what that means

---

## collab_debug — Three-Agent Parallel Code Review

`collab_debug` runs **BugHunter + RefactorPlanner + Critic** simultaneously on the
same file snapshot. All three agents receive the full target context, so the
number of files must be kept small.

Overlap here is intentional: the three roles are meant to disagree, and the
Critic exists to challenge the other two. When deduplicating, keep the
disagreement visible instead of collapsing it into one line — a finding all three
flag and a finding one flags while another disputes are different signals.

### Target size limit: dynamic, defaults to 30

The file limit is computed in this priority order:

1. **`maxTargetFiles`** — explicit override if provided
2. **`contextWindow`** — dynamic calculation: `floor((contextWindow × 0.4) / 2000)`
3. **`DEFAULT_MAX_TARGET_FILES = 30`** — fallback when neither is set

Each of the three agents gets the entire file snapshot as context. With
3 agents × N files, large targets cause:
- **Token overflow** — context window exhausted
- **Timeout failures** — session times out before agents finish
- **Budget exhaustion** — each agent burns through iterations with no progress

| contextWindow (tokens) | Calculated limit | Practical range | Interpretation |
|---|---|---|---|
| 1_000_000 | 200 files | 40–60 | ⚠️ Fits, but review quality decays long before this |
| 500_000 | 100 files | 30–50 | ⚠️ Split by module rather than running one huge pass |
| 400_000 | 80 files | 25–40 | ✅ Roomy |
| 200_000 | 40 files | 20–30 | ✅ Comfortable |
| 100_000 | 20 files | 15–20 | ✅ Comfortable |
| 32_768 | 6 files | 4–6 | ⚠️ Very limited |
| not provided | 30 files (default) | — | Safe baseline, ignores the real window |

The session throws a clear error if the resolved file count exceeds the effective
limit. Treat the calculated limit as a hard cap and the practical range as the
actual target — a run at exactly the limit tends to time out rather than fail
cleanly.

**The gap between the two columns widens as windows grow, and that is the point.**
The formula answers "does this fit", which stopped being the binding constraint
once windows passed a few hundred thousand tokens. What binds now is attention
and wall-clock: three agents each holding 200 files will fit the tokens fine and
still produce a shallower review than three agents holding 50, because per-file
scrutiny drops as the snapshot grows and the session runs long enough to hit
timeouts. Fitting is not the same as reviewing.

**On a large-window model, pass `contextWindow` explicitly.** Omitting it falls
back to `DEFAULT_MAX_TARGET_FILES = 30` — a floor set for the old 100–200K era,
which now silently caps a 1M-token session at a fraction of what it could handle.
The default is safe, not correct.

### Correct usage

```js
// ✅ Good — single package, limited files
collab_debug(["packages/core/src/agents/**/*.ts"])

// ✅ Explicit — override limit directly
collab_debug({
  targetPaths: ["packages/core/src/**/*.ts"],
  maxTargetFiles: 15,
})

// ✅ Dynamic — limit computed from contextWindow
collab_debug({
  targetPaths: ["packages/core/src/**/*.ts"],
  contextWindow: 100_000,  // → limit = floor(100000 * 0.4 / 2000) = 20
})

// ❌ Bad — entire monorepo
collab_debug(["packages/**/src/**/*.ts"])
```

### For large codebases

Run **package-by-package** or **module-by-module** sessions. Target only the area
under review, not the whole repo. Sequential scoped sessions beat one oversized
session that dies halfway — and they let you synthesize as you go.

---

## Skills in scope

- `bug-hunter` — parallel file audits
- `security-scanner` — parallel security scans
- `refactor-planner` — parallel module analysis
- `audit-log` — aggregating multiple session analyses
- `output-standards` — standardized `<nextsteps>` formatting

---

## Before reporting back

- Every `stopReason` checked, none assumed
- Failed or exhausted workers either retried once or reported as coverage gaps
- Findings deduplicated, cross-target patterns called out as systemic
- Prioritized critical → low, not left in worker-arrival order
- A sample of worker claims spot-checked against the actual code
- Report presents synthesis, not concatenation