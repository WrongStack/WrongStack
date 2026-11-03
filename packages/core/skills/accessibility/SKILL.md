---
name: accessibility
version: 1.1.1
description: "WCAG 2.2 accessibility fixes and audits: keyboard and focus, ARIA, screen readers, contrast, target size, forms, dialogs, axe findings. Use when a control, dialog, menu, form or drag interaction fails keyboard, screen-reader, zoom or contrast checks, an axe violation is reported, or a /uipolish or /a11yhunt round runs. Not for visual taste critique (use design-critique) or general test strategy (use testing)."
trigger: "Use when a UI must work by keyboard, screen reader, zoom, forced colors or touch, or a WCAG 2.2 AA gap is reported."
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
metadata:
  routing-group: design
---

# Accessibility

## Selection card
- Task: Make a UI operable and understandable by keyboard, screen reader, zoom, forced colors and touch, to WCAG 2.2 AA unless a different target is stated.
- Start: Load the affected route, Tab through it once without a mouse, and read the owning component's markup: element, role, name source, state attributes.
- Finish: the same keyboard pass completes the task with visible focus, the automated scan shows no new violations, and each manual check is reported as observed or not performed.

## Overview

Accessibility is a property of the rendered DOM and its behavior, not of the source or a scanner score: native elements first, then visible focus, then names and states a screen reader reads.
WCAG 2.2 (W3C Recommendation, 4.1.1 Parsing obsolete) is the default target. Legal and procurement targets often still cite WCAG 2.1 AA (EN 301 549, the 2024 ADA Title II rule); 2.2 AA covers 2.1 AA, so confirm which one a conformance claim names.
Automated checkers find a minority of real barriers; keyboard and screen-reader passes find the rest.

## Rules

1. Use the native element before ARIA (`<button>`, `<a href>`, `<input>`, `<select>`, `<dialog>`, `<details>`); a `div` with `role="button"` also needs `tabindex="0"`, Enter and Space handling and disabled semantics.
2. Every action works from the keyboard in DOM order with a visible focus indicator that sticky headers, cookie bars and chat widgets do not cover (2.4.11 Focus Not Obscured, AA); never use positive `tabindex`.
3. Every control has an accessible name that contains its visible label text (2.5.3 Label in Name), and its state is exposed and kept in sync (`aria-expanded`, `aria-pressed`, `aria-selected`, `aria-current`, `aria-invalid`).
4. When content appears or disappears (dialog, deletion, route change, inline error) move focus deliberately; focus must never fall back to `<body>`.
5. Measure contrast on rendered colors: 4.5:1 text, 3:1 large text (24px, or 18.66px bold), 3:1 for component boundaries, focus indicators and meaningful graphics (1.4.11).
6. Targets are at least 24×24 CSS px or spaced so a 24px circle around each does not overlap another (2.5.8, AA); 44×44 is the comfortable touch size and the AAA criterion 2.5.5, not the AA rule.
7. Dragging needs a single-pointer alternative (2.5.7); login must allow paste and password managers with no cognitive test (3.3.8); do not ask again for data already entered in the same flow (3.3.7).
8. Report automated, keyboard and screen-reader results separately; never claim a screen-reader check that was not run, and never present a scan as conformance.

## First moves by situation

| Situation | First moves |
|---|---|
| Control ignores the keyboard | Look for a `div`/`span` with a click handler, a hidden overlay eating focus, or `tabindex="-1"`; replace with `<button type="button">` |
| Modal or drawer | Prefer `<dialog>` with `showModal()` (top layer, inert page, Escape closes); check initial focus, Tab stays inside, focus returns to the trigger |
| Custom combobox, menu, tabs, listbox, tree | Read the WAI-ARIA APG pattern and match its keyboard map (arrows, Home/End, typeahead) with roving `tabindex` or `aria-activedescendant`, or switch to a vetted primitive |
| Form errors not announced | `<label for>` on every field; on submit focus the first invalid field or an error summary; `aria-invalid="true"` plus `aria-describedby` to the message text |
| Silent status (saved, results count, toast) | A `role="status"` region rendered empty at mount, then its text updated; `role="alert"` only for urgent errors |
| SPA route change says nothing | Focus the new `<h1 tabindex="-1">` (or a skip target) and update `document.title` |
| Contrast failure | Measure the actual pair including opacity, gradients and image overlays; fix the token, not the leaf component |
| Zoom or reflow complaint | 320 CSS px wide (400% of 1280) with no two-way scrolling except tables, maps and code; 1.4.12 text-spacing override does not clip |
| Landmark or heading findings | One `<main>`; header, nav and footer landmarks; distinct `aria-label` for repeated `<nav>`; headings in order without skipped levels |

## Patterns and pitfalls

