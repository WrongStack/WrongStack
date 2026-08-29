import { expect, test } from '@playwright/test';

/**
 * Composer reasoning-effort E2E — the per-session effort select sitting in
 * the composer toolbar next to the model chip (see
 * packages/webui/src/components/ChatInput/session-effort-select.tsx).
 *
 * Round-trip contract under test: picking a level writes the session-scoped
 * `reasoningEffort` pref through the paired trip (local zustand set +
 * `prefs.update` over the WS). It survives a page reload because the value
 * BOTH persists in localStorage AND comes back as the server's preference
 * snapshot for the tab — if either half of that round-trip drops the value,
 * the reloaded select no longer shows it and this spec fails.
 *
 * The select is hidden only when the active model documents
 * `effortSupported: false`; with an undocumented vocabulary (the typical
 * E2E placeholder model) it renders with the full canonical set led by
 * `auto`.
 */

/** The composer effort select — aria-label comes from
 * settings:agent.reasoningEffortLabel ("Reasoning effort" in en). */
const effortSelect = 'select[aria-label="Reasoning effort"]';

/** The composer textarea — present only in the chat-ready state. */
const composerInput = 'textarea';

test.describe('Composer reasoning effort', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('renders in the composer with auto leading the option set', async ({ page }) => {
    // Chat-ready gate: the composer (and this control) only exists once a
    // provider/model is configured. Fail loudly on the setup screen instead
    // of silently passing (see chat-input.spec.ts rationale).
    await expect(page.locator(composerInput).first()).toBeVisible({ timeout: 15_000 });

    const select = page.locator(effortSelect).first();
    await expect(select).toBeVisible({ timeout: 5_000 });

    const optionValues = await select
      .locator('option')
      .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value));
    expect(optionValues[0]).toBe('auto');
    expect(optionValues).toContain('low');
    expect(optionValues).toContain('max');
  });

  test('switching effort persists the session-scoped pref and survives a reload', async ({
    page,
  }) => {
    await expect(page.locator(composerInput).first()).toBeVisible({ timeout: 15_000 });
    // `.first()` keeps this pinned to the COMPOSER select even when another
    // select with the same aria-label (the QuickModelSwitcher modal) is in
    // the DOM; this spec never opens that modal.
    const select = page.locator(effortSelect).first();
    await expect(select).toBeVisible({ timeout: 5_000 });

    await select.selectOption('low');

    // Local half of the round-trip: the zustand persist wrote the pref.
    const stored = await page.evaluate(() => localStorage.getItem('wrongstack-local-prefs'));
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored as string) as { state?: { reasoningEffort?: string } };
    expect(parsed.state?.reasoningEffort).toBe('low');

    // Reload: boot rehydrates from localStorage while the server's preference
    // snapshot echoes the session-scoped value — the select must land on the
    // same level again.
    await page.reload();
    await page.waitForLoadState('networkidle');
    const reloaded = page.locator(effortSelect).first();
    await expect(reloaded).toBeVisible({ timeout: 15_000 });
    await expect(reloaded).toHaveValue('low', { timeout: 10_000 });
  });
});
