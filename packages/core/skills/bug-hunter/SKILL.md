---
name: bug-hunter
description: |
  Use this skill when scanning source code for bugs, anti-patterns, code smells,
  or quality issues in a codebase, or when running a proof-driven bug hunt that
  must find, prove, fix, and verify one real defect. Trigger on the explicit
  vocabulary — "bug", "bug hunt", "/bughunt", "scan for issues", "find
  problems", "anti-pattern", "code smell", "static analysis" — and on the task
  shape, which is how it usually arrives: "audit these files", "scan this
  module", "check for leaks", "something's wrong in X", "look for anything
  dangerous here", "clean pass before release". Also use it when running as a
  cascade agent behind a chimera review, or as a fan-out worker auditing a chunk
  of files in parallel — those modes have extra constraints documented below.
version: 2.2.1
required-capabilities: [filesystem.read, code.inspect]
required-tools: []
optional-capabilities: [verification.run]
trigger: "Use this skill when scanning source code for bugs, anti-patterns, code smells, or quality issues in a codebase, or when running a proof-driven bug hunt that must find, prove, fix, and verify one real defect. Trigger on the explicit vocabulary \u2014 \"bug\", \"bug hunt\", \"/bughunt\", \"scan for issues\", \"find problems\", \"anti-pattern\", \"code smell\", \"static analysis\" \u2014 and on the task shape, which is how it usually arrives: \"audit these files\", \"scan this module\", \"check for leaks\", \"something's wrong in X\", \"look for anything dangerous here\", \"clean pass before release\". Also use it when running as a cascade agent behind a chimera review, or as a fan-out worker auditing a chunk of files in parallel \u2014 those modes have extra constraints documented below."
metadata:
  routing-group: quality
---

# Bug Hunter

Finds real defects in code. In a scan it outputs a prioritized hit list with
file:line references; in a proof-driven round it selects the one candidate it
can prove, and hands it to the proof, fix, and verification discipline.

## Selection card
- Task: Run the WrongStack bug-hunt and cascade workflow.
- Start: Identify the scope and obtain an executable before-proof or review evidence.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Rules

1. Always include a `file:line` you have actually read — verify the line exists;
   never invent, guess, or extrapolate a reference. No line reference = can't be
   fixed.
2. Grep finds candidates; reading finds bugs. No hit becomes a finding until you
   can state the input that triggers it and what breaks.
3. Never scan `node_modules`, build output, or generated code.
4. Don't report style issues as bugs — those are lint findings.
5. Don't inflate severity or pad the report. Twelve confirmed findings beat
   forty maybes, and a clean scan is a valid result.
6. Sort output: critical > high > medium > low.

## Workflow

```
1. Scope:    Accept file/dir globs, explicit paths, a feature, or a symptom
2. Map:      Entry points, callers, and the contract the code must honour
3. Scan:     grep/read across target files, lifecycle and async paths first
4. Confirm:  Open each hit and answer the three questions below
5. Classify: Categorize by type and severity
6. Deliver:  Report (scan modes) or select one candidate (proof-driven mode)
```

### Confirm every candidate

A regex hit is a **place to look**, never a finding. Before any hit becomes a
line in the report, open it and answer three questions:

1. **Is the triggering value actually reachable from a caller, user, or
   environment?** `element.innerHTML = "<b>Loading</b>"` is not XSS.
2. **Is the path reachable?** Dead code, unexported helpers with no callers, and
   branches behind a permanently-false flag are at most Low.
3. **Is it already handled nearby?** A `.catch()` chained further down, a
   validated input, an outer try/catch, a cleanup in the owner's teardown —
   read enough surrounding lines to know.

Also establish **what correct behaviour is and why**: a documented contract, a
caller's requirement, or an established test. A deliberate tradeoff or a
stylistic preference is not a bug, however it looks.

### Start from the index and scanners when they exist

When the codebase index and quality tools are available, let them narrow the
search and grep for the rest:

- the security-ast-scan tool for injection, hardcoded secrets, prototype
  pollution, ReDoS, unsafe eval, and N+1 queries in a file;
- the dead-code-scan tool for unreferenced exports (candidates only — dynamic
  imports and config-driven registration are invisible to it);
- the codebase-incoming-calls tool to confirm a suspicious function is
  reachable and to see how many callers inherit the defect.

Tool output is a candidate list like any grep hit: every finding is read
before it ships.

