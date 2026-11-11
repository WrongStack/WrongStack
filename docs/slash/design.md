# /design — Design Studio

Browse and pin a **curated UI design kit** for the current session. Design Studio
gives the model selectable, production-grade design directions (aesthetic + concrete
OKLCH tokens + per-stack guidance) instead of leaving UI styling to chance.

## How it works

Design Studio activates automatically when the model is building a UI:

1. **Detection** — a per-turn middleware watches your messages (e.g. "build a landing
   page", "a Flutter screen") and frontend file writes (`.tsx`, `.css`, `.dart`,
   `.swift`, …) and flags the session as doing UI work, inferring the target stack.
2. **Menu injection** — while no kit is chosen, every request carries a compact menu of
   kits plus the non-negotiable baseline (responsive, light/dark, WCAG AA, motion).
3. **Load on demand** — the model calls the `design` tool (`list` → `use <kit> --stack
   <stack>`) to pull the full, stack-specific spec into context, then implements it.
   Once a kit is active, the per-turn block shrinks to a one-line adherence reminder.

`/design` is the manual control over that flow.

## Usage

```
/design                       List available kits and the active one
/design <kit-id> [stack]      Pin a kit and load its full spec next turn
/design extract <url|file> [maxPages]   Measure a live site or local HTML into DESIGN.md + DNA
/design compare <ref> <url|file>        Score an implementation against an extracted reference
/design inspect <url|file>              Run rendered overflow/contrast/target-size gate
/design document [out]        Export the active kit or captured tokens as DESIGN.md
/design off                   Clear the active kit (detection stays on)
/design foundations           Print the mandatory baseline (responsive/a11y/theming/motion)
/design set <k=v> …           Override the active kit's colors/tokens
/design tune <k=v> …          High-level knobs (radius/density/font/motion)
/design swap <kit-id> [stack] Switch to a different kit, dropping old overrides
/design materialize [stack] [path]   Write the active kit's tokens to a real theme file
/design capture [files…]      Snapshot the project's own token source for kit-less verify
/design verify                Scan UI files for off-palette colors
```

Stacks: `web` · `react-native` · `flutter` · `swiftui` · `compose`.

### Examples

```
/design                     # see the menu
/design extract https://stripe.com 6
/design compare stripe-com index.html
/design inspect index.html
/design minimal-clarity web
/design set primary=oklch(62% 0.2 25) dark.bg=#111
/design materialize web src/styles/tokens.css
/design document
/design verify
/design off
```

## Extracting a live site into `DESIGN.md` (`/design extract`)

`/design extract <url|file> [maxPages]` routes to `design_reference {action:"extract"}` across the 5-breakpoint responsive matrix (`1440`, `1280`, `1024`, `768`, `375`) and optionally crawls up to `maxPages` (`1`–`8`) same-origin subpages. It writes `.design/references/<slug>/{DESIGN.md, dna.json, dna.md, raw.json, <width>.png}` — including the full YAML frontmatter (`colors`, `typography`, `rounded`, `spacing`, `shadows`, `themes`, `gradients`, `components`, `states`, `breakpoints`, `coverage`) and 10-section Agent Prompt specification.

See the [Design DNA & DESIGN.md Synthesis Engine guide](../design-dna-engine.md) for the complete schema, programmatic API, and fidelity comparison workflow.

## Enforcing a kit — overrides, materialize, verify

A pinned kit is strong guidance (its full spec + exact tokens ride every turn),
but the model can still drift. Three tools make adherence concrete:

- **`set`** records structured color/token overrides into `.design/active.json`.
  A bare key (`primary`) applies to both themes; a `light.`/`dark.` prefix scopes
  it to one theme. Overrides win over the kit's `tokens.json` everywhere.
- **`materialize`** writes the active kit's (override-applied) tokens to a real,
  stack-appropriate theme file — **web** `globals.css` (`:root` / `.dark` CSS
  variables + a Tailwind v4 `@theme inline` block, OKLCH kept verbatim), **React
  Native** `theme.ts` (hex), **Flutter / SwiftUI / Compose** color constants
  (OKLCH converted to sRGB). Import that file and the palette becomes the
  codebase's source of truth, not just a prompt hint — the real guarantee.
