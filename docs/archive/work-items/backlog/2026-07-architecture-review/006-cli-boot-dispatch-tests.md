# Expand CLI boot/dispatch integration tests

**Labels**  
`testing` `cli` `quality`

## Summary

The current CLI baseline tests characterize only a narrow part of the boot contract. Large refactors can still regress dispatch behavior without early detection.

## Why this matters

The CLI boot path is one of the highest-risk integration surfaces in the repo.

## Scope

Add integration tests that cover more of the real boot/dispatch behavior while staying reliable in CI.

## Acceptance criteria

- [x] Add integration tests for:
  - [x] single-shot path
  - [x] TUI dispatch path
  - [x] WebUI dispatch path
  - [x] plugin-management short-circuit
  - [x] no-TTY/no-stdin non-hanging behavior
- [x] Tests avoid the worker-contention issue documented in current test comments
- [x] At least one test exercises `main()` end-to-end with bounded runtime

## Completion evidence (2026-07-22)

`cli-dispatch-journeys.test.ts` pins the production mode precedence and exercises
the single-shot, lazy TUI, WebUI-option, and boot-level plugin-management
boundaries with explicit 5–10 second ceilings. The existing real WebUI baseline
continues through HTTP/WebSocket startup and graceful signal shutdown. The
no-TTY/no-stdin `main()` smoke test now uses `Promise.race` so its 30-second
ceiling is enforced independently of the suite timeout. The heavy `main()`
import remains isolated in the sequential baseline file; the dispatch matrix
uses focused production modules. CLI typecheck passes, and the six-file focused
run passes 123 tests.

## Suggested implementation notes

- Prefer bounded runtime and targeted stubs over importing the entire dependency graph unnecessarily.
- Preserve existing baseline tests; expand rather than replace.

## Effort

Estimated: **2–3 days**
