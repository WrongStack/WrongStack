---
name: design-reference-read
description: "Measure a reference site or screenshot into design DNA: color roles, type scale, spacing unit, radii, motion, layout and pattern ids. Use when asked to make something look like a site, use a URL or screenshot as reference or inspiration, extract a design system or tokens from a URL, reverse-engineer a site's styling, or explain why a design works; lessons go into the brief without copying the brand. Not for building and scoring the match (use design-to-code)."
version: 1.0.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [browser.interact, web.research, verification.run]
trigger: "Use when a URL or screenshot is supplied as a design reference to match, borrow from or analyze."
metadata:
  routing-group: design
---

# Design Reference Read — WrongStack

## Selection card
- Task: Turn a supplied reference (URL or screenshot) into measured design decisions and a 10-section `DESIGN.md` specification.
- Start: Classify the intent (match, borrow or analyze), then measure: `design_reference {action:"extract", url, viewports:[1440, 1280, 1024, 768, 375], maxPages:3}` for a URL, or the screenshot procedure for an image.
- Finish: `.design/references/<slug>/dna.md` and `.design/references/<slug>/DESIGN.md` read and cited, patterns named by id, lessons recorded in the brief, no brand assets copied.

## Overview

Looking at a screenshot and describing it ("clean, modern, lots of whitespace") is
where models differ most and where they invent most. Measuring it is not. This
skill replaces the description with numbers taken from the rendered page, so a
small model and a frontier model leave with the same facts, and the fidelity of
the result can later be scored against the same numbers.

## 1. Decide what the reference is for

Ask only if the request does not say which of these it is:

| Intent | What you take | What you leave |
|---|---|---|
| **Match** ("make it look exactly like this", a client's own site, a design handoff) | Measured values literally, per viewport | Nothing that the user owns or licensed |
| **Borrow** ("inspired by", "feel like") | Decisions: ratio, unit, density, rhythm, elevation strategy, motion timing, pattern ids | Exact palette, logo, imagery, copy, signature illustration, licensed fonts |
| **Analyze** ("why does this work") | The record plus the principles it shows | Implementation |

Borrowing a whole palette and font from a third-party brand is copying, not
borrowing. Change at least the primary hue and the display face unless the user
owns the reference.

## 2. Measure

With browser capability:

```
design_reference {action:"extract", url:"https://example.com", viewports:[1440, 1280, 1024, 768, 375], maxPages:3}
```

- It opens one isolated browser session per viewport under the same network
  policy as browser_open, scrolls the page, samples the visible color area,
  measures computed type/spacing/radius/shadow/motion/components/states/gradients,
  finds the section rhythm, takes a first-screen screenshot per width, and writes
  `.design/references/<slug>/{dna.md, dna.json, raw.json, DESIGN.md, <width>.png}`
  (`.design/` is self-ignored by git).
- `DESIGN.md` contains the full `designmd.me`-style YAML front matter (`colors`, `typography`, `rounded`, `spacing`, `borderWidths`, `shadows`, `themes`, `gradients`, `components`, `states`, `breakpoints`, `coverage`) plus the 10-section architectural prompt guide.
- Default viewports are `[1440, 1280, 1024, 768, 375]`. Pass `maxPages` (1–8) or `pages:[...]` to merge multiple subpages into `pagesAnalyzed`.
- A localhost or private address needs `/browser allow <origin>` first.
- The tool is hidden wherever outbound network is denied (restricted mode, a
  subagent without network capability): use the screenshot path below.

Without a browser, or for a supplied image: follow
`references/screenshot-measurement.md` and write the same record by hand,
marking every value `measured-from-image` and its pixel scale.

## 3. Read the record, then the screenshots

Open `dna.md`, then look at every `<width>.png`. The numbers cannot see imagery,
illustration style, copy voice or what the product shows, and the screenshots
cannot give you exact values. You need both.

Read in this order and write one line per item into your notes:

1. **Theme and roles** — bg, surface, fg, muted, primary, accent, border.
   `chromatic` share tells you how much color the page really uses; most strong
   references spend color on one action role and leave the rest neutral.
2. **Type** — families and which are loaded, body size/weight/line-height, the
   sizes in use, the inferred ratio, heading weight, display tracking. A ratio
   ≥ 1.33 with tight negative tracking reads editorial or bold; ≤ 1.25 with
   13–15px body reads dense product UI.
3. **Space** — the unit and how well it fits (`fits ≥ 80%` = a disciplined
   scale), section vertical padding, and the common values.
4. **Shape** — dominant radius, pill share, elevation style (`soft`, `hard`
   offset, `ring`, `none`), border width.
5. **Motion** — dominant duration and easing. Custom cubic-beziers are a
   deliberate decision worth borrowing; `ease` defaults are not.
6. **Layout per viewport** — container width, section count and the rhythm
   line (`height×columns[media side]`), the widest grid and whether it reflows,
   nav height and position.
7. **Declared tokens** — the site's own custom properties. When present they are
   the strongest evidence of intent; prefer them over inferred roles.
8. **Limits** — every note under "Limits of this measurement" is a caveat you
   must carry into the brief rather than smooth over.

Inferred values are labelled. Do not upgrade an inference into a fact in your
report ("the brand color is…") without saying it was inferred from buttons.

## 4. Name the patterns

Map the record's **Signals** line to pattern ids with
`references/signal-map.md`, then confirm each candidate against its
**Seen as** signals in the design-patterns catalog
(`skill({ name: "design-patterns", resource: "references/<file>.md" })`).
Name an id only when at least two of its signals are observed in the record or
the screenshots; otherwise write "resembles `<id>`" with the missing signal.
Never name a pattern from memory of the brand.

## 5. Extract the lessons

Write 3–7 lessons, each in this form, into `.design/brief.md` under References:

> `<slug>`: <decision> — evidence: <measured value> — apply as: <what changes in our surface>

Examples of the shape (values are illustrative, not from a real site):

- `acme-com`: one chromatic role only — evidence: chromatic 1% of area, primary
  on filled buttons — apply as: neutral surfaces, accent reserved for the primary action.
- `acme-com`: tight 4px rhythm — evidence: unit 4px fits 88%, section padding 96px —
  apply as: tune density to cozy, section spacing token 96px.

A lesson that has no measured evidence is a taste claim; keep it out or mark it
as an opinion.

## 6. Carry it into the build

- **Borrow:** pin the closest kit (`design {action:"list"}` → match its Best-for
  line to the lessons), then `tune` radius/density/motion toward the measured
  values. Leave the primary hue and display face your own.
- **Match:** pin the closest kit, then apply the `design {action:"set", …}` line
  the extract output printed. It scopes colors to the reference's theme and maps
  fonts, base size, radius ramp, duration and easing to Design Studio names.
  Run `design {action:"materialize"}`. Check font licensing before shipping a
  measured family; the overrides carry a generic fallback.
- Continue with the `design-craft` build loop. When matching, finish with the
  fidelity loop in `design-to-code` (`design_reference {action:"compare"}`).

## Acceptance checks

- [ ] `dna.md` and `DESIGN.md` exist for every cited reference page, with extraction date, `pagesAnalyzed`, and viewports (`1440`, `1280`, `1024`, `768`, `375`) recorded in `.design/brief.md`.
- [ ] Every cited measurement comes directly from `dna.md` / `DESIGN.md` or is explicitly labeled `measured-from-image` with its pixel scale anchor.
- [ ] Layout and section patterns are named by canonical `design-patterns` ids backed by at least two observed signals each.
- [ ] Extracted lessons follow the `<slug>: <decision> — evidence: <measured value> — apply as: <change>` format without vague adjectives.
- [ ] When intent is **Borrow**, the primary hue, display typeface, logo, imagery, and copy remain original to our product.
- [ ] Measurement caveats from `dna.md` ("Limits of this measurement") and `DESIGN.md` ("10. Known Gaps") are carried into the brief wherever they affect design decisions.

## Failure modes

| Failure | Correction |
|---|---|
| Describing the screenshot instead of measuring | Run extract, or measure the image per the reference file |
| Treating the first screen as the page | The record samples up to 8 screens; read the rhythm line |
| One viewport only | Measure across the 5-breakpoint matrix (`1440` down to `375px`); reflow is half of a layout |
| Copying the palette for "inspired by" | Borrow ratios and strategy, not hues |
| Trusting a declared font that never loaded | Check `loaded`; the notes say when it is uncertain |
| Naming bento/glass/brutalism from one cue | Two observed signals or "resembles" |

## Skills in scope

- `design-patterns` — map measured layout and section signals to canonical pattern ids and invariant anatomy checks.
- `design-craft` — carry extracted lessons and brief decisions into the build and visual verification loop.
- `design-system` — translate measured color roles, type scales, spacing units and radii into project tokens.
- `design-to-code` — run iterative reference comparison when the intent is an exact visual match.
