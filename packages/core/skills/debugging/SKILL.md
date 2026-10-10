---
name: debugging
description: |
  Use this skill when something is broken and the cause is unknown — a failing test, a crash, an error message, wrong output, a regression, a hang, or behaviour that differs between environments — and it has to be found and fixed at the root.
  Also use it to build the failing proof for a suspected defect before fixing it, as in a proof-driven bug hunt.
  Triggers: user says "debug", "broken", "doesn't work", "failing", "error", "exception", "stack trace", "crash", "regression", "it used to work", "hangs", "why does", "root cause", "works on my machine", "reproduce", "prove it".
version: 1.2.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [execution.shell, verification.run, code.inspect, version-control.manage]
trigger: "Use this skill when something is broken and the cause is unknown \u2014 a failing test, a crash, an error message, wrong output, a regression, a hang, or behaviour that differs between environments \u2014 and it has to be found and fixed at the root. Also use it to build the failing proof for a suspected defect before fixing it, as in a proof-driven bug hunt."
metadata:
  routing-group: quality
---

# Debugging

## Selection card
- Task: Reproduce and diagnose a reported failure.
- Start: Identify the scope and obtain an executable before-proof or review evidence.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Debugging is a search for the first point where reality diverges from
expectation. It goes fast when every step narrows the search with evidence, and
slowly when it guesses and patches symptoms. The deliverable is a fix at the
cause, a test that fails without it, and an explanation that accounts for every
observation.

This skill starts from an observed failure, or from a suspected defect that
`bug-hunter` selected and that now has to be proven. Scanning code for defects
nobody has reported yet is `bug-hunter`.

## Rules

1. Reproduce before fixing. Get a command, test, or input that shows the failure
   on demand. If that isn't possible yet, the first job is making it
   reproducible — logs, inputs, environment — not changing code. If it never
   becomes reproducible, production code stays untouched and the report says
   what was tried.
2. Read the whole error. The top of a stack trace is where the failure surfaced;
   the cause is often further down: a `Caused by`, the first frame in project
   code, or the earliest error in the log.
3. Form a hypothesis that explains every symptom, then run the cheapest
   experiment that could prove it wrong.
4. Change one thing at a time, and keep a short log of what was tried and what
   it showed.
5. Fix the cause, not the symptom. Swallowing the error, widening a type, adding
   a retry, or special-casing the failing input is only right when that really is
   the correct behaviour.
6. Prove the fix: the reproduction passes, a regression test fails without the
   fix, and neighbouring tests still pass.
7. Remove temporary instrumentation before finishing.
8. After three disproven hypotheses, step back. Re-check the assumptions — right
   file, right build, right branch, right environment — or bisect.

## Workflow

1. **Capture** the exact error text, command, input, environment, and what
   changed recently (history, dependency bumps, configuration).
2. **Reproduce** with the smallest command that fails — ideally one test.
3. **Localize**:
   - follow the stack trace to the first project frame and read it;
   - trace a wrong value backwards to where it first became wrong;
   - with the codebase index, the codebase-incoming-calls and
     codebase-outgoing-calls tools show how the failing code is reached, and
     codebase-context finds code from a description of the behaviour;
   - if it used to work, bisect with the reproduction as the test;
   - if the search space is large, halve it: add a checkpoint in the middle, or
     disable half of the suspects.
4. **Explain** the cause in one or two sentences that cover every symptom,
   including "why only sometimes" and "why only here".
5. **Fix** at the cause with a minimal diff.
6. **Verify**: the reproduction passes; the regression test goes red then green;
   covering tests (the codebase-targeted-test tool finds them) and the type
   checker pass.

## Proof-grade reproduction

A reproduction is evidence only if it could not have failed for any other
reason. Before trusting a red run:

- **It runs the production path.** Call the real implementation; mock only the
  boundaries you don't own (network, clock, randomness, third-party services).
  A copied algorithm or a mock of the code under suspicion proves nothing.
- **It asserts the contract.** The assertion encodes the expected behaviour and
  its basis — a documented contract, a caller's requirement, or an established
  test — not whatever the code happens to return.
- **It fails on that assertion.** An import error, a setup failure, a missing
  dependency, or a timeout is blocked verification, not a red proof. Fix the
  harness until the failure message is about the defect.
