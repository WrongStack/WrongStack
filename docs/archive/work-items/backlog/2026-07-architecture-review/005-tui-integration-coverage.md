# Strengthen TUI integration coverage beyond mount/no-crash behavior

**Labels**  
`testing` `tui` `quality`

## Summary

Current TUI integration tests prove mount/no-crash behavior, but they do not provide enough behavioral protection for the size and complexity of the TUI app.

## Why this matters

Large refactors in the TUI surface still lack a strong behavior net, especially around:
- keyboard handling
- picker flows
- resume/render paths
- input submit/history behavior

## Scope

Add scenario-level TUI tests that assert real interaction behavior.

## Acceptance criteria

- [x] Add scenario tests covering:
  - [x] slash menu open/navigate/submit
  - [x] picker open/close behavior
  - [x] mode/model selection flow
  - [x] session resume rendering
  - [x] input submit + history update
- [x] Tests assert behavior, not just no-throw render
- [x] New tests run reliably in CI without flake

## Progress notes

Current progress delivered stable slices in:
- `packages/tui/tests/app-integration-submit-history.test.ts`
- `packages/tui/tests/mode-picker.test.ts`
- `packages/tui/tests/picker-keys.test.ts`
- `packages/tui/tests/app-resume-render.test.ts`

Covered behavior now includes:
- grouped slash-menu rendering
- scrolled/windowed slash-menu context retention
- slash-menu empty state guidance
- Input Enter vs Shift+Enter key-event distinction
- mode-picker rendering, active marker, and empty state
- mode-picker panel-open bridge behavior
- model-picker provider selection flow
- model-picker model search + select flow
- mode-picker Enter → `/mode <id>` submission flow
- resumed history rendering for user / assistant / tool entries

The remaining top-level gap is now closed by `app-journeys.test.ts` and the shared
`helpers/app-journey-harness.ts`. The harness mounts the production `<App />`
composition with contract-complete Agent, EventBus, AttachmentStore, and real
SlashCommandRegistry collaborators. It verifies the boot submit path through
`agent.run` into rendered user/assistant history and verifies resumed messages
through the top-level history composition. The baseline App test also waits for
passive hook setup, so a synchronous first frame can no longer hide an invalid
fixture or an effect-time crash.

Focused verification on 2026-07-21 passed 11 files / 157 tests across App
journeys, submit/history, keyboard routing, model/mode selection, and resume.

## Suggested implementation notes

- Favor stable, high-signal interactions over broad snapshot coverage.
- Start with the highest-risk flows used by current refactor work.
- Keep fixtures minimal and deterministic.

## Effort

Estimated: **2–4 days**
