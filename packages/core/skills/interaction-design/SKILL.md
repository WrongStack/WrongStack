---
name: interaction-design
description: "Interaction flows: forms and validation timing, wizards, optimistic updates, undo vs confirm, loading, error recovery and focus. Use when designing or fixing how a flow behaves (onboarding, checkout, settings, inline edit, delete, async save) or when users double-submit, lose drafts, get stuck or miss feedback. Not for tokens (use design-system) or visual composition (use design-craft)."
trigger: "Use when a user flow's states, feedback, validation, navigation or recovery behavior is designed or fixed."
version: 1.2.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: design
  domain: "design"
---

# Interaction Design

## Selection card
- Task: Design and implement how a flow behaves: states, transitions, feedback timing, validation, navigation and recovery.
- Start: Write the flow's state map (entry points; idle, pending, success and error per async action; cancel and back) and find the existing form, mutation and routing primitives.
- Finish: every state in the map is reachable and was observed by keyboard, on a throttled network and with a failed request; the acceptance table below is recorded as observed or not observed.

## Overview

A flow is a state machine the user can see: every action answers within about 100 ms, every failure keeps the user's work and says what to do next, and no navigation — back, refresh, double click — repeats a side effect or drops a draft.
Use the current project design system and actual platform conventions. Refresh platform guidance before choosing a new interaction model.

## Rules

1. Map states before screens: idle, pending, success, error, empty, partial, cancelled and interrupted for each async action.
2. Prefer undo over confirmation for reversible actions; confirm only irreversible or costly ones, naming the object and the consequence.
3. Validate late, clear early: show a field error on blur or submit, not on the first keystroke, and remove it as soon as the input becomes valid.
4. Do not disable submit to signal invalid input; let submit validate and focus the first error. Disable only while a request is in flight, backed by a server idempotency key.
5. Every optimistic update has a rollback that restores the previous value and tells the user; optimistic state never outlives a rejected write.
6. The URL holds navigable state (filters, tab, page, selected item, wizard step); replace history for keystroke-level changes, push it for real navigation.
7. After open, close, delete or step change, focus lands on the next logical control, never on `<body>`.
8. Every essential action has a path without hover, drag or gestures; a toast never carries the only route to an action.

## First moves by situation

| Situation | First moves |
|---|---|
| Duplicate orders or double submits | Block resubmission while pending, including the Enter-key path; add an idempotency key the server enforces; check client retry logic |
| Draft lost on error or back | Keep form state on failure; persist long drafts (session storage or server); guard navigation only when the form is dirty |
| "Did it save?" | Inline status beside the control ("Saved 12:04") plus a polite live region; no toast per autosave |
| Wizard abandonment | Step count and progress, back without data loss, validation per step, deep-linkable steps |
| Slow action | Delay the spinner ~200–300 ms to avoid a flash; past ~10 s show real progress and a cancel |
| Delete | Reversible: act now, offer keyboard-reachable undo, move focus to the next item. Irreversible: dialog naming the object, initial focus on the safe button |
| Endless list complaints | Unreachable footer and lost position on back: prefer "Load more" or pagination and restore scroll |
| Inline edit | Enter saves, Escape cancels and restores, blur behavior stated; pending and failed shown per field |
| Search and filters | Debounce ~250 ms, abort stale requests, announce the result count, keep the query in the URL |

## Patterns and pitfalls

- **Out-of-order responses** — a slow earlier request overwrites newer results; abort the previous request (`AbortController`) or discard responses with an old request id.
- **React 19 forms** — `useActionState` and `useFormStatus` expose pending state; `useOptimistic` falls back to the real value when the action settles, so a failure must also be shown, not only reverted.
- **Two validation layers** — client checks are for speed; the server returns field-keyed errors that map onto the same fields and the same messages.
- **Error copy** — what happened, why if known, what to do next, in the user's words; keep everything they typed.
- **Confirmation fatigue** — confirming routine actions trains click-through; reserve dialogs for irreversible actions and use type-to-confirm only for catastrophic ones.
- **Refresh resubmits** — after a form POST redirect to a GET (post/redirect/get) so refresh and back do not repeat the action.
- **Modals for long tasks** — multi-step or long forms belong on a route; stacked modals break focus return and the back button.
- **Empty states differ** — first use teaches and offers the primary action; no-results offers clearing filters; error offers retry.
- **Unsaved-changes guard** — `beforeunload` only shows the browser's generic prompt and only when the handler calls `preventDefault`; SPA routes need a router-level guard.
- **Keyboard shortcuts** — discoverable, never stealing browser or screen-reader keys; single-key shortcuts must be possible to disable (WCAG 2.1.4).
- **Motion** — transitions explain a spatial change in roughly 150–300 ms and respect reduced motion; nothing waits on an animation to become usable.

