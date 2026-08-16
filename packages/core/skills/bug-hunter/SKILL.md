---
name: bug-hunter
description: |
  Use this skill when scanning source code for bugs, anti-patterns, code smells,
  or quality issues in a WrongStack project. Trigger on the explicit vocabulary —
  "bug", "bug hunt", "scan for issues", "find problems", "anti-pattern", "code
  smell", "static analysis" — and on the task shape, which is how it usually
  arrives: "why does this crash", "audit these files", "is this safe to merge",
  "check for leaks", "something's wrong in X", "look for anything dangerous
  here", "clean pass before release". Also use it when running as a cascade
  agent behind a chimera review, or as a fan-out worker auditing a chunk of
  files in parallel — those modes have extra constraints documented below.
version: 2.0.0
required-capabilities: [filesystem.read, code.inspect]
required-tools: []
optional-capabilities: [verification.run]
---

# Bug Hunter — WrongStack

Scans code for bugs and code smells. Outputs a prioritized hit list with
file:line references.

## Overview

Grep/read across target files to surface bugs, anti-patterns, and quality
issues. Classifies by severity (critical/high/medium/low) and reports with
file:line + fix suggestion.

## Rules

1. Always include a `file:line` you have actually read — verify the line exists;
   never invent, guess, or extrapolate a reference. No line reference = can't be
   fixed.
2. Never scan `node_modules` — waste of time, false positives.
3. Don't report style issues as bugs — those are lint findings.
4. If >30% of findings are noise, note the false positive rate in the report.
5. Don't flag deprecated APIs without severity — some deprecations are acceptable.
6. Sort output: critical > high > medium > low.

## Workflow

```
1. Scope:   Accept file/dir globs or explicit paths
2. Scan:    grep/read across target files
3. Verify:  Open each hit and confirm it's real — grep finds candidates, not bugs
4. Classify: Categorize by type and severity
5. Rank:    Sort: critical > high > medium > low
6. Report:  Markdown with fix suggestions
```

### Grep finds candidates; reading finds bugs

This is the single discipline that separates a useful report from a noisy one. A
regex hit is a **place to look**, never a finding. Before any hit becomes a line
in the report, open it and answer three questions:

1. **Is the dangerous value actually attacker- or user-controlled?**
   `element.innerHTML = "<b>Loading</b>"` is not XSS.
2. **Is the path reachable?** Dead code, unexported helpers with no callers, and
   branches behind a permanently-false flag are at most Low.
3. **Is it already handled nearby?** A `.then()` three lines above a
   `.catch()` chained further down, a validated input, an outer try/catch — read
   enough surrounding lines to know.

If you cannot state the input that triggers it and what breaks, it is not a
finding. Drop it.

### Exclude before you scan

Scanning these produces noise at a rate that swamps the real signal:

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
| **Low** | Style, minor code smell | Consider fixing |

Two adjustments that keep severity honest:

- **Reachability discounts it.** The same `as any` is Medium at a network
  boundary and Low in an internal helper that only ever receives typed input.
- **Blast radius promotes it.** A bug in one leaf component is what it is; the
  same bug in a shared util imported by forty modules is a level higher.

When torn between two levels, pick the lower one. Under-calling still gets the
finding read; over-calling costs the reader's trust in every other line.

---

## Patterns

### Do

```typescript
// ✅ FIXED — use textContent instead of innerHTML
element.textContent = userInput;

// ✅ FIXED — parameterized query
db.query("SELECT * FROM users WHERE id = $1", [userId]);

// ✅ FIXED — proper await with catch
await fetchData().catch(err => console.error(err));

// ✅ FIXED — execFile with args array
execFile('echo', [userInput], { signal: AbortSignal.timeout(5000) });
```

### Don't

```typescript
// ❌ CRITICAL — hardcoded API key
const apiKey = "sk-abc123xyz789...";

// ❌ HIGH — innerHTML XSS
element.innerHTML = userInput;

// ❌ HIGH — unhandled promise (then without catch)
fetchData().then(processData);

// ❌ HIGH — shell injection
exec(`echo ${userInput}`);

// ❌ HIGH — unsafe any
const data: any = response.json();
```

