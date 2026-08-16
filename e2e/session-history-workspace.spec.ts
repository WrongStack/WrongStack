import { expect, test } from '@playwright/test';

test.describe('session history workspace', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  // FIXME(2026-08-17): rotten spec — times out in CI against current UI (run 31978025696); repair before re-enabling.

  test.fixme('promotes sidebar history into the full History and Live workspace', async ({ page }) => {
    await page.getByRole('button', { name: /^History/ }).click();
    await expect(page.getByRole('searchbox', { name: /Filter title/ })).toBeVisible();

    await page.getByRole('button', { name: 'Open sessions dashboard' }).click();

    const workspace = page.getByTestId('sessions-workspace');
    await expect(workspace).toBeVisible();
    await expect(workspace.getByRole('tab', { name: 'History' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(workspace.locator('[data-history-variant="workspace"]')).toBeVisible();
    await expect(workspace.getByText('Tool calls', { exact: true })).toBeVisible();
    await expect(workspace.getByText('Files changed', { exact: true })).toBeVisible();

    const liveTab = workspace.getByRole('tab', { name: 'Live sessions' });
    await liveTab.click();
    await expect(liveTab).toHaveAttribute('aria-selected', 'true');
  });

  // FIXME(2026-08-17): rotten spec — times out in CI against current UI (run 31978025696); repair before re-enabling.

  test.fixme('keeps the square website geometry across controls', async ({ page }) => {
    await page.getByRole('button', { name: /^History/ }).click();
    await page.getByRole('button', { name: 'Open sessions dashboard' }).click();

    const workspace = page.getByTestId('sessions-workspace');
    await expect(workspace.getByRole('searchbox')).toHaveCSS('border-radius', '0px');
    await expect(workspace.getByRole('tab', { name: 'History' })).toHaveCSS('border-radius', '0px');
    await expect(workspace.getByRole('button', { name: 'All', exact: true })).toHaveCSS(
      'border-radius',
      '0px',
    );
  });
});
