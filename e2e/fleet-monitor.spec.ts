import { expect, type Page, test } from '@playwright/test';

async function openFleetInspector(page: Page) {
  const drawer = page.getByTestId('inspector-drawer');
  // F2 reaches a `window` keydown listener bound in App.tsx's root effect,
  // and F1..F12 are deliberately skipped while a text field is focused
  // (useGlobalKeyboardShortcuts' `inField` guard) — the chat textarea
  // auto-focuses at boot. A single press right after networkidle therefore
  // races both: the listener may not be attached yet, or the textarea may
  // already hold focus and swallow the key. That lost press was the
  // intermittent "element(s) not found" CI failure. Wait for stable app
  // chrome, neutralize focus, and re-press once — setFleetMonitorOpen(true)
  // is an idempotent open (not a toggle), so a double press is safe.
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(page.locator('#main-content')).toBeVisible();
    await page.locator('body').focus();
    await page.keyboard.press('F2');
    try {
      await expect(drawer).toBeVisible({ timeout: 3_000 });
      return drawer;
    } catch {
      // Boot race lost the press — retry once with focus neutralized.
    }
  }
  // Both attempts missed: fail with the standard assertion and full timeout
  // so the report shows the real symptom instead of a bare loop exit.
  await expect(drawer).toBeVisible();
  return drawer;
}

test.describe('Fleet inspector', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('F2 opens the inspector on the Fleet tab', async ({ page }) => {
    const drawer = await openFleetInspector(page);

    await expect(drawer.getByRole('heading', { name: 'Inspector' })).toBeVisible();
    await expect(drawer.getByRole('tab', { name: /^Fleet/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('exposes the Fleet, Agents, Audit, and Council tabs', async ({ page }) => {
    const drawer = await openFleetInspector(page);

    for (const name of ['Fleet', 'Agents', 'Audit', 'Council']) {
      await expect(drawer.getByRole('tab', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
  });

  test('close control dismisses the inspector', async ({ page }) => {
    await openFleetInspector(page);

    await page.getByTestId('inspector-close').click();
    await expect(page.getByTestId('inspector-drawer')).toBeHidden();
  });
});
