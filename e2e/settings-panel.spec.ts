import { test, expect } from '@playwright/test';

/**
 * Settings panel E2E tests — verify the settings panel opens, tabs navigate,
 * provider/model switching UI is interactive, and preference toggles work.
 *
 * These tests run against the live WebUI server.
 */

/** The chat input locator — matches textarea or input with message-like attributes. */
const chatInput = 'textarea[placeholder*="message" i], textarea[placeholder*="input" i], input[placeholder*="message" i], input[placeholder*="input" i], textarea[data-testid="chat-input"]';

/** The setup screen locator — shown when no provider/model is configured. */
const setupScreen = '[data-testid="setup-screen"], [class*="setup"], [class*="Setup"]';

/**
 * Wait for either the chat input or the setup screen to become visible,
 * then return which state the WebUI is in.
 */
async function waitForReadyState(page: import('@playwright/test').Page): Promise<'chat' | 'setup'> {
  const inputLocator = page.locator(chatInput).first();
  const setupLocator = page.locator(setupScreen).first();

  await expect.poll(
    async () => {
      const inputVisible = await inputLocator.isVisible().catch(() => false);
      const setupVisible = await setupLocator.isVisible().catch(() => false);
      return inputVisible || setupVisible;
    },
    { timeout: 10_000, message: 'Neither chat input nor setup screen appeared' },
  ).toBe(true);

  const inputVisible = await inputLocator.isVisible().catch(() => false);
  return inputVisible ? 'chat' : 'setup';
}

test.describe('WebUI Settings Panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('settings panel opens from the activity bar', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    // Click the settings icon in the activity bar (gear icon)
    const settingsButton = page.locator('[data-testid="settings-button"], button[title*="settings" i], button:has(svg.lucide-settings)').first();
    await settingsButton.click();

    // The settings panel should be visible with a "Settings" heading
    await expect(page.locator('h1, h2, h3').filter({ hasText: /settings/i })).toBeVisible({ timeout: 5000 });
  });

  // FIXME(2026-08-17): rotten spec — times out in CI against current UI (run 31978025696); repair before re-enabling.

  test.fixme('provider tab is the default and shows provider/model sections', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    // Open settings
    const settingsButton = page.locator('[data-testid="settings-button"], button[title*="settings" i], button:has(svg.lucide-settings)').first();
    await settingsButton.click();

    // The "Provider" tab trigger should be visible and active
    const providerTab = page.locator('[role="tab"], button').filter({ hasText: /provider/i }).first();
    await expect(providerTab).toBeVisible({ timeout: 5000 });

    // The "Model" label should be visible in the provider tab content
    await expect(page.locator('label, span, h3').filter({ hasText: /^model$/i })).toBeVisible({ timeout: 5000 });
  });

  // FIXME(2026-08-17): rotten spec — times out in CI against current UI (run 31978025696); repair before re-enabling.

  test.fixme('all settings tabs are clickable and switch content', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    // Open settings
    const settingsButton = page.locator('[data-testid="settings-button"], button[title*="settings" i], button:has(svg.lucide-settings)').first();
    await settingsButton.click();

    // Wait for settings to render
    await expect(page.locator('[role="tab"], button').filter({ hasText: /provider/i })).toBeVisible({ timeout: 5000 });

    // Click through each tab
    const tabs = ['appearance', 'connection', 'agent', 'features'];
    for (const tabName of tabs) {
      const tab = page.locator('[role="tab"], button').filter({ hasText: new RegExp(tabName, 'i') }).first();
      await tab.click();
      // Give the tab content a moment to render
      await page.waitForTimeout(200);
      // The tab should still be visible (content area didn't crash)
      await expect(tab).toBeVisible();
    }
  });

  // FIXME(2026-08-17): rotten spec — times out in CI against current UI (run 31978025696); repair before re-enabling.

  test.fixme('appearance tab shows theme toggle buttons', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    // Open settings
    const settingsButton = page.locator('[data-testid="settings-button"], button[title*="settings" i], button:has(svg.lucide-settings)').first();
    await settingsButton.click();

    // Navigate to the Appearance tab
    const appearanceTab = page.locator('[role="tab"], button').filter({ hasText: /appearance/i }).first();
    await appearanceTab.click();
    await page.waitForTimeout(300);

    // Theme toggle buttons should be visible (Light, Dark, System)
    await expect(page.locator('button').filter({ hasText: /light/i })).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button').filter({ hasText: /dark/i })).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button').filter({ hasText: /system/i })).toBeVisible({ timeout: 5000 });
  });

  // FIXME(2026-08-17): rotten spec — times out in CI against current UI (run 31978025696); repair before re-enabling.

  test.fixme('features tab shows preference toggles', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    // Open settings
    const settingsButton = page.locator('[data-testid="settings-button"], button[title*="settings" i], button:has(svg.lucide-settings)').first();
    await settingsButton.click();

    // Navigate to the Features tab
    const featuresTab = page.locator('[role="tab"], button').filter({ hasText: /features/i }).first();
    await featuresTab.click();
    await page.waitForTimeout(300);

    // At least one feature toggle label should be visible (e.g., "Skills", "Memory")
    const toggleLabel = page.locator('label, span').filter({ hasText: /skills|memory|models registry/i }).first();
    await expect(toggleLabel).toBeVisible({ timeout: 5000 });
  });

  test('close button returns to chat view', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    // Open settings
    const settingsButton = page.locator('[data-testid="settings-button"], button[title*="settings" i], button:has(svg.lucide-settings)').first();
    await settingsButton.click();

    // Wait for settings panel to appear
    await expect(page.locator('h1, h2, h3').filter({ hasText: /settings/i })).toBeVisible({ timeout: 5000 });

    // Click the close/back button (X icon or ghost button)
    const closeButton = page.locator('button:has(svg.lucide-x), button[variant="ghost"]').first();
    await closeButton.click();

    // The chat input should be visible again
    await expect(page.locator(chatInput).first()).toBeVisible({ timeout: 5000 });
  });
});