### Bug patterns to find

Regex column = **where to start grepping**. Confirm column = what must be true
in the actual code before it becomes a finding.

| Pattern | Regex hint | Confirm by reading | Severity |
|---------|------------|--------------------|----------|
| Uncaught promise | `\.then\(` without `.catch` | No `.catch` on the chain and no enclosing try/catch on an awaited call | high |
| Event listener leak | `\.on\(`, `addEventListener`, `setInterval`, `subscribe` | No matching `off`/`removeListener`/`clearInterval`/`unsubscribe` in teardown, and the owner outlives the handler | high |
| Hardcoded secret | `sk-`, `AKIA`, `-----BEGIN`, `api[_-]?key\s*=`, or `[A-Za-z0-9/+=]{40}` | It's a live credential, not a hash, base64 blob, integrity digest, or test fixture | critical |
| unsafe any | `:\s*any\b` or `as any` | Sits at a trust boundary (parsed JSON, network, DB, user input) rather than internal glue | medium |
| innerHTML assignment | `innerHTML\s*=`, `dangerouslySetInnerHTML` | Right-hand side is user-controlled and not sanitized | high |
| Missing await | `\.(then\|catch)\(` absent on a call to a known-async fn; float-promise lint hits | The call has side effects whose ordering or failure matters | high |
| No rejection safety net | absence of `process.on('unhandledRejection'` in the entry point | It's an actual entry point (server/CLI main), not a library module | medium |
| SQL concatenation | `"SELECT .*" \+`, backtick SQL with `${` | Interpolated value is not a parameterized placeholder | critical |
| Shell injection | `exec(`, `execSync(` with `${` | Interpolated value can carry user input | critical |
| Unbounded resource | `while (true)`, recursion without a base case, unpaginated fetch-all | No break condition, timeout, or limit on a path that can grow | high |
| Swallowed error | `catch {}`, `catch (e) {}`, `.catch(() => {})` | The failure it hides is meaningful rather than genuinely ignorable | medium |

Extend this table when a scan turns up a pattern worth watching for — but only
with rows that pass the same test: a grep that narrows the search plus a
condition that decides it.

---

## Anti-patterns

- **Don't scan `node_modules`** — waste of time, false positives
- **Don't report without file:line** — useless for fixing
- **Don't ignore false positive rate** — if >30% of findings are noise, note it
- **Don't report style issues as bugs** — those are lint findings
- **Don't flag deprecated without severity** — some deprecations are fine
- **Don't report grep output as findings** — every hit gets read before it ships
- **Don't flag test fixtures as leaked secrets** — mock credentials belong there
- **Don't pad the report** — twelve confirmed findings beat forty maybes, and a
  clean scan is a valid result
- **Don't inflate severity** to make the scan look productive

---

## Output format

