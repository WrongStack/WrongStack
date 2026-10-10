---
name: verify-before-done
description: |
  Use this skill before telling the user a code change is finished, fixed, or working — to prove it with the project's own checks and report exactly what was and wasn't verified.
  Triggers: finishing an implementation or fix, writing the final summary of code changes, "done", "is it working", "did you test it", "make sure it works", "verify", "ready to merge".
version: 1.2.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [verification.run, execution.shell, version-control.manage, code.inspect]
trigger: "Use this skill before telling the user a code change is finished, fixed, or working \u2014 to prove it with the project's own checks and report exactly what was and wasn't verified."
metadata:
  routing-group: quality
---

# Verify Before Done

## Selection card
- Task: Prove a claimed fix or completion actually works.
- Start: Identify the scope and obtain an executable before-proof or review evidence.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

"Done" is a claim the user acts on: they merge, deploy, or stop looking. This
skill makes the claim evidence-based — the change does what was asked, nothing
adjacent broke, and the report says precisely what was checked. It costs
minutes; a false "done" costs the user's trust and often an incident.

## Rules

1. Re-read the request and check the change against every part of it, including
   the easy-to-forget parts: docs, config, migrations, other platforms.
2. Review your own diff before reporting — unintended edits, leftover debug
   code, commented-out code, new TODOs, secrets, files from unrelated work.
3. Run the checks that apply, cheapest first: format and lint, type check,
   targeted tests, the suites for touched packages, build. Use the project's own
   commands from package scripts, Makefile, or CI config.
4. Exercise the behaviour itself when no test covers it: run the command, call
   the endpoint, open the page. A passing unrelated suite is not evidence.
5. Read results instead of trusting exit codes. Zero tests run, skipped suites,
   disabled checks, and cached results are not passes.
6. Fix failures you caused. Show pre-existing failures are pre-existing (they
   fail on the base too) and report them; never weaken a check to get green.
7. Report faithfully: what ran and its outcome, what couldn't be verified and
   why, and known gaps. Never write "should work" in place of checking, and
   never claim a check that didn't run.
8. Lead with an honest outcome. A change whose related checks failed, timed
   out, or didn't run is "done, verification incomplete" — never "done". When
   the task defines outcome labels, use them exactly.

## Record the starting state

"Pre-existing" is a claim about the past, so capture the past before changing
anything: the revision, the dirty paths, and — when the task will end with a
suite run — which tests already fail. Comparing against that record is how a
failure is shown to be pre-existing without stashing or checking out the base
in a working tree others may be using.

## Workflow

1. **Requirements** — list each requested outcome and the evidence for it.
2. **Diff** — `git status` and the full diff; every hunk belongs to the task.
   In a shared working tree, other edits may appear in the diff: attribute
   only your hunks to the change, name the rest as not yours, and never revert
   them.
3. **Static checks** — lint, format, type check (the lint and typecheck tools
   where available).
4. **Tests** — targeted first (the codebase-targeted-test tool finds tests
   covering changed symbols), then the suites for touched packages. New
   behaviour has a test.
5. **Behaviour** — run it for real when feasible.
6. **Blast radius** — for changed signatures and contracts, check callers (the
   codebase-impact-analysis tool when indexed) and build the dependents.
7. **Cleanup** — remove the temporary scripts, fixtures, and logs you created,
   and only those. If a check failed or cleanup is unsafe, leave them and
   report their exact path.
8. **Report.**

## Minimum evidence by change type

| Change | Evidence |
|---|---|
| Bug fix | The same reproduction, with unchanged assertions and fixtures, fails before and passes after; its control case passes both times; a regression test in the normal suite, seen red then green |
| New feature | Tests for the main path and one error path; the user-facing flow run once |
| Refactor | Existing tests pass without being edited; type check clean |
| Public API, schema, config | Consumers build; migration applied and rolled back locally |
| UI | Rendered at the relevant widths; interactive states work; no console errors |
| Dependency update | Clean install from the lockfile, build, full test suite; breaking changes in the changelog reviewed |
| Docs only | Links and code samples still valid |

## Report

```text
Done: charges now retry with an idempotency key, so a timeout can't double-charge.

Verified
- Proof: `node scratch/double-charge.mjs` — exit 1 "FAIL: 2 charge requests" before, exit 0 after
- `pnpm --filter billing test` — 48 passed, including the new retry test (failed before the fix)
- Type check — clean
- `app charge --dry-run` on the fixture order — one charge request with the expected key

Not verified
- End-to-end suite (needs staging credentials)

Notes
- reports.spec.ts fails on main with the same error; unrelated and left untouched.
```

## Anti-patterns

- **"Done — should work"** with nothing run.
- **A filtered, cached, or partial run** reported as the full suite.
- **Editing or skipping a test** to make it pass.
- **A failure buried** in the middle of a long summary.
- **"Pre-existing failure"** claimed without checking the base.
- **Stopping at "it compiles".**
- **A green proof reported as a verified fix** while related checks fail.
- **"No bug found" presented as a clean bill of health** for code that was only
  partly inspected.

## Before returning

- [ ] Outcome stated first, and "incomplete" wherever any check failed or didn't run
- [ ] Every requested outcome maps to evidence
- [ ] Own diff reviewed; nothing unrelated or left over; others' edits untouched
- [ ] Temporary artifacts you created removed, or their path reported
- [ ] Applicable checks run with the project's commands, results read
- [ ] Behaviour exercised directly where tests don't cover it
- [ ] Report separates verified, not verified, and pre-existing issues

## Final input identity

Record which source revision/dirty snapshot each check used. Later source changes
invalidate relevant earlier checks; repeat only the affected verification.
For documentation/skills, verify loading, links, examples and discovery rather
than generating tests that merely match new prose.
Retain proofs/logs when the audit workflow or user requests evidence retention;
cleanup only owned disposable files. Report local builds, hosted CI, publication
and live behavior as separate outcomes, each with its own evidence.

## Skills in scope

- `testing` — for the tests the evidence needs
- `debugging` — when verification turns up a failure with an unknown cause
- `code-review` — for a self-review pass on a larger diff
- `git-flow` — for committing once the change is verified
