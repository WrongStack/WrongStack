---
name: webapp-testing
description: "Verify, test, and debug frontend web applications using Playwright with headless browser automation, DOM reconnaissance, screenshot diffs, and server lifecycle management. Use when validating UI user journeys, reproducing frontend bugs, testing form interactions, or verifying responsive layouts."
version: 1.0.0
required-capabilities: [filesystem.read, filesystem.write, execution.shell]
required-tools: []
optional-capabilities: [browser.interact, verification.run, web.research]
trigger: "validating UI user journeys, reproducing frontend bugs, testing form interactions, or verifying responsive layouts."
metadata:
  routing-group: quality
---

# Web Application Testing — WrongStack

## Selection card
- Task: Automate, test, and verify web applications with Playwright.
- Start: Detect target application URL or local dev server command, and define the user flow.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Reliable web application testing moves beyond static markup checks to execute live browser runs.
Use Playwright (in TypeScript or Python) with explicit server lifecycle management to test
dynamic client-side state, form submissions, accessibility roles, visual fidelity, and network boundaries.

## The Reconnaissance-First Protocol

1. **Server Lifecycle Management**:
   - Check if the web server is already running on the target port (e.g. `http://localhost:3000`).
   - If not, spawn the dev server in the background and poll the health endpoint until HTTP 200 before launching browser tests.
2. **Reconnaissance Before Action**:
   - Navigate to the page and wait for `networkidle` or specific hydration indicators.
   - Inspect the live DOM or capture a diagnostic screenshot before guessing element selectors.
   - Favor resilient user-facing locators (`getByRole`, `getByLabel`, `getByText`) over brittle CSS classes.
3. **Execution & State Verification**:
   - Perform the interaction sequence (click, type, drag, select).
   - Assert expected DOM mutation, route transition, or API payload responses.
   - Capture final state screenshots for visual regression confirmation.

## Playwright TypeScript Workflow

```typescript
import { test, expect } from '@playwright/test';

test.describe('Checkout Flow Verification', () => {
  test('adds item to cart and advances to shipping step', async ({ page }) => {
    // 1. Navigate and wait for network stability
    await page.goto('http://localhost:3000/products/sample');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // 2. Interact via accessible role locators
    const addToCartButton = page.getByRole('button', { name: /add to cart/i });
    await expect(addToCartButton).toBeEnabled();
    await addToCartButton.click();

    // 3. Verify optimistic update & cart count badge
    const cartBadge = page.getByTestId('cart-count-badge');
    await expect(cartBadge).toHaveText('1');

    // 4. Navigate to cart and assert checkout button
    await page.getByRole('link', { name: /view cart/i }).click();
    await expect(page).toHaveURL(/.*\/cart/);
    await expect(page.getByRole('button', { name: /proceed to checkout/i })).toBeVisible();

    // 5. Capture visual evidence screenshot
    await page.screenshot({ path: '.temp_files/checkout-verified.png', fullPage: true });
  });
});
```

## Anti-Flakiness Rules

- **No Hardcoded Sleep Delays**: Never use `globalThis.setTimeout` or `page.waitForTimeout(5000)`. Always wait on semantic conditions: `page.waitForSelector`, `page.waitForResponse`, or auto-retrying `expect(locator).toBeVisible()`.
- **Clean State Isolation**: Use isolated browser contexts, clean cookies, or mock network fixtures for third-party payment/auth endpoints.
- **Console & Network Error Audits**: Listen to `page.on('console', msg => ...)` and `page.on('pageerror', err => ...)` to fail tests if uncaught JavaScript exceptions fire.

## Acceptance checks

- Test script executes cleanly and deterministically against the target web application.
- Resilient semantic locators (`getByRole`, `getByLabel`, `getByTestId`) are used exclusively.
- Zero arbitrary hardcoded sleep timers; assertions rely on auto-retrying locators.
- Visual screenshots and console logs are recorded as test artifacts.