```
## Bug Hunt Report — <scope>

### Critical (must fix)
1. [SHELL-INJ] `tools/shell.ts:42` — template literal in exec()
   `exec(\`echo ${userInput}\`)` → use execFile with args array
2. [SECRET] `lib/config.ts:8` — API key hardcoded

### High
3. [MEMORY] `tools/pool.ts:89` — event listener never removed
4. [TYPE] `core/agent.ts:103` — unsafe `any` cast

### Summary
| Severity | Count |
|----------|-------|
| Critical | 2 |
| High     | 4 |
| Medium   | 7 |
| Low      | 3 |

Total: 16 findings in 12 files

<nextsteps>
1. Fix the shell injection in tools/shell.ts:42
2. Fix the hardcoded API key in lib/config.ts:8
3. Fix the memory leak in tools/pool.ts:89
4. Fix the unsafe any cast in core/agent.ts:103
</nextsteps>
```

When the false positive rate exceeds 30% (rule 4), add one line under Summary:
`False positive rate: ~N% — <one-line cause, e.g. "base64 asset blobs matched
the secret pattern">`. Naming the cause is what lets the next scan tighten the
pattern.

If a scan turns up nothing, say so plainly with the scope and file count. A
clean report on a small, careful diff is the expected outcome, not a miss.

---

## Running modes

The same skill is invoked three ways, and the constraints differ.

### 1. Standalone scan (default)

As documented above. Report only; suggest fixes, don't apply them, unless the
user asked for fixes.

### 2. Fan-out worker

Dispatched by a leader across a chunk of files (typically 5–10 per worker).

- Stay inside the assigned paths. Scope creep breaks the leader's coverage math.
- Return the **same result shape** every sibling worker returns, so findings
  deduplicate cleanly — severity, `file:line`, one-line fix.
- Duplicate findings across workers are expected; the leader dedupes. Report
  yours regardless.
- If the chunk is too large to finish, report what you confirmed and state
  clearly which files you did not reach. Silent partial coverage is the failure
  mode that matters here.

### 3. Cascade agent (behind a chimera review)

The runtime spawns bug-hunter automatically when a chimera review contains
findings at or above `cascadeOn`. In this mode:

- You receive the review report and the list of changed files as your task.
- You **investigate each finding, read the flagged files, and apply fixes** —
  this is the one mode where bug-hunter mutates code.
- Results are appended **directly to the session transcript**. That is the
  canonical delivery path.
- **NEVER send mailbox messages** to the leader. No progress updates, no
  intermediate results.
- You participate in the re-review loop, up to `maxCascadeDepth` cycles.

When applying fixes in cascade mode:

- **Minimal diff.** Fix the flagged defect and nothing else. A refactor smuggled
  into a fix commit is how a cascade turns into an incident.
- **Verify the line first.** A chimera finding is a strong lead, not a warrant —
  if the cited line doesn't say what the report claims, report the discrepancy
  instead of editing something adjacent that looks close enough.
- **Don't fix what you can't check.** If the correct fix needs a design decision
  or would change a public contract, leave it and say why.
- **List what you didn't fix** and the reason. A cascade that silently skips
  three of five findings leaves everyone believing they're resolved.

---

## Large scans

When the target set is bigger than roughly 10–15 files, don't grind through it
in one pass — hand it to the `multi-agent` fan-out pattern: one worker per chunk
of 5–10 files, uniform result shape, leader synthesizes. Read that skill for
sizing and briefing rules before dispatching.

---

## Out of scope

- **Don't fix the bugs you find in default mode.** Standalone scans produce a report only. Apply fixes only when the user explicitly asks, or when the runtime dispatches you as a cascade agent behind chimera.
- **Don't review code quality, design, or style.** Wrong file, wrong skill. Quality and design are `chimera`'s read-only lane; style is the linter's job. Hand off to `chimera` for read-only quality review, or to `refactor-planner` for multi-file restructuring.
- **Don't run dependency audits or scan `node_modules`.** Supply chain and lockfile scanning are `security-scanner`'s lane. Hand off cleanly.
- **Don't write tests for the bugs you find.** Test authoring is `testing`'s lane. State the failing test that would catch the bug; don't write it.
- **Don't start a `multi-agent` fan-out on your own.** The leader decides when fan-out is the right tool. Report the size of the target; let the leader dispatch.

## Skills in scope

- `security-scanner` — for hardcoded secrets and injection vectors
- `refactor-planner` — for fixing findings across multiple files
- `typescript-strict` — for TypeScript type safety rules
- `output-standards` — for standardized `<nextsteps>` formatting
- `multi-agent` — for fanning out scans across large targets

---

## Before returning the report

- Every `file:line` opened and confirmed — none from grep output alone
- Every finding states a triggering input and a consequence
- Excluded paths honored; no `node_modules`, no build output, no lockfiles
- Test-file findings labeled as such; no fixture secrets reported
- Severities pass the reachability and blast-radius checks; nothing rounded up
- False positive rate noted with a cause if it exceeds 30%
- Summary counts match the findings listed
- `<nextsteps>` mirrors the findings in severity order
- In cascade mode: fixes are minimal, unfixed findings are listed with reasons,
  and no mailbox message was sent
