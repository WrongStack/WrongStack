---
name: evidence-audit
description: Evidence-led audit/fix rounds for any codebase in any language. Finds only defects that a runnable proof reproduces on current code, applies the narrowest in-scope patch, verifies with a second proof, promotes high-risk proofs to permanent regression tests, and reports exact validation results. Use whenever the user asks to audit, bug-hunt, "find real bugs in", "prove and fix", "continue the audit round on", or "what is actually broken in" a package, module, directory, or service, even without the word "audit", and for turning .temp_files proof scripts into regression tests. Do not use for a single already-reported bug, an unscoped security claim, or general refactoring.
required-capabilities: [filesystem.read, filesystem.write, execution.shell, verification.run, version-control.manage]
required-tools: []
trigger: "description: Evidence-led audit/fix rounds for any codebase in any language. Finds only defects that a runnable proof reproduces on current code, applies the narrowest in-scope patch, verifies with a second proof, promotes high-risk proofs to permanent regression tests, and reports exact validation results. Use whenever the user asks to audit, bug-hunt, \"find real bugs in\", \"prove and fix\", \"continue the audit round on\", or \"what is actually broken in\" a package, module, directory, or service, even without the word \"audit\", and for turning .temp_files proof scripts into regression tests. Do not use for a single already-reported bug, an unscoped security claim, or general refactoring."
version: 1.1.1
metadata:
  routing-group: quality
---

# Evidence-led audit

Invoke as `$evidence-audit <scope>`. The text after the skill name is the scope. Every round produces the same thing: a ledger of findings where each finding has a proof that fails on current code, a patch that touches only the scope, and a verifier that passes after the patch. Nothing without a proof becomes a patch. Nothing without a verifier is called fixed. This holds in every language and every repo: an unproven "improvement" is a regression risk with no upside.

## Selection card
- Task: Find, prove, fix and independently verify real defects.
- Start: Identify the scope and obtain an executable before-proof or review evidence.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Setup (every round, before any analysis)

1. Read the repo's agent instructions if present (`AGENTS.md`, `CONTRIBUTING.md`, or equivalent at the root and in the scope). Run `git status --short` and record the output: these are pre-existing changes you must preserve and never touch.
2. Detect the toolchain from the repo, not from assumptions. Record, with the file that proves each: language(s) and version, package/build tool, test runner and how the project invokes it, type checker (if any), formatter/linter, and whether a race detector, sanitizer, or coverage tool is already configured. Use only what is already there. Do not install a test framework, mutation tool, or linter.
3. Resolve the scope. A scope is concrete when it maps to specific files. If the prompt gives none, or it is vague ("the backend", "everything"):
   - Do a shallow structural scan only: directory layout, entry points, modules with thin or no tests, recent churn from `git log --stat -20`. Do not read implementations in depth yet.
   - List 5–8 numbered candidate scopes, each with path(s), one line on what it does, and one line on why it is risky (concurrency, I/O, error handling, no tests, recent churn, many callers).
   - Ask the user to pick a number or give a path, print `Awaiting scope.`, and stop. Do not choose for them.
4. Print `Scope confirmed: <paths>`. Everything you patch must be inside it. Files outside may be read for callers, types, and configs only.
5. If `.temp_files/ledger_<scope-slug>.md` already exists, this is a continued round: read it, keep its IDs, start new findings from the next free ID. Never renumber.
6. Read the scope's source and its nearest tests before forming any candidate. Write down the invariants the code is supposed to keep: what must be true after each await/yield/callback, who owns each resource, what state a caller may observe mid-operation, which inputs are trusted. Real defects are violations of invariants the author assumed but never checked.

## Procedure

### 1. Candidate → proof

Keep the ledger at `.temp_files/ledger_<scope-slug>.md`. All proofs live in `.temp_files/` at the repo root (create it if needed) and are written in the project's own language using its own runner or a plain executable in that language. For each candidate defect:

- Write `.temp_files/prove_F<ID>_<slug>.<ext>`. It must run against current, unmodified code and contain:
  - the failing case, printing `EXPECTED:` and `ACTUAL:` side by side and ending with `PROBLEM CONFIRMED` + non-zero exit;
  - an **unaffected control**: a nearby input that behaves correctly, so the proof shows the defect is specific and not an environment artifact.
  - For a performance claim: a fixed input size, enough repetitions to be stable, printed numbers, and a stated baseline for what "acceptable" means. A timing without a baseline is not a finding.
