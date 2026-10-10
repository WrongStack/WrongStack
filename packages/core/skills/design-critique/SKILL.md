---
name: design-critique
description: |
  Use this skill to audit an interface that already exists and say precisely why it looks generated, templated, or unfinished — a scored rubric across composition, typography, color, states, accessibility and copy, ending in a ranked fix list.
  Triggers: user says "review the design", "critique this UI", "why does this look bad", "looks generic", "looks AI-generated", "design review", "audit the UI", "make this look professional", "what's wrong with this page", "design feedback".
version: 2.1.1
required-capabilities: [filesystem.read]
required-tools: [design, skill, read, grep]
optional-capabilities: [browser.interact, verification.run]
trigger: "Use this skill to audit an interface that already exists and say precisely why it looks generated, templated, or unfinished \u2014 a scored rubric across composition, typography, color, states, accessibility and copy, ending in a ranked fix list."
metadata:
  routing-group: design
---

# Design Critique — WrongStack

## Selection card
- Task: Critique an existing interface with visual evidence.
- Start: Identify the target surface, reference, user task and existing tokens.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

A design critique that says "it looks a bit generic, maybe add more spacing" is
worthless. This skill produces a **scored, evidenced, ranked** audit: each
finding names the file and line, the rule it breaks, and the concrete
replacement — the same standard a code review is held to.

Two independent failure classes, always reported separately:

- **Adherence** — does the code use the kit's tokens? Machine-checkable.
- **Craft** — does the result look designed? Needs judgment, guided by a rubric.

A UI at 100% adherence with a failing craft score is the common case, and
saying so plainly is the whole value of this skill.

## Workflow

```
1. Establish ground truth   → active kit + brief
2. Machine pass             → design {action:"verify"}
3. Craft pass               → rubric, six axes, evidence per finding
4. Score + rank             → what to fix first, what to ignore
5. Report                   → findings, not adjectives
```

### 1 — Ground truth

```
design {action:"list"}        # what is pinned
```

Read `.design/brief.md` with `read` if it exists — a critique that contradicts a decision
the team already made is noise, unless the decision itself is the problem (say
so explicitly, once). Read `.design/rules.md` for project overrides, and
`grep` the UI source for token usage to ground the adherence findings.

**Adherence means different things in three cases. Establish which one you are in
before reporting any percentage.**

| Case | What adherence means here |
|---|---|
| A kit is pinned | Run the machine pass and report its score as-is. |
| No kit, but the project **has its own design system** — a theme file, semantic CSS variables, a token layer | Measure against **the project's own tokens**, not a kit. Find the token source (`@theme` block, `:root` variables, theme constants), then look for literals that bypass it. A percentage produced by pinning an arbitrary kit is meaningless — do not report one. |
| No kit and no token layer | That is finding #1: the UI has no source of truth, and every color is a decision nobody can revisit. |

The middle case is the common one in a mature codebase, and mis-reporting it as
the third is how a critique loses the room: the team already built a system, and
being told they have none is simply wrong. Say instead which axis of *their*
system is missing — a kit carries radius, spacing, type, motion and elevation,
and a hand-rolled system is usually missing one of them.

### 2 — Machine pass

```
design {action:"verify"}
```

**Check what the machine pass could actually see.** It reads utility classes and
CSS; a native-stack screen (react-native, flutter, swiftui, compose) has neither,
so it returns a clean result on a file it never checked. If verify reports files
with no class/utility signal, say so in the report — `Tokens: not machine-checkable
(native stack)` — and carry the entire adherence judgement by reading the theme
constants and spacing scale yourself. Never let a vacuous clean pass stand in as
evidence.

Run `design` with `{action:"verify"}` and report the breakdown by axis. Treat `composition` findings as craft evidence,
not token drift — they are patterns that are token-clean and still generic.

### 3 — Craft pass

Inspect a rendered screen or supplied image before making visual claims. Record
the route/artifact, viewport, theme and state. Source alone supports implementation
findings, not claims that a screen looks balanced, passes contrast or behaves
correctly. Mark missing evidence `unverified`, not `n/a`; omit the overall score
when an applicable axis lacks evidence. Do not invent screenshot observations.

Judge against the primary task and brief. Repeated rows, equal cards, symmetry,
a single font or a gradient can be appropriate. A scanner match is a question
to investigate, not a verdict; confirm the visible problem before requesting a
change. Check whether a logo swap leaves an unrelated but equally plausible
product, and whether the interface uses the actual domain's content and workflow.

Classify the surface before scoring. For page/app/component differences and
kiosk-specific physical acceptance checks, read [surface context](references/surface-context.md).

Never score an axis that does not apply to the surface. Write `n/a (app screen)`
and move on — a fabricated 3/5 drags the overall score, which is the lowest
axis, and makes the whole report meaningless.

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
- **Swap** — replace the product name throughout. Does the copy still make
  sense for a different product? If yes, the copy is filler.

### 4 — Score and rank

Overall = the *lowest* axis, not the average. One broken axis is what people
see. Rank fixes by **visible impact per unit of work**; structure fixes almost
always outrank color fixes.

Mark each finding:

- **Blocking** — ships as broken (a11y failure, unreadable contrast, missing
  error state, horizontal scroll at 320px)
- **Craft** — the taste gap; why it reads as generated
- **Nit** — genuinely optional

### 5 — Report

Lead with the visible problem, then ranked findings with evidence and replacements.
Include surface/state/viewport, verified axes and unverified checks. For the full
report shape, read [report example](references/report-example.md).

## Rules

1. **Evidence or silence.** Every finding names file:line or a named screen
   region. No "the spacing feels off".
2. **Each finding ships its replacement.** Naming the flaw is half the work.
3. **Separate adherence from craft.** Never let a clean `verify` imply the
   design is good, and never report a craft opinion as a token violation.
4. **Verdict first, in one sentence.** The single biggest reason. If you cannot
   name one, you have not finished looking.
5. **Respect the requested outcome.** For an audit-only request, report findings.
   When improvements are already authorized, record the evidence, implement the
   ranked fixes and inspect again without asking for the same authorization.
6. **Respect the brief.** Decisions already made are not findings unless they
   are the problem; say that once, don't re-litigate.
7. **No praise padding.** One line of what genuinely works, then the findings.
8. **Cap the list.** Top 10 by impact; state the count of the remainder.
9. **Classify the surface and the token situation before scoring.** Scoring a
   dense table view against page rules, or reporting an adherence percentage
   against a kit the project never adopted, produces confident nonsense.
10. **File each finding against the file that owns it.** A screen with no focus
    ring may be importing a primitive that lacks one — the finding belongs to
    the primitive. Check before you blame the surface you happen to be reading.

For precise finding wording and rejected vague comments, read
[critique examples](references/critique-examples.md).

## Evidence quality and score limits

Use the current rendered state and actual content when scoring. Keep unsupported
axes unverified and avoid averaging them into a precise overall score.
Compare proposed fixes against the primary task, existing design decisions and
the user's accessibility needs. Contrast, focus and input behavior require
specific checks; a visually quiet screenshot cannot prove them.

## Acceptance checks

- Tie findings to a visible surface/state, source evidence and user consequence.

## Skills in scope

- `design-craft` — the rules this rubric audits against; use it to do the fixing
- `design-system` — kit, tokens, and the machine adherence pass
- `web-platform-baseline` — before claiming a capability is unavailable
- `code-review` — when the findings are structural code problems, not design
- `output-standards` — `<nextsteps>` shape when handing the fix list back