- **aria-hidden over focusable content** — focus enters content the screen reader cannot read. Hide a background region with `inert`, which removes focus and semantics together.
- **aria-label on generic elements** — ARIA 1.2 prohibits naming `generic` elements, so a label on a role-less `div` or `span` is unreliable; add a role or use visible text.
- **Placeholder as label** — disappears on input, usually low contrast, not a dependable name; keep a visible label.
- **disabled vs aria-disabled** — `disabled` removes the control from the tab order, so users cannot discover why; `aria-disabled="true"` keeps it focusable while the handler refuses activation.
- **Live region timing** — a region inserted together with its text is often not announced; mount it empty first. Routine success messages in `role="alert"` interrupt the user.
- **Lost focus ring** — `outline: none` without a replacement fails 2.4.7; box-shadow rings vanish in Windows forced-colors mode. Draw the ring as an outline on `:focus-visible`; a transparent outline survives as a visible system color in forced colors.
- **Hover and focus popups** — tooltips must be dismissible with Escape, hoverable and persistent (1.4.13). The `popover` attribute is non-modal and does not contain focus: right for menus, wrong for dialogs.
- **Icon-only buttons** — the button needs a name (`aria-label` or visually hidden text); the inner SVG gets `aria-hidden="true"`.
- **Toast is the only route to Undo** — an auto-dismissing action fails timing (2.2.1); keep it until dismissed or offer the action elsewhere.
- **Single-key shortcuts** — shortcuts without a modifier must be possible to turn off or remap (2.1.4).
- **Motion** — honor `prefers-reduced-motion: reduce` for parallax, autoplay and large transitions; anything moving longer than 5 s needs pause (2.2.2).
- **Contrast math** — the WCAG 2 ratio is (L1 + 0.05) / (L2 + 0.05) on sRGB relative luminance and overrates dark-on-dark pairs. APCA (Lc) is a WCAG 3 research candidate, not part of any Recommendation: use it only as an extra readability signal, never to claim or deny WCAG 2 conformance.

## Workflow

1. Record route, state, viewport, the user task and the conformance target (WCAG version and level) from the request or contract.
2. Keyboard pass: Tab and Shift+Tab, Enter and Space, Escape, arrows inside composite widgets; list each focus stop, invisible focus, trap or skipped control.
3. Automated pass with the project's tool (axe via Playwright, Storybook or jest-axe; Lighthouse; Biome a11y rules or eslint-plugin-jsx-a11y).
4. Screen-reader pass where available: NVDA or JAWS with Chrome/Firefox on Windows, VoiceOver with Safari on macOS/iOS, TalkBack with Chrome on Android. Check name, role, state, reading order and announcements.
5. Stress: 200% and 400% zoom, 320 px width, text-spacing override, forced colors, reduced motion, long translated labels.
6. Fix at the owning primitive (shared Button, Dialog, Field), re-run the same passes, and add a regression test for the failure.

## Proof

Prefer the project's configured scripts; common forms:
- Role queries: Testing Library `getByRole('button', { name: 'Save' })` or Playwright `page.getByRole('button', { name: 'Save' })`; a failing role query is a real name or role defect.
- axe in e2e: `new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()` from `@axe-core/playwright`, asserting no violations in the touched region.
- Structure pin: `await expect(page.getByRole('dialog')).toMatchAriaSnapshot(...)` for names, roles and states.
- Keyboard: `await page.keyboard.press('Tab')` then `await expect(locator).toBeFocused()`; Escape closes and focus returns to the trigger.
- Media emulation: `page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' })` (forced-colors emulation support varies by browser; Chromium has it).
- Static rules: `bun run lint` or `npx eslint .` with jsx-a11y; Biome's a11y group.

## Proof-driven round (/uipolish, /a11yhunt, /uihunt)

Address one measurable WCAG 2.2 AA, keyboard/focus or layout defect per round.
Capture a deterministic rendered measurement or a failing component accessibility
test (with a passing control) before editing production code, repair the owning
primitive using the project's tokens and semantic markup, and promote the check
into the permanent test suite.

## Stop and ask

- The fix changes the visual system (focus ring style, palette, spacing) beyond what the owning primitive already allows.
- A conformance statement, VPAT or ACR is requested: report tested criteria and gaps; do not certify.
- The barrier lives in a third-party iframe or widget (payments, chat, maps, CAPTCHA) that cannot be changed in the repo.
- The only fix removes a feature or changes the authentication flow.

## Before returning

- [ ] Native elements used where they exist; any ARIA role has its full keyboard map and synced state
- [ ] Keyboard journey completed with Tab, Shift+Tab, Enter, Space, Escape and arrows; focus always visible and never obscured
- [ ] Every control has a name containing its visible label; errors linked by `aria-describedby`, status via a pre-mounted live region
- [ ] Focus moved deliberately after dialogs, deletions and route changes; returns to the trigger on close
- [ ] Rendered contrast 4.5:1 / 3:1 and 24×24 CSS px targets checked; 320 px reflow, forced colors and reduced motion checked where relevant
- [ ] Automated, keyboard and screen-reader results reported separately, with unperformed checks named
- [ ] A regression test (role query, axe scan or keyboard assertion) covers the fixed defect

## Sources

[WCAG 2.2](https://www.w3.org/TR/WCAG22/),
[target size minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html),
[ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/patterns/).

## Skills in scope

- design-system — accessible color contrast pairs, focus-ring tokens, and semantic component primitives.
- design-critique — rendered visual and WCAG 2.2 AA audit across desktop and mobile viewports.
- testing — semantic locator queries (`getByRole`, `getByLabelText`) and keyboard interaction regression tests.
- interaction-design — focus choreography, recovery states and feedback timing across a multi-step flow.
- webapp-testing — Playwright journeys that carry axe scans and keyboard assertions into CI.
