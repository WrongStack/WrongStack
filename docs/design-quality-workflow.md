# Design quality: implementation audit and workflow

This audit follows the implementation from kit selection to generated tokens,
per-turn model context, source verification and design skills. It does not claim
that a model prompt or a palette score can guarantee original visual output.

## Existing foundation

WrongStack ships 67 selectable kits (including 14 tactile Material kits with 3D
`paper/display/accent` axes and `[data-slot]` photo treatments) plus `_foundations`.
The loader resolves project, profile and bundled kits, merging shared scales under
each kit's own tokens. The `design` tool, `/design` command and WebUI share
materialization and verification. CLI and WebUI use the shared detection/request
middleware.

The existing building blocks were already substantial:

- Color, spacing, radius, typography, motion and elevation tokens; semantic tuning.
- Theme generation for web, React Native, Flutter, SwiftUI and Compose.
- Persisted kit selection and project rules under `.design/`.
- Design craft, critique and platform skills with supporting references.
- Source heuristics for token drift and common composition patterns.
- Bundled-kit checks covering token contracts and common text/background pairs.

Relevant implementation: `packages/core/src/execution/design-{kit-loader,detect,
materialize,project-store,verify}.ts`, `packages/tools/src/design.ts`, and
`packages/core/skills/design-{system,craft,critique}/`.

## Findings and changes

| Finding | Resulting behavior | Evidence |
| --- | --- | --- |
| A selected kit reduced model guidance to token adherence; the brief was not injected | Craft and rendered-review guidance remains active; current brief excerpt follows UI requests across kit changes | Request middleware regression tests exercise creation, revision, deletion and bounded excerpts |
| Rules were cached for the entire process, including an absent file | Rules added, edited or removed during a session affect the next UI request | Store regression reproduces missing rules after the initial empty lookup |
| Exact card, accent and asymmetry prescriptions could replace one template with another | Content priority, workflow, existing system and user direction determine composition; justified repetition remains valid | Revised craft, critique, rubric and reference guidance |
| Existing systems could trigger a demand to adopt a kit before editing | Preserve established tokens/components; the kit loop applies to new systems or requested migrations | Updated runtime guidance, system skill and UI-design instructions |
| A palette scan was described as evidence of adherence or default-generated appearance | Tool and middleware report source findings with explicit limits; composition requires contextual rendered review | Tool verification tests and revised summaries |
| Comment-only markup counted as scan coverage; CSS-variable spacing/radius was flagged as literal drift | Comment-only files count as no-signal; direct variable references are not called hardcoded literals | Failing then passing verifier regressions |
| Legacy font aliases and tuned canonical keys emitted conflicting web variables | Canonical scale values take precedence, avoiding stale unlayered root/dark font declarations | Tune-to-materialize regression with legacy and canonical tokens |
| React Native dropped canonical font tokens when separating numeric scales | Per-theme camelCase font fields preserve canonical values and tuning | Canonical-only and tuned-font materialization regressions |

## Operating contract

For substantial work: inspect the product and its existing system, write a brief,
build with representative content, inspect rendered states, rank the visible
problems, fix within scope and inspect again. The brief names the primary task,
content priority, design direction, actual references/assets and observable
acceptance checks. Fake social proof and invented reference observations are
not acceptable substitutes for product content.

For a small edit: match the established patterns and verify the affected states.
A new identity, kit migration or approval ceremony is not required.

Rendered evidence records route/artifact, viewport, theme and state. Test narrow
and short viewports when relevant, keyboard navigation, content extremes and
reachable empty/loading/error states. Use `.design/review.md` for the workflow's
evidence record. A source-only review must identify what remains unverified.

## Measured layer (2026-10-19)

Principle: prose proposes, code disposes. Anything a browser can measure is
measured by a fixed script with fixed thresholds, so every model receives the
same verdict; skills keep only what cannot be measured (direction, content,
copy voice) and cite rule ids instead of restating rules.

| Layer | Mechanism | Enforced by |
| --- | --- | --- |
| Source | `design verify`: token drift + generated-UI patterns, on every UI write | `design-verify.ts`, write middleware |
| Reference | `design_reference extract`: in-page script measures visible color area (point sampling with layer compositing), type scale/ratio, spacing unit, radii, elevation, full CSS gradients, 14+ component archetypes, `:hover`/`:focus`/`:active`/`:focus-visible` states, and declared tokens across 5 breakpoints (`1440/1280/1024/768/375`) and 1–8 pages → `.design/references/<slug>/{dna.md,DESIGN.md}` | `design-dna-extractor.ts`, `design-dna.ts`, `design-md.ts` |
| Fidelity | `design_reference compare`: per-axis score with tolerances (OKLab ΔE ≤ 0.02, ±0.5px body, ±4% container…); overall = lowest axis | `design-dna-compare.ts` |
| Rendered quality | `design_reference inspect`: reference-free FAIL/WARN gate — overflow, edge text, WCAG contrast against the background actually behind the text, WCAG 2.2 target size with the spacing exception, type counts, heading order, broken/unsized media, stuck-hidden text, blank bands, console errors | `design-inspect-extractor.ts`, `design-inspect.ts` |
| Structure | 62 patterns by stable id with anatomy, ranges and DNA signals | `design-patterns` skill |
| Process | read reference → choose pattern ids → build → verify → inspect (0 FAIL, ≤ 3 rounds) → compare when matching | `design-reference-read`, `design-craft`, `design-to-code`, `design-critique` |