### Exclude before you scan

`node_modules`, `dist`, `build`, `.next`, `out`, `coverage`, lockfiles,
`*.min.*`, generated clients and protobufs, snapshots (`__snapshots__`),
vendored third-party directories, and `.git`.

**Test files and fixtures are a special case.** Do not scan them for secrets —
mock credentials are expected there. Do still scan them for leaks and unawaited
promises, since those cause real flakiness. When a finding lands in a test file,
say so in the finding.

---

## Severity levels

| Level | Meaning | Action |
|-------|---------|--------|
| **Critical** | Security breach, data loss, crash | Fix immediately |
| **High** | Logic bug, race condition, memory leak | Fix before release |
| **Medium** | Error handling gap, type unsafety | Fix soon |
| **Low** | Minor code smell with a real consequence | Consider fixing |

- **Reachability discounts it.** The same `as any` is Medium at a network
  boundary and Low in an internal helper that only ever receives typed input.
- **Blast radius promotes it.** A bug in one leaf component is what it is; the
  same bug in a shared util imported by forty modules is a level higher.

When torn between two levels, pick the lower one. Over-calling costs the
reader's trust in every other line.

---

## Patterns and report

For scanning patterns, severity-ranked report examples and output shape, [Read the detailed workflow](references/patterns-and-report.md).

## Running modes

- Standalone scan: report confirmed source findings; no production edits.
- Fan-out worker: honor its assigned scope and return evidence to the coordinator.
- Cascade: revalidate the supplied finding before applying its authorized fix.
- Proof-driven /bughunt: one proven root cause, no fan-out, deterministic proof,
  narrow fix and regression verification; follow the round's output contract.

Before operating in a worker, cascade or proof-driven mode, read
[the complete mode protocol](references/running-modes.md).

## Anti-patterns

- **Reporting grep output as findings** — every hit is read before it ships
- **Flagging test fixtures as leaked secrets** — mock credentials belong there
- **Inflating severity** to make the scan look productive
- **Proof-driven: fixing before the proof is red**, or picking the most
  dramatic candidate over the most provable one
- **Proof-driven: re-reporting a prior round's root cause** under a new symptom

## Out of scope (scan modes)

- **Don't fix the bugs you find in the default scan.** Apply fixes only when
  the user explicitly asks, in cascade mode, or in a proof-driven round.
- **Don't review code quality, design, or style.** Quality and design are
  `chimera`'s read-only lane; style is the linter's job. Multi-file
  restructuring is `refactor-planner`'s.
- **Don't run dependency audits.** Supply chain and lockfile scanning are
  `security-scanner`'s lane.
- **Don't write tests in a scan.** State the failing test that would catch the
  bug; test authoring is `testing`'s lane outside proof-driven rounds.
- **Don't start a `multi-agent` fan-out on your own.** For a target larger than
  roughly 10–15 files, report its size and let the leader dispatch.

## Candidate status and coverage

Keep observed failures, supported source concerns and disproven candidates
distinct. Name the inspected paths and uncovered runtime branches; no findings
in a subset is not a release certificate. When the user requests continued rounds
or independent scope selection, honor that authorization and choose the next
narrow scope without repeatedly asking for the same decision.

## Skills in scope

- `debugging` — for the reproduction and root cause once a candidate is chosen
- `testing` — for the proof and the durable regression test
- `verify-before-done` — for the final evidence and report
- `code-review` — for reviewing a specific change set
- `security-scanner` — for hardcoded secrets and injection vectors
- `refactor-planner` — for fixing findings across multiple files
- `typescript-strict` — for TypeScript type safety rules
- `output-standards` — for standardized `<nextsteps>` formatting
- `multi-agent` — for fanning out scans across large targets (never in a
  proof-driven round)

---

## Before returning

- Every `file:line` opened and confirmed — none from grep output alone
- Every finding states a triggering input, a consequence, and the basis for the
  expected behaviour
- Excluded paths honoured; test-file findings labelled as such
- Severities pass the reachability and blast-radius checks; nothing rounded up
- Scan: summary counts match the findings; `<nextsteps>` mirrors them in order
- Cascade: fixes are minimal, unfixed findings listed with reasons, no mailbox
  message sent
- Proof-driven: one root cause, not a duplicate of a prior round; the choice,
  rejected candidates, and coverage gaps are in the report