- **`verify`** scans UI files for off-palette hardcoded colors and generic
  Tailwind palette utilities (`bg-blue-500`), reporting an adherence score and
  the offending lines so you (or the model) can fix the drift.

The same three actions are available to the model via the `design` tool
(`{action:"set"|"materialize"|"verify"}`) and in the WebUI gallery (per-theme
color pickers + a **Materialize** button).

## Kit-less verify — `capture` (`/design capture` + the design tool)

Most sessions edit a codebase that already HAS a token system — a shadcn-style
`:root`/`@theme` CSS file, a `theme.ts`, or Dart `ColorScheme` constants — and
no kit. `/design capture [files…]` (or `design {action:"capture"}`) snapshots
those tokens into
`.design/captured-tokens.json` (values normalized to hex/OKLCH), after which
`design {action:"verify"}` **and the automatic write-time drift check** run
against the project's OWN tokens while no kit is pinned:

```
design {action:"capture"}                                  # conventional-path or DESIGN.md discovery
design {action:"capture", files:["DESIGN.md"]}             # explicit DESIGN.md or CSS source
design {action:"materialize", stack:"web", out:"src/styles/tokens.css"}  # compile captured tokens without a kit
design {action:"verify"}                                   # pinned kit, else the capture
```

`/design materialize` and `design {action:"materialize"}` also work **without a pinned kit** once `/design capture` has snapshotted a `DESIGN.md` (or existing CSS/Tailwind theme) into `.design/captured-tokens.json` — turning an extracted `DESIGN.md` directly into `:root` / `.dark` + Tailwind v4 `@theme` tokens (or React Native, Flutter, SwiftUI, Compose theme files).

Precedence: a pinned kit always wins; if a pinned kit's tokens are unreadable,
verify reports nothing rather than silently switching basis. Capture is
line-based best-effort — unparsable values (fonts, lengths, gradients) are
skipped and reported, never guessed — so re-run it when the token source
changes. If the token source redefines the stock shadow utilities
(`--shadow-sm`…`--shadow-2xl`) in an `@theme` block, capture records them and
`verify` stops flagging `shadow-*` utilities as stock elevation — in such
projects those utilities are token-driven, not drift.

**Automatic check:** once a kit is pinned, every write/edit to a frontend file
is scanned in the background — if it introduces off-palette colors, a short
warning is appended to that tool's result so the model self-corrects on the next
  turn. The check also reports spacing, radius, type and composition signals;
  these are source heuristics, not a visual quality or accessibility verdict.
  Composition matches need review against the product brief: consistent rows,
  symmetry and equal cards may be exactly right for the task.

## Bundled kits

**53 curated kits** ship bundled — run `/design` (or open the WebUI gallery) to
browse them all. A sampling across the range:

- **Product / UI:** `minimal-clarity`, `linear-dark`, `dark-pro`, `corporate-trust`,
  `bento-dashboard`, `notion-docs`, `soft-glass`.
- **Expressive / playful:** `dopamine-pop`, `playful-rounded`, `aurora-gradient`,
  `pastel-dream`, `kids-bright`, `vaporwave`.
- **Editorial / graphic:** `editorial`, `swiss-grid`, `grid-poster`, `monochrome`,
  `luxury-serif`, `newspaper-print`, `dark-academia`.
- **Bold / retro / themed:** `neo-brutalist`, `cyberpunk-neon`, `retro-terminal`,
  `retro-70s`, `nordic-noir`, `liquid-metal`, `solarpunk`, `warm-organic`.
- **Native:** `ios-native`, `material-expressive`.

## Live preview gallery (WebUI)

