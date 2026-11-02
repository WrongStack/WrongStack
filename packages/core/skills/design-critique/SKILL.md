---
name: design-critique
description: "UI design review and critique: scored rubric for layout, typography, color, states, accessibility and copy, with a ranked fix list. Use when asked to review, critique or audit an existing screen or page, give design feedback, explain why a UI looks bad, generic, AI-generated or unprofessional, or say what is wrong with it. Not for building a new design (use design-craft) or code-level review (use code-review)."
version: 2.2.2
required-capabilities: [filesystem.read]
required-tools: [design, skill, read, grep]
optional-capabilities: [browser.interact, verification.run]
trigger: "Use when an existing screen, page or component needs a scored, evidenced design audit with ranked fixes."
metadata:
  routing-group: design
---

# Design Critique — WrongStack

## Selection card
- Task: Critique an existing interface with visual evidence.
- Start: Run `design {action:"list"}`, read `.design/brief.md` and `.design/rules.md`, and get a rendered view (served URL or supplied screenshot) with its viewport, theme and state.
- Finish: the report opens with a one-sentence verdict, scores adherence and craft separately, lists at most 10 ranked findings each with `file:line` or region@viewport and a replacement, and marks unverified axes.

## Overview

A design critique that says "it looks a bit generic, maybe add more spacing" is
worthless. This skill produces a **scored, evidenced, ranked** audit: each
finding names the file and line, the rule it breaks, and the concrete
replacement — the same standard a code review is held to.

Report two independent failure classes separately:
- **Adherence** — does the code use the kit's tokens? Machine-checkable.
- **Craft** — does the result look designed? Needs judgment, guided by a rubric.
A UI at 100% adherence with a failing craft score is the common case.

## Workflow

```
1. Establish ground truth   → active kit + brief
2. Machine pass             → design {action:"verify"} (source) + design_reference {action:"inspect", url} (rendered)
3. Craft pass               → rubric, six axes, evidence per finding
4. Score + rank             → what to fix first, what to ignore
5. Report                   → findings, not adjectives
```

### 1 — Ground truth

```
design {action:"list"}        # what is pinned
```

Read `.design/brief.md` with `read` if it exists — do not contradict a recorded
team decision unless that decision itself is the problem (say so once). Read
`.design/rules.md` for project overrides, and `grep` the UI source for token
usage to ground the adherence findings. Establish which adherence case applies:

| Case | What adherence means here |
|---|---|
| A kit is pinned | Run the machine pass and report its score as-is. |
| No kit, but the project **has its own design system** (`@theme` block, `:root` variables, theme constants) | Measure against **the project's own tokens**, not a kit, and look for literals that bypass it. Say which axis of *their* system (radius, spacing, type, motion, elevation) is missing. |
| No kit and no token layer | That is finding #1: the UI has no source of truth, and every color is a decision nobody can revisit. |

### 2 — Machine pass

```
design {action:"verify"}
design_reference {action:"inspect", url:"<served page>", surface:"page"|"app"}   # when the UI is served
```

`inspect` is the rendered half: overflow, text at the edge, WCAG contrast against
the background actually behind the text, WCAG 2.2 target size (with the spacing
exception), body size, line length, type-size and family counts, heading order,
headline wrap, broken/unsized media, text still invisible after load, blank
viewport bands, console errors and failed requests — at 1440/768/390. Cite each
finding id (`[a11y.text-contrast] @390`) instead of re-describing it, and spend
the craft pass on what it lists under "Not covered". Rank every FAIL above all
craft findings; an axis with an open FAIL cannot score above 2. Pick the
`surface` threshold (`page` or `app`) matching rule 9 below.

`verify` findings carry ids and severities too (`WARN [motion.transition-all]`,
`FAIL [a11y.icon-button-unlabeled]`); cite the id. A `design-ignore: <id>`
comment in the source is a recorded decision: judge whether its reason holds,
do not re-report the waived pattern as new.

**Check what the machine pass could actually see.** It reads utility classes and
CSS; a native-stack screen (react-native, flutter, swiftui, compose) has neither.
If verify reports files with no class/utility signal, report `Tokens: not
machine-checkable (native stack)` and inspect theme constants and spacing scale
directly. Never let a vacuous clean pass stand in as evidence.

Report the `design` verify breakdown by axis. Treat `composition` findings as craft
evidence, not token drift.

### 3 — Craft pass

