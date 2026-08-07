---
name: design-system
description: |
  Use this skill BEFORE writing or restyling ANY user-facing interface in
  WrongStack. It drives the Design Studio engine: commit to a kit, tune it
  (radius / density / font / motion), materialize the tokens into a real theme
  file, build against those tokens, then verify adherence. Trigger it whenever
  the user asks to build, redesign, restyle, "make it look better", or ship a
  UI, frontend, landing page, marketing site, dashboard, admin panel, settings
  screen, onboarding flow, component, modal, form, email template, mobile
  screen, or design system — and whenever Tailwind, shadcn/ui, React, Next.js,
  React Native, Flutter, SwiftUI, or Jetpack Compose styling, theming, colors,
  palette, dark mode, border-radius, spacing, elevation, shadows, typography,
  or fonts come up. Also trigger on softer phrasings that imply visual work:
  "make it look better", "clean up the layout", "it looks generic", "match our
  brand", "add dark mode". Trigger even when the user never says the word
  "design" — if the output has pixels, this skill runs first.
version: 2.0.0
required-capabilities: [filesystem.read, filesystem.write, documentation.author]
required-tools: [design]
optional-capabilities: [browser.interact]
---

# Design System Engine — WrongStack

## The contract

Default-framework UI is a failure, not a neutral starting point. Unstyled
shadcn, `bg-blue-500`, stock Bootstrap gray, or "I'll pick colors as I go" all
produce the same forgettable result and leave the codebase with no source of
truth.

WrongStack ships a Design Studio: 50+ curated kits, each a complete **design
system** — not a palette. Every kit carries its own radius scale, spacing
rhythm, type ramp, motion curves, and elevation steps. The job here is to
commit to ONE kit *before* any markup exists, push its tokens into a real file
the build reads, and then write UI that only ever references those tokens.

Tokens in a file beat design intentions in a prompt. That is the whole idea.

---

## The loop (never reorder; skip only explicit exceptions)

```
list → use → tune → materialize → BUILD → verify → fix drift
```

Steps 1–3 are cheap and happen before the first line of JSX/Dart/Swift. `tune`
is optional when the chosen kit already fits; otherwise keep the order intact.
If a UI file has already been written without a committed kit, stop, run the
loop, and restyle against the tokens rather than patching colors by hand.

---

## Step 1 — Commit to a kit

```
design {action:"list"}                      # browse available kits
design {action:"foundations"}               # read the stack-agnostic baseline
design {action:"use", kit:"<id>", stack:"web|react-native|flutter|swiftui|compose"}
```

`use` loads the kit's **full spec for that stack** — pass the right `stack` or
the materialized output will be the wrong shape.

| Target | `stack` |
|---|---|
| Next.js, Vite, Remix, any Tailwind v4 / shadcn web app | `web` |
| Expo / bare React Native | `react-native` |
| Flutter (any platform) | `flutter` |
| iOS native | `swiftui` |
| Android native | `compose` |

### Picking the kit

If the user pinned one with `/design <kit-id>`, that decision is final — use it
and move on. Otherwise:

1. Run `design {action:"list"}` and read the kit descriptions. Do not pick from
   memory; the roster changes.
2. Match the kit to the **product's tone**, not to personal taste. Useful
   signals to reason from: audience (consumer vs. operator vs. developer),
   information density (marketing page vs. data table), emotional register
   (playful, editorial, clinical, brutalist, corporate-trustworthy), and any
   brand assets the user already has.
3. If two or three kits genuinely fit, name them with a one-line rationale each
   and ask. A ten-second question beats a full rebuild.
4. If the user gives zero signal and does not want to choose, pick the kit that
   best fits the product archetype, **say which one and why in one sentence**,
   and continue. Silence is not permission to fall back to defaults.

To change kits later: `/design swap <kit-id>` — this drops the old overrides
deliberately, so re-apply any tuning that still matters afterward.

---

## Step 2 — Tune (optional, but prefer knobs over raw tokens)

```
design {action:"tune", tune:{ radius:"lg", density:"compact",
                              font:"Space Grotesk", motion:"snappy" }}
```