The WebUI Design Studio panel has a **Gallery** button that opens a full-page
grid where every kit is rendered as a live light + dark mini-UI from its own
`tokens.json` — so you can *see* each kit, search by name/tag, pick a target
stack, and **Use** it to pin the live agent. (No code or model call needed to
preview — it's styled entirely from the token snapshots.)

## Adding your own kits

Drop a kit folder next to the bundled ones — discovery order (first wins):

1. `<project>/.wrongstack/design-kits/<id>/` (committed, shared with your team)
2. `~/.wrongstack/profiles/<name>/design-kits/<id>/` (profile)
3. bundled (`@wrongstack/core/design-kits/`)

Each kit folder contains:

- `KIT.md` — YAML frontmatter (`id`, `name`, `aesthetic`, `tags`, `stacks`, `themes`,
  `bestFor`) + the design spec body. Stack-specific guidance lives under
  `## Stack: <stack-id>` headings (narrowed when a stack is requested).
- `tokens.json` — `{ "light": {…}, "dark": {…} }` OKLCH token snapshots (also used by
  the WebUI/TUI visual pickers).

The reserved id `_foundations` holds the mandatory baseline and is excluded from the menu.
Malformed kit folders (a missing `name`, or a `stacks:` list with no valid stack) are reported
with a reason in `design list` and when the `/design` picker loads — instead of silently
disappearing.

## Project-local decisions & rules — `.design/`

Separate from the committed `.wrongstack/design-kits/` (shared custom kits), a
**gitignored** `<project>/.design/` directory holds your project-local design
state. It self-ignores (a `.design/.gitignore` of `*` is written on first use),
so it stays out of the repo in any project.

| File | Purpose |
|---|---|
| `.design/rules.md` | Project design rules. Refreshed from disk on every UI turn and **override kit defaults on conflict** (e.g. brand colors, spacing system, banned patterns). Additions, edits and deletions take effect in the same session. |
| `.design/active.json` | The pinned kit (`{ kit, stack }`). Written when you pick a kit; **restored on the next session** so a design direction persists. |
| `.design/decisions.md` | Append-only log of kit choices: `- <iso> · kit=… stack=… via=tool\|webui\|slash`. |
| `.design/brief.md` | Product task, content hierarchy, visual direction, references and acceptance checks. Written by the design workflow; the first 6,000 bytes are refreshed in each active UI request, including after a kit change. Longer briefs include an explicit truncation notice. |
| `.design/review.md` | Workflow-authored evidence of rendered review: route/artifact, viewport, theme, state, corrections and unverified checks. Not automatically generated or treated as proof by the scanner. |
| `.design/captured-tokens.json` | The project's own token snapshot (`design {action:"capture"}`) — the verify basis when no kit is pinned. |
| `.design/references/<slug>/DESIGN.md` | Full 10-section `DESIGN.md` specification + YAML token frontmatter synthesized by `/design extract` (`design_reference {action:"extract"}`). |
| `.design/references/<slug>/dna.json` | Structured `DesignDna` record, raw viewport measurements (`raw.json`), screenshots (`<width>.png`), and `compare` fidelity scores (`fidelity.md`). |

Picking a kit (via the `design` tool, `/design <kit>`, or the WebUI panel)
records the choice; `/design off` clears the pin (the decision log is kept).

## From a kit to a considered design

See the [implementation audit](../design-quality-workflow.md) for the inspected
flow, corrected failure modes and remaining evaluation limits.

For substantial UI work, Design Studio now reminds the agent to use
`design-craft` and `design-critique` even after a kit has been selected. The
workflow starts from the audience, primary task and real content, records a
brief, implements the design, inspects rendered behavior and corrects visible
problems. Originality comes from the product's content and interaction, not a
prescribed number of cards, accents or asymmetric sections.

Existing applications keep their own component and token systems by default.
A kit is useful for a new system or an explicitly requested migration; it is
not required just to obtain a scanner score. Small changes reuse established
patterns without a new design ceremony.

`verify` percentages describe detected color signals only. No signals can also
produce 100%; comments do not count as coverage. The automatic walk is bounded
to 200 files and depth 8, so this is not exhaustive project certification.
Use explicit files for targeted review. Native themes, dynamic classes,
keyboard behavior, responsive layout and visual identity need separate review.
Do not claim rendered checks unless they were actually performed.

Web materialization gives canonical scale tokens precedence over legacy
aliases such as `fontSans`, so a tuned font is not shadowed by the old font in
`:root` or `.dark`. React Native themes preserve canonical font tokens under
camelCase keys such as `fontSans` and `fontDisplay`. Font assets must still be
loaded and mapped to the platform's registered families by the application.
