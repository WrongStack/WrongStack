import { expect, type Page, test } from '@playwright/test';

async function openFleetInspector(page: Page) {
  await page.keyboard.press('F2');
  const drawer = page.getByTestId('inspector-drawer');
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
