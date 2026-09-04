import { expect, type Page, test } from '@playwright/test';

import { enableKeyboardShortcuts } from './helpers/keyboard-shortcuts';

async function openQueuePanel(page: Page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press('F7');
  const dialog = page.getByRole('dialog', { name: 'Message Queue' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Queue panel', () => {
  test.beforeEach(async ({ page }) => {
    await enableKeyboardShortcuts(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('F7 opens the real queue dialog with its empty state', async ({ page }) => {
    const dialog = await openQueuePanel(page);

    await expect(dialog).toContainText('Message Queue');
    await expect(dialog.getByText('Queue is empty')).toBeVisible();
    await expect(dialog.getByTestId('queue-sort-toggle')).toContainText('Oldest');
  });

  test('sort control changes the queue ordering preference', async ({ page }) => {
    const dialog = await openQueuePanel(page);
    const sortToggle = dialog.getByTestId('queue-sort-toggle');

    await sortToggle.click();
    await expect(sortToggle).toContainText('Newest');
  });

  test('Escape dismisses the dialog', async ({ page }) => {
    await openQueuePanel(page);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Message Queue' })).toBeHidden();
  });
});