| Knob | Values | Use it when |
|---|---|---|
| `radius` | `none` `sm` `md` `lg` `xl` `full`, or a base length like `"1rem"` | The kit's roundness fights the product's tone |
| `density` | `compact` `cozy` `comfortable` | Scales the whole spacing rhythm — `compact` for dashboards and data tables, `comfortable` for marketing and mobile |
| `font` | any family name | Brand typeface, or the kit's face is unavailable |
| `motion` | `snappy` `smooth` `none` | Tool-like UI wants `snappy`; content sites want `smooth` |

Knobs rescale the *entire* system coherently. Setting individual tokens by hand
does not — a hand-edited radius leaves the other five steps of the scale
untouched and the result reads as sloppy rather than intentional.

For a genuinely specific color (brand primary, a mandated status color):

```
design {action:"set", set:{ primary:"oklch(62% 0.2 25)", "dark.bg":"#111" }}
```

Use the `design` tool's `set` action for the handful of values the brand actually dictates. Everything
else stays on the kit.

---

## Step 3 — Materialize

```
design {action:"materialize"}
design {action:"materialize", out:"src/theme/tokens.ts", force:true}
```

This writes the tuned tokens to a real theme file. Omit `out` for the conventional
path, pass `out` for a custom project-relative path, and use `force:true` only
when intentionally overwriting an existing file.

Default paths and output shapes:

- **web** → `src/styles/design-tokens.css`; CSS custom properties + a Tailwind v4 `@theme` block, in OKLCH
- **react-native** → `src/theme/design-tokens.ts`; TypeScript `lightTheme` / `darkTheme` constants + numeric `scale`
- **flutter** → `lib/theme/design_tokens.dart`; `AppColorsLight` / `AppColorsDark` classes + `AppScale`
- **swiftui** → `Theme/DesignTokens.swift`; `AppColorsLight` / `AppColorsDark` enums + `AppScale`
- **compose** → `ui/theme/DesignTokens.kt`; `AppColorsLight` / `AppColorsDark` objects + `AppScale`

Then, without exception:

1. **Import the generated file** into the app entry (global stylesheet / theme
   provider / `MaterialApp` theme / etc.). Unimported tokens enforce nothing.
2. **Read the generated file before writing UI.** It is the ground truth for
   which token names exist. Do not guess names from this document or from
   another project — use the ones actually in the file.
3. Re-run the `design` tool with the `materialize` action after any later `tune` or `set`, or the code and the
   tokens silently diverge.

---

## Step 4 — Build against the tokens

Because `materialize` maps the kit into `@theme`, the ordinary utilities now
resolve to the kit. Write plain, semantic utilities:

```html
<div class="bg-bg text-fg border border-border rounded-lg p-4 shadow-2">
  <h2 class="text-lg font-semibold">Title</h2>
  <p class="text-base text-muted-fg">Body copy.</p>
</div>
```

Confirm the exact names against the materialized file — the token vocabulary is
per-kit, and semantic slots (surface, muted, accent, destructive, ring…) vary.

### Drift — what it looks like and what to write instead

| Don't | Why it breaks | Do |
|---|---|---|
| `bg-blue-500`, `text-gray-700` | Framework palette, not the kit — and no dark variant | `bg-primary`, `text-muted-fg` |
| `#1f2937`, `oklch(...)` inline | Invisible to the theme; can't be re-tuned or swapped | `var(--color-bg)` or the matching semantic token |
| `rounded-[7px]`, `p-[13px]` | Off-scale value; breaks the rhythm everywhere it appears | nearest step: `rounded-lg`, `p-3` |
| `dark:bg-slate-900` hand-written | Two hardcoded themes instead of one token set | one token that already resolves per mode |
| `style={{ boxShadow: '0 2px 8px …' }}` | Bypasses the elevation scale | `shadow-2` |
| A one-off `<Button>` with custom classes | Divergence multiplies per screen | extend the shared component |

If a token you need genuinely does not exist, that is a signal to `set` or
`tune` it into the system — not to write a literal.

### Every interactive element ships its full state set

Default · hover · `:focus-visible` · active · disabled · loading. Every data
surface ships empty · loading · error · populated. A happy-path-only screen is
an unfinished screen, and skeletons/empty states are where hardcoded grays
sneak back in — use tokens there too.

