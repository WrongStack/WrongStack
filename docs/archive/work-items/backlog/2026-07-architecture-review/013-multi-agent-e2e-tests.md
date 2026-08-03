# Add deeper end-to-end orchestration tests for multi-agent flows

**Labels**  
`testing` `core` `multi-agent` `quality`

## Summary

Multi-agent flows now have a deterministic outcome-oriented journey suite over the real Director and coordination services.

## Why this matters

The coordination layer is strategically important and has high complexity. It needs stronger end-to-end protection.

## Scope

Add scenario tests for multi-step orchestration behavior.

## Acceptance criteria

- [x] Add scenario tests covering:
  - [x] spawn → assign → await
  - [x] quality gate repair loop
  - [x] collab debug flow
  - [x] mailbox result propagation in a coordinated task
- [x] Tests validate user-visible outcomes, not just event emission
- [x] Flake rate remains acceptable in CI

## Completion evidence (2026-07-22)

`multi-agent-journeys.test.ts` runs all four paths against the real Director, quality-gate tool, CollabSession/FleetBus, and mailbox persistence with only the LLM runner replaced by a deterministic fake. The journey exposed and fixed a production ID-contract bug where CollabSession awaited subagent IDs instead of the task IDs returned by `Director.assign()`. Core typecheck passes, the focused journey/collab/director-tool set passes 4 files / 73 tests, and test-type verification reports no new diagnostics in the touched journey or collab files. The full Core collection passed 442 unaffected files / 7,050 tests; two unrelated concurrent suites remain red (the retired slash-import exception test and sync-plugin work).

## Suggested implementation notes

- Keep scenarios focused and deterministic.
- Start with one representative happy-path flow per subsystem.

## Effort

Estimated: **3–5 days**
