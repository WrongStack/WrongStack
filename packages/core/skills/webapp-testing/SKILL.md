---
name: webapp-testing
description: "Playwright e2e and browser tests: locators, web-first assertions, auth state, network mocks, traces, flaky tests, dev-server lifecycle. Use when writing or fixing browser journeys, reproducing a frontend bug in a real browser, debugging flaky or CI-only failures, or wiring playwright.config webServer, projects and storageState. Not for screenshot baselines (use visual-regression) or unit-level test design (use testing)."
version: 1.2.2
required-capabilities: [filesystem.read, filesystem.write, execution.shell]
required-tools: []
optional-capabilities: [browser.interact, verification.run, web.research]
trigger: "Use when a web UI must be driven in a real browser to prove a journey, reproduce a bug or fix a flaky e2e test."
metadata:
  routing-group: quality
paths: ["playwright.config.*"]
---

# Web Application Testing — WrongStack

## Selection card
- Task: Prove web UI behavior in a real browser with Playwright: journeys, bug reproductions and flaky-test fixes.
- Start: Read `playwright.config.*` (`baseURL`, `webServer`, projects, retries, trace) and one existing spec; confirm how the app starts and on which port.
- Finish: the spec passes against the real app started by `webServer`, survives `--repeat-each`, and a failure leaves a trace; the exact command and result are reported.

## Overview

Playwright tests are reliable when every wait is an assertion on user-visible state and every test owns its data: role locators, retrying web-first assertions, and a trace instead of a sleep.
Use Playwright (checked 2026-11-02: `@playwright/test` 1.64.1 and Vitest 5.1.0) with explicit server lifecycle management to test dynamic client-side state, form submissions, accessibility roles and network boundaries.

## Rules

1. Locate as a user does: `getByRole` with a name, then `getByLabel`, `getByPlaceholder`, `getByText`; `getByTestId` only when nothing user-facing is stable; no layout-bound CSS chains or XPath.
2. Assert with web-first assertions that retry (`await expect(locator).toHaveText('3')`); `expect(await locator.textContent())` reads once and races the UI.
3. Never wait on time: no `waitForTimeout`; `networkidle` and `page.waitForSelector` are discouraged — assert the visible outcome or await the specific response.
4. Start `page.waitForResponse(...)` before the action that triggers it and await it after; registering after the click misses fast responses.
5. Each test owns its state: a fresh context per test (the default), data created through the API in fixtures, unique per worker (`testInfo.parallelIndex`), nothing inherited from another test.
6. Log in once in a setup project and reuse `storageState`; only the login test logs in through the UI.
7. Mock only what you do not own (payments, third-party APIs) with `page.route`; keep your own backend real so the test proves the integration.
8. Keep evidence: `trace: 'on-first-retry'`, screenshot and video on failure, and fail on uncaught `pageerror` or unexpected console errors.

## First moves by situation

| Situation | First moves |
|---|---|
| New journey test | `npx playwright codegen http://localhost:3000` to discover locators, then rewrite as role locators and assertions with one `test.step` per phase |
| Reproduce a bug | Smallest spec reaching the failing step, asserting the correct behavior; watch it fail; keep the trace |
| Flaky test | `--repeat-each=20 --workers=4`, then open the trace: action before hydration, non-retrying assertion, shared data, animation or response race |
| Fails only in CI | Download the report and trace artifacts; compare viewport, timezone, locale, CPU and browser channel; reproduce in the Playwright Docker image |
| "strict mode violation: resolved to 2 elements" | Scope from a region (`page.getByRole('dialog').getByRole('button', { name: 'Save' })`) or `filter({ hasText })`; `.first()` hides the ambiguity |
| Click does nothing | Hydration not finished, or an overlay intercepts the pointer (the error names the intercepting element); assert a post-hydration marker or wrap the effect in `expect(...).toPass()` |
| Slow suite | `fullyParallel`, API-based setup, reused `storageState`, `--shard=1/4` in CI |
| Server never ready | `webServer.url` must return a ready status (2xx, 3xx or 400–403); check the command, port and `reuseExistingServer` |

## Patterns and pitfalls

