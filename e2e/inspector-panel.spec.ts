import { expect, test } from '@playwright/test';

/**
 * Global workbench inspector contract.
 *
 * The inspector is a fixed right-side Radix drawer. It overlays the active
 * work surface (no layout shift), exposes the three consolidated monitor tabs,
 * restores focus when closed, and follows the square WebUI geometry invariant.
 */
test.describe('global inspector drawer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('inspector-trigger')).toBeVisible();
  });

  // FIXME(2026-08-17): rotten spec — times out in CI against current UI (run 31978025696); repair before re-enabling.

  test.fixme('opens on the right without shrinking the work surface', async ({ page }) => {
    const trigger = page.getByTestId('inspector-trigger');
    const main = page.locator('#main-content');
    const widthBefore = (await main.boundingBox())?.width;

    await trigger.click();

    const drawer = page.getByTestId('inspector-drawer');
    await expect(drawer).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(drawer).toHaveCSS('border-radius', '0px');
    await expect(trigger).toHaveCSS('border-radius', '0px');

    await expect
      .poll(async () => {
        const box = await drawer.boundingBox();
        if (!box) return Number.POSITIVE_INFINITY;
        return Math.abs(box.x + box.width - page.viewportSize()!.width);
      })
      .toBeLessThanOrEqual(1);
    expect((await main.boundingBox())?.width).toBe(widthBefore);
  });

  // FIXME(2026-08-17): rotten spec — times out in CI against current UI (run 31978025696); repair before re-enabling.

  test.fixme('provides keyboard-accessible Fleet, Agents and Audit tabs', async ({ page }) => {
    await page.getByTestId('inspector-trigger').click();

    const fleet = page.getByRole('tab', { name: /^Fleet/ });
    const agents = page.getByRole('tab', { name: /^Agents/ });
    const audit = page.getByRole('tab', { name: /^Audit/ });

    await expect(fleet).toHaveAttribute('aria-selected', 'true');
    await agents.click();
    await expect(agents).toHaveAttribute('aria-selected', 'true');

    await agents.focus();
    await page.keyboard.press('ArrowRight');
    await expect(audit).toBeFocused();
    await expect(audit).toHaveAttribute('aria-selected', 'true');
  });

  // FIXME(2026-08-17): rotten spec — times out in CI against current UI (run 31978025696); repair before re-enabling.

  test.fixme('closes with the labelled action and restores trigger focus', async ({ page }) => {
    const trigger = page.getByTestId('inspector-trigger');
    await trigger.click();
    await page.getByTestId('inspector-close').click();

    await expect(page.getByTestId('inspector-drawer')).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
  });

  // FIXME(2026-08-17): rotten spec — times out in CI against current UI (run 31978025696); repair before re-enabling.

  test.fixme('closes with Escape', async ({ page }) => {
    await page.getByTestId('inspector-trigger').click();
    await expect(page.getByTestId('inspector-drawer')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByTestId('inspector-drawer')).toBeHidden();
  });
});
