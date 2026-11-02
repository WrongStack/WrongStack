---
name: visual-regression
description: "Screenshot and visual regression tests: Playwright toHaveScreenshot, Storybook or Vitest baselines, flaky diffs, masks, thresholds. Use when adding screenshot checks, reviewing a failing diff, stabilizing snapshots that flake across OS, fonts or animation, or investigating layout and theme regressions; never update a baseline just to turn CI green. Not for functional journey tests (use webapp-testing) or design taste review (use design-critique)."
trigger: "Use when a UI change needs pixel-level evidence, or a screenshot test fails, flakes or needs a new baseline."
version: 1.1.2
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: design
  domain: "design"
---

# Visual Regression

## Selection card
- Task: Catch unintended UI changes with deterministic screenshots and reviewed baselines.
- Start: Read `playwright.config.*` (projects, `snapshotPathTemplate`, `expect.toHaveScreenshot` defaults) or the Storybook visual setup, and find where baselines are generated: a developer OS or the CI container.
- Finish: the snapshot passes three consecutive runs in the CI-equivalent environment, every changed baseline was reviewed as actual, expected and diff, and the note says why each change is intended.

## Overview

A visual test is only as good as its determinism and review: pin what changes pixels without changing the product (fonts, DPR, time, data, animation), and review every baseline update.
Current checked targets: Playwright 1.64.1 and Storybook React 10.6.5 (2026-10-23). Refresh registry and browser/tool compatibility before installation.

## Rules

1. Generate and compare baselines in one environment — the CI Linux container, ideally the Playwright Docker image matching the installed version — never commit macOS or Windows baselines for a Linux run.
2. Pin viewport, `deviceScaleFactor`, browser, locale, timezone, color scheme, reduced motion, fonts, clock and fixture data.
3. Wait for readiness, not time: fonts loaded, images decoded, skeletons gone, network fixtures settled; then let the assertion run its own stability wait.
4. Scope the screenshot to the component or region under test; full-page shots fail on every unrelated change.
5. Hide or mask only content that is dynamic by nature (timestamps, avatars, video, ads) with a written reason; never mask the component under test.
6. Thresholds absorb antialiasing, not change: prefer a small `maxDiffPixels` to a percentage, which on a full page can hide a missing button.
7. Inspect actual, expected and diff for every changed snapshot before updating, then update only that test with `--update-snapshots=changed`.
8. Pair screenshots with behavioral and accessibility assertions; pixels prove neither focus order, names nor working handlers.

## First moves by situation

| Situation | First moves |
|---|---|
| New visual test | Pick 3–6 high-risk states; screenshot the component, not the page; set shared defaults in config; create the baseline in the container |
| Fails only in CI | The baseline came from another OS or font set; check the platform suffix in the file name and regenerate in the container |
| Flaky in the same environment | Read the diff: glyph edges → font not loaded or fallback; one moving region → animation, caret or clock; blank boxes → lazy images; shifted blocks → late data |
| Intended redesign | Update only the affected tests, review each diff, list them in the PR |
| Unintended change | Find the token or shared component change that caused it and fix the source |
| Dark mode or RTL regression | A project with `colorScheme: 'dark'` or `locale`/RTL fixtures, or `page.emulateMedia({ colorScheme: 'dark' })` per test |
| Storybook components | One story per state; the project's Chromatic, test-runner or Vitest browser setup; disable animations through story parameters |

## Patterns and pitfalls

- **Assertion defaults** — `toHaveScreenshot` disables CSS animations, hides the caret and uses `scale: 'css'` by default; it re-captures until two consecutive screenshots match, then compares.
- **Two different knobs** — `threshold` (default 0.2) is per-pixel color distance; `maxDiffPixels` and `maxDiffPixelRatio` count differing pixels. Loosening `threshold` hides color regressions.
- **Snapshot names** — the default path includes project and platform (`button-chromium-linux.png`); a local Windows run writes `-win32` files CI never reads. Change the layout with `snapshotPathTemplate`, not by renaming files.
- **Hide vs mask** — `stylePath` injects CSS during the capture (hide scrollbars, live timestamps, cursors) while keeping layout; `mask` paints a box over locators (`maskColor`). Both need a reason in the test.
- **Frozen time** — `await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'))` before navigation; relative times and countdowns otherwise drift.
- **Fonts** — self-host fonts for tests (remote font CDNs time out into fallback) and `await page.evaluate(() => document.fonts.ready)` after late font swaps.
- **Lazy images** — below-the-fold `loading="lazy"` images are blank in full-page shots; scroll them in or wait until `complete` and `naturalWidth > 0`.
- **DPR** — `deviceScaleFactor: 2` doubles pixels and changes antialiasing; fix it per project and never mix baselines across DPRs.
- **Random data** — seed generators and serve fixed fixtures with `page.route`; never screenshot live APIs.
- **Update modes** — no flag writes only missing baselines; bare `--update-snapshots` means `changed`; `all` rewrites passing ones too. Check the CLI reference for your version.
- **Vitest browser mode** — recent Vitest offers `expect.element(locator).toMatchScreenshot()` with the same determinism rules; check the docs for your version before adopting it.

## Workflow

1. Choose states: default, hover and focus-visible, error, empty, long text, dark, narrow (390) and desktop (1280–1440).
2. Make each deterministic: fixtures, clock, fonts, motion, viewport, DPR.
3. Write scoped assertions with named snapshots.
4. Generate baselines in the container and commit them with the test.
5. On failure open the report, read the diff, and classify it as noise, regression or intended change.
6. Fix the source or update narrowly, then rerun the visual project three times.

## Proof

- Run: `npx playwright test tests/visual --project=chromium`.
- Review: `npx playwright show-report` — failed snapshots attach expected, actual and diff with a slider.
- Container baselines: `docker run --rm --network host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v<installed-version>-noble npx playwright test tests/visual/button.spec.ts --update-snapshots=changed`.
- Flake check: `npx playwright test tests/visual --repeat-each=3`.
- Storybook: the project's configured visual script (Chromatic, test-runner or Vitest), never a newly added paid service without asking.

## Stop and ask

- More than a handful of baselines would change, or they belong to another team's components.
- The diff shows change outside the requested scope.
- The fix changes the CI image or browser version, which invalidates every baseline.
- A hosted visual-testing service or account would be added.

## Before returning

- [ ] Viewport, theme, font loading, clock, and animation state pinned deterministically
- [ ] Actual, expected, and diff images inspected for every modified snapshot
- [ ] Any masked locators or pixel thresholds justified and scoped narrowly
- [ ] Unintended visual regressions fixed in source rather than baked into updated baselines
- [ ] Behavioral and accessibility assertions verified alongside screenshot checks
- [ ] Baselines generated in the CI-equivalent environment; platform suffix matches CI
- [ ] Changed snapshots passed three consecutive runs

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Playwright snapshots](https://playwright.dev/docs/test-snapshots), [Storybook visual testing](https://storybook.js.org/docs/writing-tests/visual-testing).

## Skills in scope

- testing — combine visual snapshot assertions with behavioral and edge-case functional tests.
- design-critique — evaluate visual hierarchy, spacing rhythm, and token adherence when reviewing diffs.
- accessibility — verify focus indicators, contrast ratios, and zoom/reflow behavior alongside visual snapshots.
- webapp-testing — Playwright config, fixtures, network mocking and traces shared with the visual project.