- **Server lifecycle** — `webServer: { command: 'npm run dev', url: 'http://localhost:3000', reuseExistingServer: !process.env.CI, timeout: 120_000 }` plus `use: { baseURL }`, so specs call `page.goto('/cart')`.
- **Actionability** — `click()` waits for the element to be visible, stable, enabled and receiving events; `force: true` skips those checks and hides real bugs.
- **Non-DOM conditions** — `expect.poll(() => api.orderCount()).toBe(1)` for backend state; `toPass()` for a block that must eventually succeed.
- **Time** — `page.clock.install()` or `page.clock.setFixedTime(...)` for timers, countdowns and "today".
- **Mocks** — `await page.route('**/api/rates', (route) => route.fulfill({ json: { usd: 1 } }))`; `page.routeFromHAR` replays recorded traffic.
- **Events you must catch** — register `page.waitForEvent('download')`, `context.waitForEvent('page')` (new tab) or `page.waitForEvent('popup')` before the triggering click.
- **Frames and files** — `page.frameLocator('#checkout')` or `locator.contentFrame()` for iframes; `setInputFiles` for uploads.
- **Structure and keyboard** — `toMatchAriaSnapshot` pins roles and names; `page.keyboard.press('Tab')` plus `toBeFocused()` proves focus order.
- **Mobile** — projects using `devices[...]` presets; touch gestures need `hasTouch: true`.
- **CI guards** — `forbidOnly: !!process.env.CI`, `retries` only in CI, and a flaky-on-retry result treated as a defect to fix.

## Example

```typescript
import { expect, test } from '@playwright/test';

test('adds an item and opens checkout', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/products/sample'); // baseURL from config
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  const added = page.waitForResponse(
    (r) => r.url().includes('/api/cart') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /add to cart/i }).click();
  expect((await added).ok()).toBe(true);
  await expect(page.getByRole('status')).toHaveText(/1 item/);

  await page.getByRole('link', { name: /view cart/i }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByRole('button', { name: /checkout/i })).toBeEnabled();
  expect(errors).toEqual([]);
});
```

## Workflow

1. Check whether the server is already running; otherwise rely on `webServer` rather than a hand-started background process.
2. Reconnoiter: open the page (codegen, a browser snapshot or a trace) before guessing locators.
3. Write the journey with role locators, one assertion per meaningful state change and `test.step` boundaries.
4. Make data deterministic: API fixtures, `page.route` for third parties, fixed clock where time matters.
5. Run it, then `--repeat-each` to prove stability; read the trace for any failure.
6. Report the command, browser projects, pass/fail counts and remaining gaps.

## Proof

Prefer the project's own script (`bun run test:e2e`, `npm run e2e`); common commands:
- `npx playwright test tests/e2e/cart.spec.ts --project=chromium`
- `npx playwright test tests/e2e/cart.spec.ts --repeat-each=20 --workers=4` for flakiness
- `npx playwright test --last-failed` after a fix
- `npx playwright show-trace test-results/<test>/trace.zip` and `npx playwright show-report`
- `npx playwright test --ui` or `--debug` for interactive stepping
- `npx playwright install --with-deps chromium` when browsers are missing in CI

## Stop and ask

- The test would run against production or shared staging with real accounts, payments or emails.
- Making it pass needs skipping, `.fixme`, raised timeouts or more retries rather than a fix.
- Credentials, test accounts or third-party sandboxes are not available locally.
- The run would delete or mutate data that other people or tests rely on.

## Acceptance checks

- [ ] Test script executes cleanly and deterministically against the live target web application with proper server lifecycle management.
- [ ] Resilient semantic locators (`getByRole`, `getByLabel`, `getByTestId`) are used instead of brittle CSS/XPath chains.
- [ ] Zero arbitrary hardcoded sleep timers (`waitForTimeout`); assertions rely on web-first auto-retrying expectations.
- [ ] Uncaught page errors, console errors, and visual screenshots are asserted and recorded as verification evidence.
- [ ] Response waits registered before their triggering action; third-party calls mocked, own backend real
- [ ] Spec passed with `--repeat-each` and the exact command plus result reported

## Skills in scope

- testing — unit, integration, and behavioral regression test design
- visual-regression — deterministic screenshot baselines and Storybook visual checks
- accessibility — automated and keyboard-driven WCAG 2.2 verification
- debugging — root-causing a reproduced failure once the browser proof is red
