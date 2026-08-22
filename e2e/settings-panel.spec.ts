import { expect, test } from '@playwright/test';

/**
 * Settings panel E2E tests — verify the settings panel opens, tabs navigate,
 * provider/model switching UI is interactive, and preference toggles work.
 *
 * These tests run against the live WebUI server.
 *
 * The panel's tab list is kept in sync with TABS in
 * packages/webui/src/components/SettingsPanel/index.tsx (14 tabs as of
 * 2026-08-22; the old appearance/features tabs became General/Context).
 */

/** The chat input locator — matches textarea or input with message-like attributes. */
const chatInput =
  'textarea[placeholder*="message" i], textarea[placeholder*="input" i], input[placeholder*="message" i], input[placeholder*="input" i], textarea[data-testid="chat-input"]';

/** The setup screen locator — shown when no provider/model is configured. */
const setupScreen = '[data-testid="setup-screen"], [class*="setup"], [class*="Setup"]';

/**
 * Wait for either the chat input or the setup screen to become visible,
 * then return which state the WebUI is in.
 */
async function waitForReadyState(page: import('@playwright/test').Page): Promise<'chat' | 'setup'> {
  const inputLocator = page.locator(chatInput).first();
  const setupLocator = page.locator(setupScreen).first();

  await expect
    .poll(
      async () => {
        const inputVisible = await inputLocator.isVisible().catch(() => false);
        const setupVisible = await setupLocator.isVisible().catch(() => false);
        return inputVisible || setupVisible;
      },
      { timeout: 10_000, message: 'Neither chat input nor setup screen appeared' },
    )
    .toBe(true);

  const inputVisible = await inputLocator.isVisible().catch(() => false);
  return inputVisible ? 'chat' : 'setup';
}

/** Open the settings view from the activity bar and wait for the panel. */
async function openSettings(page: import('@playwright/test').Page): Promise<void> {
  const settingsButton = page
    .locator(
      '[data-testid="settings-button"], button[title*="settings" i], button:has(svg.lucide-settings)',
    )
    .first();
  await settingsButton.click();
  await expect(page.locator('h1, h2, h3').filter({ hasText: /settings/i })).toBeVisible({
    timeout: 5000,
  });
}

test.describe('WebUI Settings Panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('settings panel opens from the activity bar', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    await openSettings(page);
  });

  test('general tab is the default and shows theme controls', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    await openSettings(page);

    // The "General" tab trigger should be visible and active (the panel's
    // default tab — appearance/language/display preferences).
    const generalTab = page.getByRole('tab', { name: /^General$/ });
    await expect(generalTab).toBeVisible({ timeout: 5000 });
    await expect(generalTab).toHaveAttribute('aria-selected', 'true');

    // The General tab content shows the theme section heading.
    await expect(page.getByRole('heading', { name: /theme/i }).first()).toBeVisible({
      timeout: 5000,
    });
  });

  test('provider tab shows provider and model sections', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    await openSettings(page);

    const providerTab = page.getByRole('tab', { name: /^Provider$/ });
    await expect(providerTab).toBeVisible({ timeout: 5000 });
    await providerTab.click();
    await expect(providerTab).toHaveAttribute('aria-selected', 'true');

    // The provider tab lists saved providers under the API-key section and
    // surfaces the "Model" heading (the active model picker).
    await expect(page.getByRole('heading', { name: /API key providers/i })).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByRole('heading', { name: /^Model$/ })).toBeVisible({ timeout: 5000 });
  });

  test('all settings tabs are clickable and switch content', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    await openSettings(page);

    // Click through every tab in the current panel.
    const tabNames = [
      'General',
      'Provider',
      'Connections',
      'Agent',
      'Execution',
      'Fallbacks',
      'Routing',
      'Fleet',
      'Integrations',
      'Chimera',
      'Context',
      'Logs',
      'Security',
      'Display',
    ];
    for (const tabName of tabNames) {
      const tab = page.getByRole('tab', { name: new RegExp(`^${tabName}$`) });
      await tab.click();
      // The tab becomes selected and its content panel renders without
      // crashing (the content area is visible).
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('[role="tabpanel"]').first()).toBeVisible({
        timeout: 5000,
      });
    }
  });

  test('general tab shows theme toggle buttons', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    await openSettings(page);

    // General is the default tab and carries the theme controls
    // (Light / Dark / System).
    const lightBtn = page.getByRole('button', { name: /^Light$/ });
    const darkBtn = page.getByRole('button', { name: /^Dark$/ });
    const systemBtn = page.getByRole('button', { name: /^System$/ });
    await expect(lightBtn).toBeVisible({ timeout: 5000 });
    await expect(darkBtn).toBeVisible({ timeout: 5000 });
    await expect(systemBtn).toBeVisible({ timeout: 5000 });

    // Clicking a theme does not crash the panel.
    await darkBtn.click();
    await expect(darkBtn).toBeVisible();
  });

  test('context tab shows feature flags', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    await openSettings(page);

    // The Context tab owns feature flags (the successor of the old
    // "features" tab), compactor strategy, and per-plugin controls.
    const contextTab = page.getByRole('tab', { name: /^Context$/ });
    await contextTab.click();
    await expect(page.getByRole('heading', { name: /feature flags/i })).toBeVisible({
      timeout: 5000,
    });
  });

  test('close button returns to chat view', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    await openSettings(page);

    // Click the close/back button (X icon or ghost button)
    const closeButton = page.locator('button:has(svg.lucide-x), button[variant="ghost"]').first();
    await closeButton.click();

    // The chat input should be visible again
    await expect(page.locator(chatInput).first()).toBeVisible({ timeout: 5000 });
  });
});
