# Testing (Compact)

<!-- source-version: 2.2.4 -->

## Selection card
- Task: Write meaningful behavior and regression tests. / TR: Anlamlı davranış ve regresyon testleri yaz.
- Start: Find the project's test runner, a neighbouring test and how CI runs the suite.
- Finish: New or fixed tests fail without the change, pass with it, and run deterministically in the project's own runner.

## Overview

Write tests that fail for the right reason and pass for the right reason, in the
project's own runner, layout, and style. A test earns its place by catching a
regression someone could plausibly introduce; everything else is maintenance
cost.

## Rules

1. **Pre-flight: Inspect repo runner & live version first.** Inspect project manifests and
   runner configs (`Cargo.toml`, `pyproject.toml`, `pytest.ini`, `go.mod`, `package.json`,
   `vitest.config.ts`, `playwright.config.ts`, `pom.xml`, `build.gradle`) and existing suites.
   Query the authoritative registry only when adding/upgrading a runner and match repo layout.
2. See it fail first. A regression test must fail without the fix — a test that
   was never red proves nothing.
3. Test behaviour through the public surface. Don't assert on private helpers or
   internal structure a legitimate refactor would change.
4. Mock the boundaries you don't own (network, clock, randomness, third-party
   SDKs, slow I/O), not the collaborator next door.
5. Keep every test isolated: no order dependence, no shared mutable state;
   restore mocks, timers, and environment in teardown.
6. Bound every wait that can hang (network, sockets, child processes, polling),
   and drive time-based logic with fake timers instead of real sleeps.
7. Report exactly what ran: the command, the files, pass/fail/skip counts. A run
   that matched no tests is not a pass; never fake green with suppressions (`as any`,
   `@ts-ignore`, `# type: ignore`, `#[allow(...)]`, `//nolint`), and stop once verified.

## Detailed workflow

Load the full testing skill before relying on its specialized modes,
references or output contracts. Its current SKILL.md is the source of truth;
this compact body does not expand task scope or authorization.

## Before returning

- [ ] Runner, layout, naming, and helpers match the project's existing tests
- [ ] Every new regression test was seen failing before the fix, on its
      assertion rather than on setup
- [ ] The test file is inside the runner's include patterns and actually ran
- [ ] Assertions target behaviour with specific matchers
- [ ] Mocks, timers, and environment restored; no order dependence
- [ ] Commands and results reported exactly, including skips and filters