Measurement is its own tool, `design_reference`, declaring `net.outbound`.
Capability gates are decided per tool before input is known, so `--restricted`,
subagent capability sets and auto-approve all see the network use, while
`design` keeps only `fs.write` and its offline token actions stay available.
Extraction runs under the browser tools' network guard and private-origin
allowlist, trust rules key on the URL, and reference screenshots stay in the
self-ignored `.design/` directory.

Calibration evidence: both scripts were run in Chromium against fixtures with
planted defects (every defect caught) and against four production sites. The
first inspect run over those sites produced false-positive classes that were
then removed one by one: screen-reader-only text, `aria-hidden` mock UI,
off-canvas carousel items, WCAG 2.5.8 spacing-exception targets,
scroll-triggered reveals, footer legal text, gradient-clipped text and text
over sibling media. DNA inference was corrected the same way: fg/primary on
dark sites, footer text dominating body size, and a half-height inverted band
flipping the theme.

Compared with the public design skills surveyed on 2026-10-19 (Anthropic
frontend-design, impeccable, taste-skill, ui-ux-pro-max, Vercel interface
guidelines, OneRedOak design-review, Stitch DESIGN.md, dembrandt): only
WrongStack scores an implementation against a measured reference per axis, and
checks adherence against a resolved kit. impeccable leads on catalog breadth and
edit-loop enforcement; taste-skill on dealt directions. None publishes an
evaluation.

Turn-end enforcement: the agent loop exposes a generic `beforeTurnEnd`
extension hook — a guard may return a steer instead of letting the model end
the turn, at most three times per run. The design turn gate uses it: it records
frontend writes and `design_reference` inspect results per run, and holds a
turn whose UI changed after the last inspect or whose last inspect still has
FAILs. It acts only when the inspect tool is available to that agent and a
served URL is known (an earlier inspect, or `.design/gate.json`
`{"url": …}`), or the run wrote a static `.html` page; otherwise it stays
silent. `{"mode": "off"}` disables it.

Static pages need no dev server: `design_reference` takes `file` (a
project-relative `.html`) instead of `url`, serves the project root on an
ephemeral 127.0.0.1 port for that one call, allows exactly that origin through
the browser guard while it runs (never written to the browser policy), and
closes both. The first evaluation pilot showed why: a model that wrote
`index.html` had nothing to inspect, so the rendered gate never ran, and it
named a dealt kit in prose without pinning it. The deal text now says that
naming a kit pins nothing.

Source rule catalogue: every `verify` finding has a stable id and a severity
(30 ids; FAIL only for definite accessibility defects such as an unlabeled
icon button or disabled zoom). Rules live in `design-verify-rules.ts`; each
candidate was run over the repository's 824 UI files first, and candidates
whose hits were mostly legitimate (outline removal inside a focus-within
wrapper, sub-12px text in dense UI, per-file reduced-motion with a global rule)
were rejected. An A/B run against the previous engine lost none of its 2055
findings and kept the palette score identical. Exceptions are waived in the
file with `design-ignore: <id>` (`-next-line`, `-file`; `*` for all).

DESIGN.md interchange (`google-labs-code/design.md` & `designmd.me` 10-section
format, alpha — see [Design DNA & DESIGN.md Synthesis Engine](design-dna-engine.md)):
`design document` writes the pinned kit with its overrides, or the captured
tokens, as a spec-ordered DESIGN.md (dark values as `dark-<role>` colors) and
lints it; `design capture` reads a project's DESIGN.md before inferring from
CSS/TS/Dart (supporting both classic `dark-<role>` keys and `designmd.me`
`canvas`/`ink`/`body` + `themes.dark` maps) and refuses one with lint errors
(broken references, duplicate keys or sections); `design_reference extract`
(or `/design extract <url> [maxPages]`) writes the measured reference as a
complete 10-section `DESIGN.md` beside its DNA record, including full CSS
gradients, component catalog with `{colors.*}`/`{rounded.*}`/`{typography.*}`
references, interaction states, 5-breakpoint matrix, and coverage telemetry.
A round trip keeps both themes.