- Run it. Paste the output into the ledger. If it does not reproduce, the candidate is **dropped**: record it under "Not reproduced" in one line and move on. Do not keep it as a hunch.
- Classify each confirmed finding: `bug` / `perf` / `resource-leak` / `race` / `ownership` / `input-handling`. Record location (file:line, symbol), impact, and severity with a one-line reason.

Candidate discovery is bounded: aim for 1–3 confirmed findings per round. More than that usually means the round should split into two scopes.

### 2. Patch

- Make the smallest scope-only change that addresses the root cause named in the proof. Write the root cause in the ledger before editing.
- No public API, config format, wire/serialization format, CLI flag, schema, or persisted-data changes unless the bug *is* in that surface; say so explicitly if it is.
- No drive-by refactors, renames, or formatting outside the lines the fix needs. The diff must be traceable line-for-line to a finding ID.
- No new dependencies.
- Do not patch anything that exists only as an audit observation. If you notice something unproven while patching, add it as a candidate for step 1, not to the diff.

### 3. Verify

- Write `.temp_files/verify_F<ID>_<slug>.<ext>`: the same reproduction plus at least two nearby edge cases (empty, boundary, repeated call, out-of-order completion, failure injected at the dependency). It ends with `FIX VERIFIED` + zero exit.
- Re-run the original `prove_F<ID>_*` and confirm it now prints `PROBLEM NOT REPRODUCED`. Paste both outputs into the ledger.
- For `race` / `ownership` / lifecycle findings, the verifier must use **gated completion order**: explicit barriers, channels, futures, latches, or deferreds that force the stale task to complete after the stop/restart. Sleep-based timing is not accepted as verification in any language. Run under the project's race detector or sanitizer if one is configured.
- Run the verifier at least 3 times in a row. A verifier that is not deterministic is not accepted.

### 4. Promote

For findings rated High or Critical, or any `race` / `ownership` finding, promote the strongest proof into the project's permanent test suite next to the code it covers, following the project's test naming, placement, and assertion conventions. `.temp_files` artifacts are evidence for this round; the regression test is what protects the branch next month. Record the test path in the ledger. Medium/Low findings may stay as `.temp_files` verifiers unless the user asks otherwise.

### 5. Validate (in this order, report each exactly)

1. The focused proof/verify/regression tests for every finding.
2. The scope's own test target (package, module, crate, directory, as the project defines it).
3. Compile / typecheck / build, as the project defines it.
4. Formatter and linter, scoped to the changed files, using the project's configured tools.
5. `git diff --check`.

Run broader suites **serially** when tests share writers (temp dirs, daemons, ports, databases); parallel runs produce false failures in such repos. Paste the command and the result line for each step. If a step was not run, say `NOT RUN` and why. Never imply it passed.

If the sandbox blocks a command (network, write outside the workspace, process spawn), request approval for that exact command rather than working around it. A workaround changes what was validated.

### 6. Hand-off

- Leave all `prove_*`, `verify_*`, and ledger files in place.
- No `git commit`, `push`, `reset`, `stash`, `checkout --`, or `.temp_files` cleanup unless the user explicitly authorizes it in this session.
- Show `git status --short` again and confirm the pre-existing changes from Setup step 1 are unchanged.
- End with the report (below), then `Awaiting instructions for the next turn.` If the user asked for continued rounds, propose the **next scope** as one line with a reason, not a roadmap.

## Environment boundaries (record, do not infer)

- Permission errors on temp files, daemon/service startup failures, port conflicts, missing system libraries, and flaky network are **environment contamination** until a focused reproduction ties them to the patch. Compare: does the focused proof pass while the broad suite fails on an environment error? Then rely on focused + scoped test + build + lint + diff evidence and state the broad-suite boundary explicitly. Do not label the product "fixed" or "regressed" from a contaminated run.
- Security claims that need a real boundary (sandbox escape, privilege bypass, injection into a live service) require that boundary to exist in the environment. If it does not, stop that line of inquiry, write the boundary in the ledger, and do not infer a result from static reading.
- A proof that depends on network, a live external service, wall-clock timing, or the host's locale/timezone is not a proof here. Rewrite it with a fake at the project's own seam, or drop the finding.

## Cross-language defect shapes

Recurring defect shapes that survive regardless of language. Check for them explicitly where the scope has async, concurrency, resources, or external input.