Inspect a rendered screen or supplied image before making visual claims. Record
the route/artifact, viewport, theme and state. Source alone supports implementation
findings, not claims that a screen looks balanced, passes contrast or behaves
correctly. Mark missing evidence `unverified`, not `n/a`; omit the overall score
when an applicable axis lacks evidence. Do not invent screenshot observations.

Judge against the primary task and brief. Repeated rows, equal cards, symmetry,
a single font or a gradient can be appropriate; confirm the visible problem
before requesting a change. Classify the surface before scoring: for
page/app/component differences and kiosk-specific physical acceptance checks,
read [surface context](references/surface-context.md). Never score an axis that
does not apply to the surface — write `n/a (app screen)` and move on.

Score each remaining axis 0–5 against the rubric, loaded with the `skill` tool:

```
skill({ name: "design-critique", resource: "references/rubric.md" })
```

Never score from feel — each score cites at least one concrete observation.

| Axis | The question it answers |
|---|---|
| **Structure** | Is there a grid and a focal point, or an even mat of equal blocks? |
| **Typography** | Does hierarchy survive in greyscale? Is the measure controlled? |
| **Color** | Do semantic roles and visual emphasis support the task? Are supported themes deliberate and readable? |
| **Surface & depth** | One coherent elevation strategy, or borders+shadows stacked at random? |
| **States & edges** | Empty, loading, error, overflow, long strings — present or happy-path only? |
| **Copy & voice** | Domain-specific, or interchangeable marketing filler? |

Run the three cheap tests and report the result of each:
- **Greyscale** — remove color. Hierarchy intact?
- **Squint** — blur it. Is there one focal point per screenful?
- **Swap** — replace the product name throughout. Does the copy still make sense for a different product? If yes, the copy is filler.

### 4 — Score and rank

Overall = the *lowest* axis, not the average. Rank fixes by **visible impact per
unit of work**; structure fixes almost always outrank color fixes. Mark each
finding **Blocking** (ships as broken: a11y failure, unreadable contrast, missing
error state, horizontal scroll at 320px), **Craft** (why it reads as generated),
or **Nit** (genuinely optional).

### 5 — Report

Lead with the visible problem, then ranked findings with evidence and replacements.
Include surface/state/viewport, verified axes and unverified checks. For the full
report shape, read [report example](references/report-example.md).

## Rules

1. **Evidence or silence.** Every finding names file:line or a named screen region.
2. **Each finding ships its replacement.** Naming the flaw is half the work.
3. **Separate adherence from craft.** Never let a clean `verify` imply the design is good, and never report a craft opinion as a token violation.
4. **Verdict first, in one sentence.** The single biggest reason.
5. **Respect the requested outcome.** For an audit-only request, report findings. When improvements are already authorized, record the evidence, implement the ranked fixes and inspect again.
6. **Respect the brief.** Decisions already made are not findings unless they are the problem; say that once, don't re-litigate.
7. **No praise padding.** One line of what genuinely works, then the findings.
8. **Cap the list.** Top 10 by impact; state the count of the remainder.
9. **Classify the surface and the token situation before scoring.**
10. **File each finding against the file that owns it.** If a screen imports a primitive lacking a focus ring, the finding belongs to the primitive.

For precise finding wording and rejected vague comments, read [critique examples](references/critique-examples.md).

## Evidence quality and score limits

Use the current rendered state and actual content when scoring. Keep unsupported
axes unverified and avoid averaging them into a precise overall score. Contrast,
focus and input behavior require specific checks; a visually quiet screenshot
cannot prove them.

## Acceptance checks

- [ ] Surface type (`page`, `app screen`, `kiosk`, `component`) and token ground truth (pinned kit, custom token system, or none) were classified before scoring.
- [ ] Machine adherence (`verify` / `inspect`) and 0–5 craft rubric scores are reported separately, with `unverified` used whenever rendered evidence is unavailable.
- [ ] Every finding cites an exact `file:line` or rendered region/viewport id, explains user impact, and provides a concrete replacement.
- [ ] Findings are ranked by visible impact (`Blocking` > `Craft` > `Nit`), capped at the top 10, and respect prior `.design/brief.md` decisions.

## Skills in scope

- `design-craft` — the rules this rubric audits against; use it to do the fixing
- `design-system` — kit, tokens, and the machine adherence pass
- `web-platform-baseline` — before claiming a capability is unavailable
- `code-review` — when the findings are structural code problems, not design
- `output-standards` — `<nextsteps>` shape when handing the fix list back