---

## Step 5 — Verify

```
design {action:"verify"}
```

Scans for color / radius / spacing drift. Run it **before declaring the work
done**, and treat the output as a task list, not a report:

- Fix every flagged violation by swapping in the token — never by silencing.
- If the same violation keeps recurring, the system is missing a token: `tune`
  or `set` it, `materialize` again, then re-verify.
- Re-run until clean. A UI that ships with known drift teaches the rest of the
  codebase that drift is acceptable.

Auto-verify middleware also appends non-blocking warnings to write results
during editing — self-correct on the very next edit rather than batching them
up for the end.

---

## Non-negotiable foundations

These hold under every kit, at every density, on every stack. They are the
floor, not a style preference — no kit or user override lowers them.

- **Responsive, mobile-first.** Check 320 / 768 / 1024 / 1440. No horizontal
  scroll at any width. Touch targets ≥ 44px. Respect safe-area insets on native.
- **Light and dark from one token set.** Never a hardcoded color, ever.
- **WCAG 2.2 AA.** Semantic markup, exactly one `h1`, visible `:focus-visible`
  rings, 4.5:1 contrast on body text, every control labelled, and meaning never
  carried by color alone (pair it with an icon, text, or shape).
- **Motion respects `prefers-reduced-motion`.** Animate `transform` and
  `opacity`; avoid animating layout properties.
- **Real content, real edge cases.** Long strings, empty lists, failed requests,
  zero states, RTL if the product needs it.

Pull the complete baseline any time with `design {action:"foundations"}`.

---

## Stack notes

- **web** — Tailwind v4 `@theme`, OKLCH. shadcn/ui components inherit the kit
  once the theme file is imported; restyle its primitives at the token level
  rather than per-usage.
- **react-native** — no utility classes, so the discipline moves into the
  generated TypeScript `scale` export and `lightTheme` / `darkTheme` constants:
  spacing comes from `scale`, never a bare number literal; colors come from the
  theme constants, never an inline hex string. Safe-area insets and platform
  navigation conventions still apply on top of the kit.
- **flutter / swiftui / compose** — no utility classes, so the discipline moves
  into `AppScale` and the color constants: spacing comes from the scale, never a
  bare number literal; colors come from the constants, never a `Color(0xFF…)` /
  `UIColor` literal. Safe-area insets and platform navigation conventions still
  apply on top of the kit.

---

## Delegated / roster frontend work

The active kit, its overrides, and auto-verify-on-write follow into spawned
subagents through the shared `.design/active.json`. The subagent inherits the
pin, but not the judgment — when delegating UI work, state explicitly in the
brief: build against the token utilities, no literals, and run
`design {action:"verify"}` clean before returning. Spot-check what comes back.

---

## Precedence when instructions conflict

1. **Foundations** (accessibility, responsiveness, reduced motion) — never
   overridden, by anyone.
2. **Explicit instruction from the user in this conversation.**
3. **`.design/rules.md`** — project overrides, these win over kit defaults.
4. **Active kit + tuning** in `.design/active.json`.
5. **Kit defaults.**

Read `.design/rules.md` when it exists — it encodes decisions someone already
made and re-litigating them wastes everyone's time.

---

## Edge cases

- **Codebase already has a design system.** Don't bulldoze it. Ask whether to
  adopt it as the kit's override layer or migrate to a kit, and get an answer
  before writing.
- **User hands over brand colors or a Figma palette.** Still commit to a kit —
  the kit supplies radius, spacing, type, motion and elevation, which a palette
  does not. Layer the brand colors in with `set`.
- **A tiny one-line fix to existing styled UI.** Skip the ceremony, match the
  surrounding tokens, and don't introduce a literal.
- **User rejects the whole system** ("just use plain HTML"). Comply, but say
  once, briefly, what they're giving up. Don't argue twice.

---

## Before saying you're done

- Kit committed with the correct `stack`, and named to the user.
- `materialize` run *after* the final `tune`/`set`, and the file imported.
- Zero hardcoded colors, radii, or spacing anywhere in the diff.
- Light and dark both checked.
- Interactive states and empty/loading/error states present.
- Keyboard path works; focus rings visible.
- `design {action:"verify"}` clean.
