---
name: web-platform-baseline
description: |
  Use this skill before asserting that a CSS, HTML or accessibility capability is available, unavailable, or the right tool — it carries dated, refreshable platform facts and refuses to let stale knowledge be stated as current.
  Triggers: user says "container query", "can I use", "browser support", "modern CSS", ":has", "subgrid", "view transition", "popover", "dialog", "anchor positioning", "scroll-driven animation", "baseline", "polyfill", "is it supported", "fallback needed".
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: [skill, search, fetch]
optional-capabilities: [web.research]
trigger: "Use this skill before asserting that a CSS, HTML or accessibility capability is available, unavailable, or the right tool \u2014 it carries dated, refreshable platform facts and refuses to let stale knowledge be stated as current."
metadata:
  routing-group: frontend
---

# Web Platform Baseline — WrongStack

## Selection card
- Task: Choose compatible HTML, CSS and browser APIs.
- Start: Locate the affected route/component and its runtime/lockfile.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Why this exists

Two failure modes, both expensive:

1. **Stale caution** — writing a media-query ladder, a JS resize observer, or a
   z-index hack for something the platform has shipped for years. This is the
   most common source of dated-looking, over-engineered UI code.
2. **Stale confidence** — asserting support for something that is still behind
   a flag, or naming a syntax that changed during standardization.

Model training data guarantees both. This skill is the correction: every fact
lives in a dated reference file, and a fact past its shelf life may not be
asserted without a live check.

## The staleness rule — non-negotiable

Every reference file in this skill starts with a `verified:` date.

```
<!-- verified: 2026-09-16 | sources: MDN, web.dev Baseline, caniuse -->
```

Before you assert any fact from a reference:

| Age of `verified:` | What you may do |
|---|---|
| **≤ 90 days** | State it as current. Cite the file. |
| **> 90 days** | State it as *"as of <date>"*, and verify with `search` / `fetch` before it drives an architectural decision. |
| **> 180 days**, or the fact decides the architecture | Verify first, then answer. Update the reference file with the new date and the corrected fact. |

Never silently "refresh" a fact from memory. A date you cannot evidence is a
guess wearing a date.

**This has already happened once, in this file's own references.** The first
revision of `css.md` and `html.md` was written from model knowledge and stamped
with that day's date without a single live check. A later verification pass found
**7 of 14 tiers wrong** — anchor positioning, `text-box-trim` and `field-sizing`
were marked unavailable months after they had reached Baseline (the "stale
caution" failure, which makes code hand-roll what the platform already does),
while scroll-driven animations, `text-wrap: pretty` and the Popover API were
marked more available than they are (the "stale confidence" failure). So: when
you write a `verified:` date, the check must have happened in that turn, and the
sources must be named on the line. If you cannot verify a row, mark it
`UNVERIFIED` and say so rather than guessing a tier. The same rule applies to anything you remember about
framework defaults (Tailwind, React, the kit stacks) — those live in
`tech-stack` and `research-web`, and rot the same way.

When you do verify, use the primary sources in this order: **MDN** (syntax and
semantics), **web.dev Baseline** (availability tier), **caniuse** (version
detail), the **spec** (when behavior is genuinely contested). Two agreeing
sources minimum, per the `research-web` rules.

## What's in here

Load on demand — do not paste these into a plan wholesale:

Load these with the `skill` tool — `skill({ name: "web-platform-baseline", resource: "references/<file>.md" })`:

- `references/css.md` —
  layout, container queries, `:has()`, subgrid, nesting, `color-mix()`, OKLCH,
  `text-wrap`, cascade layers, scroll-driven animation, `@starting-style`,
  anchor positioning
- `references/html.md` —
  `<dialog>`, popover, `<details>` interop, form controls, `field-sizing`,
  lazy/priority hints, view transitions
- `references/a11y.md` —
  WCAG 2.2 additions, focus appearance, target size, `prefers-*` queries,
  accessible names, live regions

## Rules

1. **Never assert browser support from memory.** Cite a reference file (with
   its date) or verify live.
2. **Prefer the platform.** If CSS or HTML does it natively, a JS dependency is
   a regression. Reach for a library only when the native path is genuinely
   missing a capability the product needs — and say which one.
3. **Progressive enhancement over polyfill.** `@supports`, a sane fallback, and
   the modern path on top. Shipping a polyfill for a Baseline-available feature
   is dead weight.
4. **Availability tier, not a version list.** Say "Baseline widely available"
   or "Baseline newly available (needs a fallback)" — version tables age badly
   and users rarely need them.
5. **When the answer is "it depends on your support target", ask.** Do not
   assume evergreen-only, and do not assume enterprise IE-era constraints.
6. **Correct the file, not just the answer.** If you verify a fact and find the
   reference stale, update it and its `verified:` date in the same turn. A
   correction you don't write down will be re-derived from scratch next week.

## Applying it

The common wins, which the references cover in detail:

| Old reflex | Current platform |
|---|---|
| JS resize observer to restyle a component | container queries |
| Parent-state class toggling in JS | `:has()` |
| Nested grid hacks for alignment across cards | `subgrid` |
| Manual focus-trap library for a modal | `<dialog>` + `showModal()` |
| Positioned dropdown with a JS collision library | popover + anchor positioning |
| `scroll` listener driving an animation | scroll-driven animations |
| SASS just for nesting and variables | native nesting + custom properties |
| Ragged headline hand-fixed with `<br>` | `text-wrap: balance` |
| Hand-mixed hover/disabled color variants | `color-mix()` on the kit token |

Each of these makes the code both shorter and less generated-looking — the
hand-rolled version of a platform feature is itself a tell.

## Availability versus suitability

Verify the actual browser/device matrix and feature semantics. Baseline describes
interoperability, not the project's complete user population, accessibility
behavior or performance. Browser support, framework integration and required
fallback behavior are separate questions. Cite the specific feature/version
data; do not refresh an entire reference file's date after checking only one row.

## Acceptance checks

- Verify browser support, semantics, accessible behavior and necessary fallbacks.

## Skills in scope

- `design-craft` — the composition rules these capabilities serve
- `design-system` — kit tokens; platform features consume tokens, never literals
- `design-critique` — auditing an existing UI against current practice
- `research-web` — the verification workflow when a fact is stale
- `tech-stack` — framework/package version currency (the same rot, different layer)