| Symptom | Cause | Fix shape | Verifier shape |
|---|---|---|---|
| Stale async work publishes into a stopped/restarted/replaced owner | State accepted after an await/callback without re-checking identity, generation, or liveness | Capture identity+generation before the suspension point, compare after, drop on mismatch | Gated completion order: start → stop/replace → release the stale task → assert nothing published |
| Cleanup removes another instance's file, lock, socket, or record | Ownership assumed after a failed exclusive create or an uncertain existence probe | Clean or reclaim only on proven ownership (token/PID/generation) or proven absence; fail closed on unknown errors | Two instances contend; assert the loser never deletes the winner's resource; injected unknown error aborts cleanup |
| Handler, callback, or listener runs on a disposed/closed owner | Registration outlives the owner; close didn't unregister or cancel in-flight work | Close unregisters and flips a closed flag every entry point checks | Close, then fire the event; assert no-op and no panic/throw |
| Resource count grows across repeated operations (handles, goroutines/threads, listeners, connections, memory) | Release missing on an error or early-return path | Move release into `finally`/`defer`/RAII/context manager; make release idempotent | N iterations with injected failure; assert count unchanged before vs after |
| Partial write, torn record, or replay divergence | Writer committed an incomplete or out-of-order record on error; reader trusts arrival order | Write complete records atomically; sequence by generation, not arrival | Replay into fresh state after one injected failure; deep-equal against live state |
| Off-by-one or boundary mishandling | Inclusive/exclusive mismatch at 0, 1, length, max | Fix the comparison; assert the boundary in a comment only if non-obvious | Proof at exactly the boundary, control one step inside |
| Error swallowed or converted to a default | Catch-all returns nil/zero/empty instead of propagating | Propagate, or handle the one specific case and propagate the rest | Inject the error at the seam; assert it reaches the caller |
| Unvalidated input reaches a sensitive operation | Trust boundary assumed, not enforced | Validate at the boundary; reject, don't sanitize-and-continue | Malformed/hostile input; assert rejection and no side effect |

## Report structure

ALWAYS end the round with this exact layout, taken from the ledger:

```
## Round <N> — <scope>
### Summary
<findings confirmed / dropped / promoted; residual risk in one sentence>

### Toolchain
<language/version, test runner cmd, build cmd, lint cmd, race/sanitizer if any — with the file each was read from>

### Findings
#### F<ID> — <type> — <severity> — <title>
- Location:
- Root cause:
- Proof (before): .temp_files/prove_F<ID>_<slug>.<ext> → <key lines>
- Patch: <files:lines changed>
- Proof (after): .temp_files/verify_F<ID>_<slug>.<ext> → <key lines>; original proof → PROBLEM NOT REPRODUCED
- Regression test: <path> | not promoted (<reason>)

### Not reproduced (dropped)
<one line each, or "none">

### Validation
- Focused tests: <cmd> → <result>
- Scope tests: <cmd> → <result>
- Build/typecheck: <cmd> → <result>
- Format/lint (scoped): <cmd> → <result>
- git diff --check: <result>
- NOT RUN: <full suite / live / security / other> — <reason>

### Boundaries
<environment contamination observed, security lines stopped, shared-branch notes>

### Working tree
<git status --short; confirmation that pre-existing changes are untouched>

### Next scope (if rounds continue)
<one line + reason>
```

## Verification checklist (self-check before reporting)

- [ ] Toolchain was read from the repo and cited; nothing was installed.
- [ ] Every finding has a `prove_` that printed `PROBLEM CONFIRMED` on unmodified code, with an unaffected control (and a stated baseline for perf).
- [ ] Every finding has a `verify_` that printed `FIX VERIFIED` three times in a row, and its `prove_` now prints `PROBLEM NOT REPRODUCED`.
- [ ] Race/ownership verifiers use gated completion order, not sleeps; race detector/sanitizer used if configured.
- [ ] Diff contains only lines traceable to a finding ID; no files outside scope; no new dependencies; pre-existing `git status` changes untouched.
- [ ] High/Critical and race/ownership findings have a permanent regression test path.
- [ ] Validation steps are reported with exact commands and results; unrun steps say `NOT RUN`.
- [ ] No commit/push/reset/cleanup performed without explicit authorization.
- [ ] Ledger on disk matches the report; IDs are stable across rounds.

## Session authorization and source drift

If the user already authorized independent scope selection or continued rounds,
choose a concrete next scope and record its paths; do not repeat the setup
question. Preserve existing edits while repairing an in-scope path—“dirty” does
not mean that path is forbidden. If source changes during proof/patch/verify,
reread and rerun the unchanged proof before attributing the result.
If the user requested review only, record proofs and findings without applying
production fixes; audit-and-fix authorization remains distinct.

## Acceptance checks

- Retain an executable before-proof, narrow fix and independent passing verification.