Dealt direction: shown the whole catalogue, models keep choosing the same few
kits. Once a UI request activates Design Studio without a pinned kit, the
per-turn block shows three kits drawn by a seeded shuffle instead of the full
menu (`design deal` returns the same draw; `seed` reproduces a printed one,
`query` narrows the pool, `redeal` draws again). Kits chosen recently in any
project (`design-history.json` in the profile directory, last 50 choices; the
five most recent are left out) are not dealt. Pinning a kit outside the deal
requires a `reason`, recorded with the choice. The deal is kept for the session,
so the injected block is identical across turns and the prompt prefix stays
cacheable. Catalogues of three or fewer kits get the plain menu.

DESIGN.md diff and PRODUCT.md: `design diff` compares two DESIGN.md versions
(or one with the active kit) on parsed tokens, not text. FAIL marks a
text/background pair (`fg`/`bg`, `text`/`background`, every `on-X`/`X`, and
component text on background) that met AA 4.5:1 and no longer does in either
theme, or a component reference that stopped resolving; WARN marks removed
tokens/components and font-family changes; color edits report their OKLab ΔE
and say so when imperceptible (≤ 0.02). `PRODUCT.md` at the project root is
injected (3000-character excerpt) ahead of `.design/brief.md` on UI turns.

## Material kits, layout draws, Commons photos, and redesign guards (2026-11-13)

- **3D Coordinate Deal & Material Kits (`design-material.ts`):** Bundled kits expand to 67 (adding `atelier`, `cobalt`, `riso`, `dusk`, `kiln`, `almanac`, `terrazzo`, `vellum`, `furrow`, `wayfind`, `werkstatt`, `formwork`, `darkroom`, `overprint`). `design deal` spreads its 3 dealt candidates across `axes` (`paper` × `display` × `accent`) and ranks `query` terms by IDF so domain nouns outweigh generic adjectives.
- **Job-Native Page Anatomy (`design draw`):** `design {action:"draw", job, material}` deals a macrostructure, opening hero, navigation, section cadence, and footer tuned to `job` (`sell | subscribe | visit | try | read | hire | attend | compare`) and `material` (`photo | product | words`), rotating away from `.wrongstack/design-draws.json` and the active kit's `pictured` specimen.
- **Copyright-Safe `[data-slot]` Photography (`design photos`):** `design {action:"photos", query, orient}` searches 306 curated open-licensed Wikimedia Commons photographs (`packages/core/design-kits/photos.json`), aligns tone/temperature with the active kit's `axes`, rotates via `.wrongstack/design-photos.json`, and emits `<figure data-slot="...">` + `srcset` + `<p data-credits>` attribution paired with materialized `[data-slot]` CSS treatments.
- **Redesign Wiring Guard (`snapshot` / `kept`):** `design {action:"snapshot"}` captures routes, form inputs, `data-testid`s, and named handlers into `.design/before.json`; `design {action:"kept"}` verifies none were dropped during a restyle.
- **Two-Stage Fold Inspection & Waiver Escalation:** `design_reference {action:"inspect", stage:"hero"}` elevates `layout.hero-fold` to `FAIL` when the primary CTA drops below an 800px desktop fold, while full-page `inspect` checks `layout.hero-dead-band`, `layout.heading-proximity`, `layout.unbounded-ultrawide`, and `density.words-per-viewport`. Source rules waived `>= 3` times via `design-ignore: <id> -- <reason>` surface `houseStyleSuggestions` for promotion to `.design/rules.md`.
- **Evaluation Matrix (`design-eval.ts`):** Codifies 8 canonical benchmark briefs (including `b4-metric-temptation` zero-traction trap and `b7-same-kit-divergence`), a 6-axis + 5-gate 2-viewport vision judge rubric/parser, and `scoreDesignEvalCell`.

## Limits and follow-up evaluation

Validation for this change: 164 tests passed across 16 design, CLI, tool,
WebUI-session and skill-contract files; core/tools TypeScript checks and scoped
Biome checks passed. Regression cases were run failing before their fixes.
The full `bun run test` attempt was incomplete: a dependency refresh invalidated
the running Vitest worker module path. It also observed an intermediate skill
reference mismatch, corrected and verified in the final targeted run. This is
not a full-suite or release-check pass. No live model-output comparison or
browser/device design-quality benchmark was performed.

The verifier is a heuristic source scanner, not a browser or accessibility engine.
Its default walk stops at 200 UI files and depth 8. Dynamic classes, native theme
usage, actual font loading, computed contrast and interaction behavior are not
certified. A 100% color score can mean no color signals. Variable references are
not proof that the referenced variable is defined. Composition matches remain
review prompts; the scanner does not parse or enforce brief exceptions.

The native materializers are theme scaffolds, not complete platform component
systems. Font loading and platform family registration remain application work.

Behavioral evaluation of the revised instructions should compare rendered outputs
for the same task, model and content, without showing reviewers which instructions
produced which version. Include an existing dense console, a quiet transactional
form, an editorial page with real assets, and a reference-matching request. Judge
task clarity, content specificity, hierarchy, state completeness and fidelity;
do not score novelty by card counts or palette choice. Such a model-output
comparison has not been run as part of the source/test changes described here.