## Workflow

1. Trace the current journey and mark where users hesitate, repeat work or get stranded.
2. Write the state map and representative content, including long and localized labels.
3. Pick the pattern id for each step from design-patterns and keep its invariants.
4. Implement with shared primitives and the existing validation and data boundaries.
5. Exercise keyboard and touch, slow network, failed and duplicate submission, cancel, back and refresh mid-flow.
6. Inspect the rendered journey, fix the highest-impact observed issue, and repeat the failed path.

## Measurable acceptance

Structure each flow with a pattern id from design-patterns (`forms-and-flows.md`,
`feedback-states.md`): e.g. `single-column-form`, `multi-step-wizard`,
`inline-edit`, `destructive-confirm`, `undo-action`, `error-state`. Then check:

| Area | Check | How to observe |
|---|---|---|
| Response time | Feedback for an action starts within ~0.1s; a spinner or skeleton after ~1s; work over ~10s shows progress and can be cancelled | Throttle the network in the browser and act |
| Async states | Every async action has idle, pending, success and error; pending blocks a duplicate submit | Double-click submit; the request runs once |
| Validation | The error is beside its field, tied by `aria-describedby`, and says how to fix it; on submit, focus moves to the first invalid field; input is never cleared | Submit an invalid form with the keyboard only |
| Recovery | Failed writes keep the user's data; retry is offered where the failure is transient | Fail the request (offline / 500) and retry |
| Destruction | Irreversible actions confirm by naming the object, or offer undo | Delete something; read the dialog |
| Navigation | Back never repeats a payment or loses a draft; deep links restore state | Use browser back mid-flow |
| Overlays | Opening a dialog moves focus into it; Escape closes it; focus returns to the trigger | Tab, Escape, Tab |

Run `design_reference {action:"inspect", url, surface:"app"}` on each reachable state you
can load by URL; `a11y.target-size` and `a11y.text-contrast` apply to error and
disabled states too. Record each check as observed / not observed in `.design/review.md`.

## Proof

- Slow network: `await page.route('**/api/**', async (route) => { await new Promise((r) => setTimeout(r, 2000)); await route.continue(); })`.
- Failure and offline: `route.fulfill({ status: 500, json: { error: 'x' } })`; `await context.setOffline(true)`.
- Double submit: count requests with `page.on('request', ...)`, `await submit.dblclick()`, assert the count is 1.
- Back and refresh: `await page.goBack()` and `await page.reload()`, then assert the draft and URL state survived.
- Focus: `await expect(page.getByRole('button', { name: 'Undo' })).toBeFocused()` or the next logical control.
- Component level: Testing Library with `user-event` for typing, blur and keyboard submit.

## Stop and ask

- The change alters what is reversible, or removes a confirmation from a destructive action.
- Payment, order or other money-moving flows need server idempotency or retry changes.
- Legal consent, cancellation or data-deletion flows change behavior.
- The fix needs a new routing or state-management library.

## Before returning

- [ ] Complete state matrix (idle, pending, validation error, transient failure, empty, success) implemented and reachable
- [ ] Pending mutations block duplicate submission while preserving user input and draft state on failure
- [ ] Field errors bound via `aria-describedby` / `aria-invalid` with focus moved to the first invalid control on submit
- [ ] Dialogs/drawers trap focus, close on `Escape`, and restore focus to the invoking trigger on close
- [ ] Destructive actions guarded by explicit object-named confirmation or timed undo
- [ ] Back, refresh and deep links restore URL-held state without repeating a side effect
- [ ] Slow, failed and offline paths exercised, with the observed result recorded

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Android interaction guidance](https://developer.android.com/design/ui/mobile), [ARIA patterns](https://www.w3.org/WAI/ARIA/apg/patterns/).

## Skills in scope

- design-system — shared interactive state tokens (`hover`, `focus-visible`, `active`, `disabled`, `invalid`).
- design-craft — visual hierarchy, form rhythm, and contextual copy for empty/error/confirmation states.
- accessibility — keyboard navigation, focus management, `aria-live` status announcements, and target sizing.
- testing — automated user-event tests covering validation errors, double-submit prevention, and retry recovery.
- design-patterns — pattern ids and invariants for forms, wizards, inline edit and feedback states.
