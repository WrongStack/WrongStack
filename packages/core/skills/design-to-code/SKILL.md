---
name: design-to-code
description: "Build a Figma design, screenshot, mockup or live site as working UI and prove the match with measured per-axis fidelity scores. Use when matching a reference or handling design handoff (Figma frames, PNG mockups, a written spec, a URL whose look must be reproduced); preserve its layout, content and interaction intent. Not for measuring a reference without building (use design-reference-read) or inventing a new direction (use design-craft)."
trigger: "Use when a supplied design or reference must be implemented and its visual fidelity proven, not eyeballed."
version: 2.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research, browser.interact]
metadata:
  routing-group: design
  domain: "design"
---

# Design To Code — WrongStack

"Looks close" is the claim every model makes and the one nobody can check. Here
the reference and the implementation are measured by the same script, and the
difference is a table of numbers with tolerances. Implementation is finished
when the lowest axis is within tolerance or its remaining gap is a recorded,
justified adaptation.

## Selection card
- Task: Implement a supplied design or reference and prove fidelity.
- Start: Open the reference (URL extract, image record or Figma frames), record its viewports and match-or-adapt per region in `.design/brief.md`, and list the project's existing tokens.
- Finish: the last `fidelity.md` has every axis ≥ 0.9 for a literal match (≥ 0.75 for an authorized adaptation) or a recorded adaptation, screenshots were compared per width, and keyboard and state checks passed.

## 1. Get a measurable reference

| Reference | First step |
|---|---|
| Live URL | `design_reference {action:"extract", url, viewports:[1440, 768, 390]}` (see design-reference-read) |
| Screenshot / mockup image | design-reference-read `references/screenshot-measurement.md`; record the scale anchor |
| Figma file | Use an available Figma integration to read frame sizes, styles and variables. Without one, ask for an export; never claim to have inspected an inaccessible file |
| Written spec | Turn each stated value into a token; list unspecified values as assumptions |

Record in `.design/brief.md`: the reference, its viewport(s), match vs adapt
per region, and what the user owns or licensed (fonts, imagery, copy).

## 2. Map before you build

1. Tokens first. Map the reference's roles and scales onto the project's tokens
   or a pinned kit: the extract output prints a `design {action:"set", …}` line
   that does this mapping for Design Studio. Never paste per-element hex/px
   values when a role exists.
2. Components second. Map each visual element to a semantic component
   (button, link, tab, dialog, table row). A screenshot does not reveal keyboard
   behavior, focus order or data contracts — decide them explicitly.
3. Name the layout patterns by design-patterns id per region; that fixes the
   invariants you must keep while adapting.
4. Fonts and assets: verify the licence and the loaded weights. A substitute
   font changes line breaks and heights — record the substitution, then expect
   the type axis to show it.

Figma values do not copy one-to-one:
- Auto layout is flexbox: spacing becomes `gap`, padding stays padding, "hug" is
  content-sized, "fill" is `flex: 1` (or `align-self: stretch` on the cross axis).
- Letter spacing in % is em/100 (−2% → `-0.02em`); a percentage line height is a
  unitless multiplier (150% → 1.5); "Auto" follows the font's own metrics.
- Variables and styles map to tokens; a frame's fixed width is one breakpoint,
  not the layout — read its constraints before hard-coding widths.
- Export icons and illustrations as SVG from the source component, not from a
  flattened frame, then apply design-assets hygiene.

## 3. Build in this order

Structure and content → type and spacing → color and assets → states and
interaction → motion. Use real or representative content of the reference's
lengths; the section heights in the rhythm line depend on it.

## 4. Fidelity loop (the part that makes this model-independent)

Serve the implementation (a localhost dev server needs `/browser allow <origin>`) and run:

```
design_reference {action:"compare", reference:"<slug>", url:"http://localhost:5173/"}
```

It measures the implementation at the reference's viewports and writes
`.design/references/<slug>/fidelity.md`: a score per axis, the overall score
(= the LOWEST axis), and every property outside tolerance.

Tolerances used by the tool:

| Axis | Property | Match | Near |
|---|---|---|---|
| color | each role (bg, surface, fg, muted, primary, accent, border) | OKLab ΔE ≤ 0.02 | ≤ 0.04 |
| type | families; body size; line-height; scale ratio; largest size | same family; ±0.5px; ±0.05; ±0.04; ±4% | double |
| space | spacing unit; shared values; section padding | equal; ≥ 75% shared; ±15% | ≥ 50%; ±30% |
| shape | dominant radius; elevation style; primary button height | ±1px; same; ±2px | double |
| layout | container; widest grid columns; section count; nav position — per viewport | ±4%; equal; equal; same | ±8%; ±1; ±1 |
| motion | dominant duration; easing | ±25%; same | ±50% |

Loop:

1. Fix the lowest axis first, by changing tokens/components, not by adding
   one-off overrides.
2. Re-run compare. Stop when every axis is ≥ 0.9 for a literal match (≥ 0.75 for
   an authorized adaptation), or when the remaining findings are recorded
   adaptations.
3. Compare the screenshots side by side at each width. Measurement cannot see
   imagery, crop, icon style or copy; screenshots cannot see exact values.
4. Three rounds without improvement on an axis means the mapping is wrong
   (wrong role, wrong font, wrong pattern) — re-read the reference record.

Without a browser, compare by hand against the image record and say the
fidelity is unmeasured.

## 5. What fidelity does not cover

Exercise the main task, keyboard flow, focus visibility, and loading, empty,
error and disabled states the reference may not show. Check long content and a
short viewport. Run `design {action:"verify"}` for token drift and the
`accessibility` skill for interaction checks. A 100% fidelity score with a broken
form is not done.

## Acceptance checks

- [ ] Reference access, viewports, and literal-match vs. adaptation decisions are recorded in `.design/brief.md`.
- [ ] `fidelity.md` exists from the final comparison round with its overall score and lowest axis reported.
- [ ] Every remaining `off` or `near` property is either resolved via tokens/components or documented as a justified adaptation.
- [ ] Reference and implementation screenshots were compared side by side at each target viewport (`1440`, `768`, `390`).
- [ ] Font and asset substitutions and licenses are explicitly recorded.
- [ ] Interactive flows, keyboard navigation, focus states, and loading/empty/error states were exercised beyond static visual fidelity.

## Skills in scope

- `design-reference-read` — extracting measured design DNA and scale anchors from the reference URL or image
- `design-system` — mapping measured roles and scales onto project tokens or a Design Studio kit
- `design-patterns` — preserving regional layout anatomy and responsive invariants during implementation
- `design-critique` — auditing rendered visual hierarchy and state completeness beyond automated fidelity scores
- `interaction-design` — keyboard operability, focus choreography, and state feedback not visible in static mockups
- `accessibility` — WCAG 2.2 contrast, target sizes, and semantic ARIA verification