- **It has a control.** Pair it with a neighbouring valid input or an unaffected
  path that passes before and after the fix, so a broken harness cannot
  masquerade as the bug.
- **It is deterministic.** Fake timers, seeded randomness, controlled async
  ordering, fixed fixtures. For anything timing-related, run it several times.
- **It runs the code you think it runs.** Check whether the runner loads source
  or built output. In a monorepo a stale build of a dependency makes red and
  green compare the wrong code; rebuild the chain or point the runner at source.
- **It is recorded before any fix.** Keep the working directory, command, exit
  code, and the meaningful failure lines; the same command must later go green
  with unchanged assertions and fixtures.

Keep throwaway proof scripts and fixtures in a scratch directory you own, and
remove only that directory once the evidence is in the report.

### Shared checkouts

Other people or processes may be editing the same working tree. Record the
starting revision and dirty paths first. If the affected source changes between
the red run and the fix, re-read it and reproduce again. Never revert, stash, or
check out over someone else's changes to manufacture a baseline — copy the
unfixed implementation to an isolated location instead.

## First moves by symptom

| Symptom | First moves |
|---|---|
| Exception with a stack trace | First project frame; the values at that frame; where a null or undefined came from |
| Wrong output, no error | Trace the value back; check intermediate values; compare against a known-good input |
| It used to work | History of the touched files; `git bisect run <reproduction command>` |
| Only in CI or on one machine | Diff the environment: runtime and dependency versions, env vars, OS path case, line endings, timezone, locale, parallelism |
| Intermittent | Races, shared state, timers, test order, retries hiding errors; run it many times, alone, and shuffled |
| Hang | Unresolved promise, deadlock, missing timeout, waiting on stdin; take a stack dump or log progress at each boundary |
| Slower than before | Profile before and after; don't guess |
| Build or type error | Read the full error chain; fix the value or the declaration at its source |

## Instrumentation

- Prefer a focused test or a debugger over prints scattered across files.
- Tag temporary logs with a unique marker so every one is found and removed, and
  log values with their types, not "got here".
- Never add logging that writes secrets or personal data.

## Report

```text
## Root cause
The retry wrapper reuses the AbortSignal from the first attempt; once it times
out, every retry is aborted immediately, so the job fails after 30 s instead of
retrying for 2 min.

## Evidence
- `pnpm test retry.test.ts -t "retries after timeout"` failed with AbortError before the fix
- src/net/retry.ts:41 passes `options.signal` to every attempt

## Fix
src/net/retry.ts:41 — create a fresh timeout signal per attempt, combined with the caller's signal.

## Verification
- Regression test red before, green after
- net package tests and type check pass
```

## Anti-patterns

- **Shotgun edits** — changing several things until the error disappears.
- **"Fixed" without reproducing** — the failure may simply not have occurred this run.
- **Catching and ignoring** the exception.
- **Sleeps and retries** for an intermittent failure whose cause is unknown.
- **Blaming the framework, compiler, or cache** before ruling out the project's
  own code — and clearing caches only when evidence points there.
- **Naming a cause from the error message alone** without reading the code.
- **Proof theatre** — a "reproduction" that fails on setup, a mock, or an
  artificial `throw`, or that re-implements the logic instead of calling it.
- **Moving the goalposts** — changing the proof's assertions or fixtures after
  the fix without re-running the changed proof against the unfixed code.

## Before returning

- [ ] Failure reproduced, or it is stated plainly why it couldn't be
- [ ] Reproduction calls the production path, fails on the contract assertion,
      and has a passing control
- [ ] Root cause stated, consistent with every symptom
- [ ] Fix at the cause; no swallowed errors or special-casing
- [ ] Regression test seen red, then green; related suites pass
- [ ] Temporary instrumentation removed

## Runtime identity and diagnostic experiments

Check the running process, source/build path, configuration and revision before
trusting a reproduction. A rebuilt binary is not in use until the relevant
process reloads/restarts. When reproduction is incomplete, temporary diagnostic
changes may be warranted; label them as experiments and do not call them a fix.
Preserve audit proof artifacts when the task/runbook requires retained evidence.

## Skills in scope

- `testing` — for the regression test that pins the fix
- `bug-hunter` — for scanning nearby code for the same defect pattern
- `verify-before-done` — for the final proof before reporting
- `git-flow` — for bisecting and for committing the fix
